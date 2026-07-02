import crypto from 'crypto';
import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { uploadKycDocument, getKycDocumentUrl, getPublicKycUrl, deleteKycDocument } from '../utils/s3.js';
import { enqueueOcr } from '../queue/ocrQueue.js';
import { emitOcrUpdate } from '../config/socket.js';
import documentModel from '../models/Document.model.js';
import kycCaseModel from '../models/KycCase.model.js';
import bookingModel from '../models/Booking.model.js';
import { extractKycFieldsWithAi } from '../services/groq.service.js';

// Maps a booking document type → the accounting `members` document column, so an
// uploaded doc shows up on the accounting client page (/clients/:id).
const TYPE_TO_MEMBER_COL = {
  AADHAAR: 'aadhar_front_url',
  PAN: 'pan_card_url',
  PHOTO: 'photo',
  VOTER_ID: 'voter_id_url',
  PASSPORT: 'passport_url',
  DL: 'driving_license_url',
  CHEQUE: 'cheque_url',
  OTHER: 'other_kyc_url',
};

/** Write the uploaded doc's public URL onto the linked client member's KYC column. */
const linkDocToMember = async (type, storageKey, memberId) => {
  const col = TYPE_TO_MEMBER_COL[type];
  if (!col || !memberId) return null;
  const url = getPublicKycUrl(storageKey);
  if (!url) return null;
  await pool.query(`UPDATE members SET ${col} = $1, updated_at = now() WHERE id = $2`, [url, memberId]);
  return { col, url };
};

/** Resolve a kyc_case from either kyc_case_id or booking_id (creating one if needed). */
const resolveCase = async (body) => {
  if (body.kyc_case_id) {
    const { rows } = await pool.query('SELECT * FROM kyc_cases WHERE id = $1', [body.kyc_case_id]);
    return rows[0];
  }
  if (body.booking_id) {
    const booking = await bookingModel.findById(body.booking_id, pool);
    if (!booking) return null;
    return kycCaseModel.getOrCreateForBooking(booking, pool);
  }
  return null;
};

/**
 * POST /kyc/upload  (multipart: file=<binary>, booking_id|kyc_case_id, type)
 * Stores the file, inserts a PENDING document row, enqueues an async OCR job, and
 * returns immediately so the UI never blocks.
 */
export const uploadDocument = asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No file uploaded (field name: file)' });

  const kycCase = await resolveCase(req.body);
  if (!kycCase) return res.status(400).json({ message: 'Provide a valid booking_id or kyc_case_id' });

  const type = (req.body.type || 'OTHER').toUpperCase();
  const fileHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
  const storageKey = await uploadKycDocument(req.file.buffer, req.file.originalname, req.file.mimetype);

  // Photos and the final signed booking form don't need OCR — they're archive files.
  const skipOcr = type === 'PHOTO' || type === 'FINAL_APPROVED_BOOKED_FORM';

  const doc = await documentModel.create({
    kyc_case_id: kycCase.id,
    client_member_id: kycCase.client_member_id,
    site_id: kycCase.site_id,
    type,
    file_path: storageKey,
    file_hash: fileHash,
    mime_type: req.file.mimetype,
    file_size: req.file.size,
    ocr_status: skipOcr ? 'DONE' : 'PENDING',
    ocr_engine: skipOcr ? 'none' : null,
    ocr_completed_at: skipOcr ? new Date() : null,
  }, pool);

  let jobId = null;
  if (skipOcr) {
    emitOcrUpdate({ bookingId: kycCase.booking_id, documentId: doc.id, status: 'DONE' });
  } else {
    // In-process queue returns instantly with a synthetic job id (no broker). The raw
    // bytes are handed straight to the processor so OCR starts without re-downloading
    // the file from storage.
    jobId = await enqueueOcr(doc.id, { buffer: req.file.buffer, mimeType: req.file.mimetype });
    emitOcrUpdate({ bookingId: kycCase.booking_id, documentId: doc.id, status: 'PENDING' });
  }

  // Respond the moment the file is stored + row created — the UI no longer waits on
  // status roll-ups, job-id persistence, or the accounting mirror.
  res.status(201).json({ documentId: doc.id, jobId, ocr_status: skipOcr ? 'DONE' : 'PENDING', type });

  // Fire-and-forget bookkeeping — never blocks the HTTP response.
  (async () => {
    try {
      if (!skipOcr) {
        await pool.query('UPDATE documents SET ocr_job_id = $1 WHERE id = $2', [jobId, doc.id]);
        await pool.query(`UPDATE kyc_cases SET status = 'OCR_PENDING', updated_at = now() WHERE id = $1 AND status <> 'VERIFIED'`, [kycCase.id]);
        await pool.query(`UPDATE bookings SET kyc_status = 'OCR_PENDING', updated_at = now() WHERE id = $1 AND kyc_status <> 'VERIFIED'`, [kycCase.booking_id]);
      }
      // Mirror the document onto the accounting client record (shows on /clients/:id).
      await linkDocToMember(type, storageKey, kycCase.client_member_id);
    } catch (err) {
      console.error('[kyc upload] post-processing failed:', err.message);
    }
  })();
});

