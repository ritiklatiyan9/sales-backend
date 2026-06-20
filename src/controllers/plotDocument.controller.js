import crypto from 'crypto';
import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { uploadKycDocument, getKycDocumentUrl, deleteKycDocument } from '../utils/s3.js';

/**
 * Plot Documents (booking side) — a plot-centric view of the SHARED `documents` table.
 *
 * Identical data model to the accounting app's plot-documents feature (see migration 059 in
 * pern-based-backend). Both apps read/write the same `documents` rows + the same S3 bucket, so
 * a doc uploaded here appears in the accounting Plot Documents page and vice versa. A plot's
 * documents = rows attached directly (documents.plot_id) OR via kyc_cases → bookings.plot_id.
 */

const VALID_CATEGORIES = new Set([
  'AGREEMENT', 'MAP', 'REGISTRY', 'ALLOTMENT', 'NOC', 'RECEIPT', 'ID_PROOF', 'OTHER',
]);

/** GET /plot-documents?site_id=  → plots for a site with a per-plot document count. */
export const listPlotsWithDocs = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const { rows } = await pool.query(
    `SELECT p.id, p.plot_no, p.block, p.status, p.buyer_name, p.plot_size,
            p.booking_by, p.booking_date, p.team, p.plot_tag, p.sale_price,
            (
              SELECT COUNT(*) FROM documents d
                LEFT JOIN kyc_cases k ON k.id = d.kyc_case_id
                LEFT JOIN bookings b ON b.id = k.booking_id
              WHERE d.plot_id = p.id OR b.plot_id = p.id
            )::int AS doc_count
       FROM plots p
      WHERE p.site_id = $1
      ORDER BY p.block ASC NULLS LAST, p.plot_no ASC`,
    [site_id]
  );
  res.json({ plots: rows });
});

/** GET /plot-documents/:plotId  → plot meta + its documents (each with a fresh signed URL). */
export const getPlotDocuments = asyncHandler(async (req, res) => {
  const { plotId } = req.params;

  const { rows: plotRows } = await pool.query(
    `SELECT id, plot_no, block, status, buyer_name, plot_size, plot_size_mtr,
            booking_by, booking_date, sale_price, plot_rate, team, plot_tag, site_id
       FROM plots WHERE id = $1`,
    [plotId]
  );
  const plot = plotRows[0];
  if (!plot) return res.status(404).json({ message: 'Plot not found' });

  const { rows: docs } = await pool.query(
    `SELECT d.id, d.type, d.category, d.title, d.original_name, d.file_path,
            d.mime_type, d.file_size, d.uploaded_source, d.ocr_status, d.created_at,
            d.kyc_case_id, b.id AS booking_id, b.booking_no,
            COALESCE(u.name, u.email) AS uploaded_by_name
       FROM documents d
       LEFT JOIN kyc_cases k ON k.id = d.kyc_case_id
       LEFT JOIN bookings  b ON b.id = k.booking_id
       LEFT JOIN users     u ON u.id = d.uploaded_by
      WHERE d.plot_id = $1 OR b.plot_id = $1
      ORDER BY d.created_at DESC, d.id DESC`,
    [plotId]
  );

  for (const d of docs) {
    try { d.file_url = await getKycDocumentUrl(d.file_path); } catch { d.file_url = null; }
  }

  res.json({ plot, documents: docs });
});

/**
 * POST /plot-documents/:plotId  (multipart: file=<binary>, category, title)
 * Stores the file in the shared S3 bucket + inserts a `documents` row linked to the plot. If the
 * plot has a (non-cancelled) booking the doc is ALSO attached to that booking's KYC case so it
 * shows on /bookings/:id here, and on the accounting Plot Documents page.
 */
export const uploadPlotDocument = asyncHandler(async (req, res) => {
  const { plotId } = req.params;
  if (!req.file) return res.status(400).json({ message: 'No file uploaded (field name: file)' });

  const { rows: plotRows } = await pool.query('SELECT id, site_id FROM plots WHERE id = $1', [plotId]);
  const plot = plotRows[0];
  if (!plot) return res.status(404).json({ message: 'Plot not found' });

  const rawCat = String(req.body.category || 'OTHER').toUpperCase();
  const category = VALID_CATEGORIES.has(rawCat) ? rawCat : 'OTHER';
  const title = req.body.title ? String(req.body.title).trim() : null;

  let kycCaseId = null;
  let clientMemberId = null;
  const { rows: bookingRows } = await pool.query(
    `SELECT id, client_member_id, site_id FROM bookings
      WHERE plot_id = $1 AND status <> 'CANCELLED'
      ORDER BY id DESC LIMIT 1`,
    [plotId]
  );
  const booking = bookingRows[0];
  if (booking) {
    clientMemberId = booking.client_member_id || null;
    const existing = await pool.query(
      'SELECT id FROM kyc_cases WHERE booking_id = $1 ORDER BY id DESC LIMIT 1',
      [booking.id]
    );
    if (existing.rows[0]) {
      kycCaseId = existing.rows[0].id;
    } else {
      const created = await pool.query(
        `INSERT INTO kyc_cases (booking_id, client_member_id, site_id, mode, status)
         VALUES ($1, $2, $3, 'MANUAL_OCR', 'OPEN') RETURNING id`,
        [booking.id, booking.client_member_id || null, booking.site_id || plot.site_id]
      );
      kycCaseId = created.rows[0].id;
    }
  }

  const fileHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
  const storageKey = await uploadKycDocument(req.file.buffer, req.file.originalname, req.file.mimetype);

  const { rows } = await pool.query(
    `INSERT INTO documents
       (kyc_case_id, plot_id, client_member_id, site_id, type, category, title,
        original_name, file_path, file_hash, mime_type, file_size,
        ocr_status, ocr_engine, ocr_completed_at, uploaded_source, uploaded_by)
     VALUES ($1, $2, $3, $4, 'OTHER', $5, $6, $7, $8, $9, $10, $11, 'DONE', 'none', now(), 'BOOKING', $12)
     RETURNING id, type, category, title, original_name, file_path, mime_type, file_size,
               uploaded_source, ocr_status, created_at, kyc_case_id`,
    [
      kycCaseId, plotId, clientMemberId, plot.site_id, category, title,
      req.file.originalname, storageKey, fileHash, req.file.mimetype, req.file.size,
      req.user?.id || null,
    ]
  );

  const doc = rows[0];
  try { doc.file_url = await getKycDocumentUrl(doc.file_path); } catch { doc.file_url = null; }
  res.status(201).json(doc);
});

/** DELETE /plot-documents/doc/:docId  → remove the file + DB row (cascades ocr_results). */
export const deletePlotDocument = asyncHandler(async (req, res) => {
  const { docId } = req.params;
  const { rows } = await pool.query('SELECT id, file_path FROM documents WHERE id = $1', [docId]);
  const doc = rows[0];
  if (!doc) return res.status(404).json({ message: 'Document not found' });

  try { await deleteKycDocument(doc.file_path); } catch { /* best-effort file cleanup */ }
  await pool.query('DELETE FROM documents WHERE id = $1', [docId]);

  res.json({ message: 'Document deleted', documentId: Number(docId) });
});