/** GET /kyc/document/:id — current OCR status + latest extracted fields. */
export const getDocument = asyncHandler(async (req, res) => {
  const doc = await documentModel.getWithLatestResult(req.params.id, pool);
  if (!doc) return res.status(404).json({ message: 'Document not found' });
  doc.file_url = await getKycDocumentUrl(doc.file_path);
  res.json(doc);
});

/** DELETE /kyc/document/:id — remove a document and clear its linked member column. */
export const deleteDocument = asyncHandler(async (req, res) => {
  const doc = await documentModel.findById(req.params.id, pool);
  if (!doc) return res.status(404).json({ message: 'Document not found' });

  // Delete the file from S3 or disk.
  try {
    await deleteKycDocument(doc.file_path);
  } catch {
    // Best-effort file cleanup; don't fail the delete if the file is already gone.
  }

  // Clear the linked member column if this document was linked.
  const col = TYPE_TO_MEMBER_COL[doc.type];
  if (col && doc.client_member_id) {
    await pool.query(`UPDATE members SET ${col} = NULL, updated_at = now() WHERE id = $1`, [doc.client_member_id]);
  }

  // Delete the document record and its OCR results (cascade).
  await pool.query('DELETE FROM documents WHERE id = $1', [req.params.id]);

  const bookingId = await documentModel.getBookingId(doc.id, pool);
  if (bookingId) emitOcrUpdate({ bookingId, documentId: doc.id, status: 'DELETED' });

  res.json({ message: 'Document deleted', documentId: req.params.id });
});

/**
 * PATCH /kyc/document/:id/fields — human correction of the AI-extracted fields.
 * Body: { fields: { key: value, … } } — treated as the authoritative full set for the
 * document (cleared keys are removed). Edited/added values are marked human-verified
 * (confidence 1.0); untouched values keep their AI confidence.
 */
export const updateDocumentFields = asyncHandler(async (req, res) => {
  const doc = await documentModel.findById(req.params.id, pool);
  if (!doc) return res.status(404).json({ message: 'Document not found' });
  const input = req.body?.fields;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return res.status(400).json({ message: 'Provide a fields object' });
  }

  // Sanitise: string keys/values only, drop empties, cap lengths.
  const fields = {};
  for (const [k, v] of Object.entries(input)) {
    const key = String(k).trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 64);
    const val = v === null || v === undefined ? '' : String(v).trim().slice(0, 500);
    if (key && val) fields[key] = val;
  }

  const { rows } = await pool.query(
    'SELECT * FROM ocr_results WHERE document_id = $1 ORDER BY id DESC LIMIT 1',
    [doc.id]
  );
  const latest = rows[0];
  const prevFields = latest?.extracted_fields || {};
  const prevConf = latest?.confidence_map || {};

  // Human-verified values get confidence 1.0; unchanged ones keep their AI score.
  const confidenceMap = {};
  for (const k of Object.keys(fields)) {
    confidenceMap[k] = fields[k] === String(prevFields[k] ?? '') ? (prevConf[k] ?? 1) : 1;
  }
  const values = Object.values(confidenceMap);
  const overall = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;

  if (latest) {
    await pool.query(
      `UPDATE ocr_results SET extracted_fields = $1, confidence_map = $2, confidence_overall = $3 WHERE id = $4`,
      [JSON.stringify(fields), JSON.stringify(confidenceMap), Math.round(overall * 1000) / 1000, latest.id]
    );
  } else {
    await pool.query(
      `INSERT INTO ocr_results (document_id, raw_text, extracted_fields, confidence_overall, confidence_map, engine, processed_at)
       VALUES ($1, $2, $3, $4, $5, 'manual', now())`,
      [doc.id, JSON.stringify({ text: '' }), JSON.stringify(fields), Math.round(overall * 1000) / 1000, JSON.stringify(confidenceMap)]
    );
    // A manually-filled document counts as processed.
    await pool.query(
      `UPDATE documents SET ocr_status = 'DONE', ocr_engine = COALESCE(ocr_engine, 'manual'), ocr_completed_at = COALESCE(ocr_completed_at, now()), updated_at = now() WHERE id = $1`,
      [doc.id]
    );
  }

  const bookingId = await documentModel.getBookingId(doc.id, pool);
  if (bookingId) emitOcrUpdate({ bookingId, documentId: doc.id, status: 'DONE', stage: 'DONE' });
  res.json({ documentId: doc.id, fields, confidence_map: confidenceMap, confidence_overall: overall });
});

/** GET /kyc/case/:id — case + its documents (each with latest OCR result). */
export const getCase = asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM kyc_cases WHERE id = $1', [req.params.id]);
  const kycCase = rows[0];
  if (!kycCase) return res.status(404).json({ message: 'KYC case not found' });
  const documents = await kycCaseModel.getDocumentsWithResults(kycCase.id, pool);
  for (const d of documents) d.file_url = await getKycDocumentUrl(d.file_path);
  res.json({ ...kycCase, documents });
});

/** POST /kyc/document/:id/retry — reset to PENDING and re-enqueue OCR. */
export const retryDocument = asyncHandler(async (req, res) => {
  const doc = await documentModel.findById(req.params.id, pool);
  if (!doc) return res.status(404).json({ message: 'Document not found' });

  await pool.query(
    `UPDATE documents SET ocr_status = 'PENDING', ocr_error = NULL, ocr_started_at = NULL, ocr_completed_at = NULL WHERE id = $1`,
    [doc.id]
  );
  const jobId = await enqueueOcr(doc.id);
  await pool.query('UPDATE documents SET ocr_job_id = $1 WHERE id = $2', [jobId, doc.id]);

  const bookingId = await documentModel.getBookingId(doc.id, pool);
  emitOcrUpdate({ bookingId, documentId: doc.id, status: 'PENDING' });
  res.json({ documentId: doc.id, jobId, ocr_status: 'PENDING' });
});

/** POST /kyc/case/:id/extract-preview — AI-powered preview of extracted fields.
 * Calls Groq on the raw OCR text of all documents to get intelligent extraction. */
export const extractPreview = asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM kyc_cases WHERE id = $1', [req.params.id]);
  const kycCase = rows[0];
  if (!kycCase) return res.status(404).json({ message: 'KYC case not found' });

  // Get all documents with their raw OCR text
  const { rows: documents } = await pool.query(
    `SELECT d.id, d.type, r.raw_text
     FROM documents d
     LEFT JOIN ocr_results r ON d.id = r.document_id
     WHERE d.kyc_case_id = $1 AND d.ocr_status = 'DONE'`,
    [kycCase.id]
  );

  if (!documents.length) {
    return res.status(400).json({ message: 'No completed documents to extract from' });
  }

  // Run all per-document extractions in parallel — the response is bounded by the
  // slowest document instead of the sum of all of them.
  const results = await Promise.all(
    documents.map(async (doc) => {
      if (!doc.raw_text?.text) return {};
      try {
        return await extractKycFieldsWithAi(doc.raw_text.text, doc.type);
      } catch (err) {
        console.error(`[preview] Groq extraction failed for doc ${doc.id}:`, err.message);
        return {};
      }
    })
  );
  const extracted = Object.assign({}, ...results);

  res.json({
    caseId: kycCase.id,
    extracted: extracted || {},
    docCount: documents.length,
  });
});

/**
 * POST /kyc/case/:id/verify
 * Staff confirms the extracted fields. Optionally writes confirmed values back into the
 * linked member's KYC columns (member_update), then marks the case VERIFIED and rolls up
 * the booking. Member write-back is OPT-IN and only touches the specific client member.
 */
export const verifyCase = asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM kyc_cases WHERE id = $1', [req.params.id]);
  const kycCase = rows[0];
  if (!kycCase) return res.status(404).json({ message: 'KYC case not found' });

  const { member_update } = req.body || {};
  if (member_update && kycCase.client_member_id) {
    const allowed = ['full_name', 'father_name', 'date_of_birth', 'address', 'city', 'state', 'pincode', 'aadhar_no', 'pan_no'];
    const data = {};
    for (const k of allowed) if (member_update[k] !== undefined && member_update[k] !== null && member_update[k] !== '') data[k] = member_update[k];
    if (Object.keys(data).length) {
      const setClause = Object.keys(data).map((k, i) => `${k} = $${i + 1}`).join(', ');
      const values = [...Object.values(data), kycCase.client_member_id];
      await pool.query(`UPDATE members SET ${setClause}, updated_at = now() WHERE id = $${values.length}`, values);
    }
  }

  await pool.query(
    `UPDATE kyc_cases SET status = 'VERIFIED', verified_by = $1, verified_at = now(), updated_at = now() WHERE id = $2`,
    [req.user?.id || null, kycCase.id]
  );
  await pool.query(
    `UPDATE bookings SET kyc_status = 'VERIFIED', status = CASE WHEN status = 'KYC_PENDING' THEN 'KYC_DONE' ELSE status END, updated_at = now() WHERE id = $1`,
    [kycCase.booking_id]
  );

  emitOcrUpdate({ bookingId: kycCase.booking_id, caseId: kycCase.id, status: 'VERIFIED' });
  res.json({ message: 'KYC verified', caseId: kycCase.id });
});
