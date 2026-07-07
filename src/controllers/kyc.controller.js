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
import { getVisibleUserIds, isAdminRole } from '../services/agentNetwork.service.js';
import { hasPermission } from '../services/permissions.service.js';
import { findOrCreateClientByPhone } from '../services/memberQuickAdd.service.js';

// Both KYC sidebar modules ('New KYC' / 'All KYCs') manage the same underlying
// resource — Access Control's Update/Delete toggles on the "All KYCs" row are the
// single source of truth agents' edit/delete buttons respect.
const KYC_MODULE = 'booking_kyc_all';

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

/**
 * Case-level access: admins see everything; agents/team heads see cases they (or their
 * network) opened, plus cases on bookings their network owns/created.
 */
const canAccessCase = async (user, kycCase) => {
  const visible = await getVisibleUserIds(user); // null = unrestricted
  if (!visible) return true;
  if (kycCase.created_by && visible.includes(kycCase.created_by)) return true;
  if (kycCase.booking_id) {
    const { rows } = await pool.query(
      'SELECT agent_user_id, created_by FROM bookings WHERE id = $1',
      [kycCase.booking_id]
    );
    const b = rows[0];
    if (b && (visible.includes(b.agent_user_id) || visible.includes(b.created_by))) return true;
  }
  return false;
};

/** Document-level access = access to its parent case. Returns the doc or null (denied). */
const findAccessibleDocument = async (user, documentId) => {
  const doc = await documentModel.findById(documentId, pool);
  if (!doc) return { doc: null, denied: false };
  const { rows } = await pool.query('SELECT * FROM kyc_cases WHERE id = $1', [doc.kyc_case_id]);
  const kycCase = rows[0];
  if (kycCase && !(await canAccessCase(user, kycCase))) return { doc: null, denied: true };
  return { doc, denied: false };
};

/**
 * POST /kyc/cases  — start a KYC for a customer BEFORE any booking exists.
 * Body: { site_id, phone } (agent quick-add — just the number) or { site_id, client_member_id }.
 * Finds/creates the CLIENT member by phone, records the referring agent on the member
 * (first non-admin to add the number claims the referral), and opens/reuses a
 * member-anchored kyc_case (booking_id NULL). Admins later create the booking and the
 * case + referral attach automatically.
 */
export const createCase = asyncHandler(async (req, res) => {
  const { site_id, phone, full_name, client_member_id } = req.body || {};
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const isAdmin = isAdminRole(req.user?.role);
  const visibleUserIds = await getVisibleUserIds(req.user);
  let member = null;
  let kycCase = null;

  if (client_member_id) {
    const { rows } = await pool.query(
      `SELECT * FROM members WHERE id = $1 AND member_type = 'CLIENT'`,
      [client_member_id]
    );
    member = rows[0];
    if (!member) return res.status(404).json({ message: 'Client not found' });
    // Same claim rule as the phone path: the first agent to run this customer's KYC
    // becomes their referrer (never overwrites an existing claim).
    if (!member.referred_by_user_id && !isAdmin) {
      await pool.query(
        `UPDATE members SET referred_by_user_id = $1, updated_at = now()
          WHERE id = $2 AND referred_by_user_id IS NULL`,
        [req.user.id, member.id]
      );
    }
    kycCase = await kycCaseModel.getOrCreateForMember({
      memberId: member.id,
      siteId: member.site_id || site_id,
      createdBy: req.user?.id || null,
      visibleUserIds,
    }, pool);
  } else {
    // Find-or-create by phone is shared with the Draw Registration flow — atomicity
    // (advisory xact lock) and the referral-claim rule live in the helper.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      member = await findOrCreateClientByPhone(
        { siteId: site_id, phone, fullName: full_name, user: req.user },
        client
      );

      kycCase = await kycCaseModel.getOrCreateForMember({
        memberId: member.id,
        siteId: site_id,
        createdBy: req.user?.id || null,
        visibleUserIds,
      }, client);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  res.status(201).json({
    ...kycCase,
    client_name: member.full_name,
    client_phone: member.phone,
  });
});

/**
 * GET /kyc/cases?site_id=&status=&pending=1&q=
 * Role-scoped list: admins see every case; agents see their own network's cases
 * (same visibility idiom as bookings). `pending=1` → not yet VERIFIED/REJECTED.
 */
export const listCases = asyncHandler(async (req, res) => {
  const { site_id, status, pending, q } = req.query;
  const visibleUserIds = await getVisibleUserIds(req.user);
  const rows = await kycCaseModel.list(
    { siteId: site_id, status, pending: pending === '1' || pending === 'true', q, visibleUserIds },
    pool
  );
  res.json(rows);
});

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
  if (!(await canAccessCase(req.user, kycCase))) {
    return res.status(403).json({ message: 'You are not authorised to upload to this KYC case' });
  }

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
    emitOcrUpdate({ bookingId: kycCase.booking_id, caseId: kycCase.id, documentId: doc.id, status: 'DONE' });
  } else {
    // In-process queue returns instantly with a synthetic job id (no broker). The raw
    // bytes are handed straight to the processor so OCR starts without re-downloading
    // the file from storage.
    jobId = await enqueueOcr(doc.id, { buffer: req.file.buffer, mimeType: req.file.mimetype });
    emitOcrUpdate({ bookingId: kycCase.booking_id, caseId: kycCase.id, documentId: doc.id, status: 'PENDING' });
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
        if (kycCase.booking_id) {
          await pool.query(`UPDATE bookings SET kyc_status = 'OCR_PENDING', updated_at = now() WHERE id = $1 AND kyc_status <> 'VERIFIED'`, [kycCase.booking_id]);
        }
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
  const { doc: allowed, denied } = await findAccessibleDocument(req.user, req.params.id);
  if (denied) return res.status(403).json({ message: 'You are not authorised to view this document' });
  if (!allowed) return res.status(404).json({ message: 'Document not found' });
  const doc = await documentModel.getWithLatestResult(req.params.id, pool);
  doc.file_url = await getKycDocumentUrl(doc.file_path);
  res.json(doc);
});

/** DELETE /kyc/document/:id — remove a document and clear its linked member column. */
export const deleteDocument = asyncHandler(async (req, res) => {
  const { doc, denied } = await findAccessibleDocument(req.user, req.params.id);
  if (denied) return res.status(403).json({ message: 'You are not authorised to modify this document' });
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

  // Capture room targets BEFORE the row (and its case linkage) is deleted.
  const { caseId, bookingId } = await documentModel.getCaseAndBookingId(doc.id, pool);

  // Delete the document record and its OCR results (cascade).
  await pool.query('DELETE FROM documents WHERE id = $1', [req.params.id]);

  emitOcrUpdate({ bookingId, caseId, documentId: doc.id, status: 'DELETED' });

  res.json({ message: 'Document deleted', documentId: req.params.id });
});

/**
 * PATCH /kyc/document/:id/fields — human correction of the AI-extracted fields.
 * Body: { fields: { key: value, … } } — treated as the authoritative full set for the
 * document (cleared keys are removed). Edited/added values are marked human-verified
 * (confidence 1.0); untouched values keep their AI confidence.
 */
export const updateDocumentFields = asyncHandler(async (req, res) => {
  const { doc, denied } = await findAccessibleDocument(req.user, req.params.id);
  if (denied) return res.status(403).json({ message: 'You are not authorised to modify this document' });
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

  const { caseId, bookingId } = await documentModel.getCaseAndBookingId(doc.id, pool);
  emitOcrUpdate({ bookingId, caseId, documentId: doc.id, status: 'DONE', stage: 'DONE' });
  res.json({ documentId: doc.id, fields, confidence_map: confidenceMap, confidence_overall: overall });
});

/** GET /kyc/case/:id — case + member/booking labels + documents (with latest OCR result). */
export const getCase = asyncHandler(async (req, res) => {
  const kycCase = await kycCaseModel.getDetail(req.params.id, pool);
  if (!kycCase) return res.status(404).json({ message: 'KYC case not found' });
  if (!(await canAccessCase(req.user, kycCase))) {
    return res.status(403).json({ message: 'You are not authorised to view this KYC case' });
  }
  const documents = await kycCaseModel.getDocumentsWithResults(kycCase.id, pool);
  for (const d of documents) d.file_url = await getKycDocumentUrl(d.file_path);
  res.json({ ...kycCase, documents });
});

/**
 * PATCH /kyc/case/:id/customer — edit the customer's name/phone captured at quick-add.
 * Body: { full_name, phone }. Gated by case access AND the "All KYCs" Update
 * permission (Access Control) — turning that off for an agent hides/blocks this.
 */
export const updateCaseCustomer = asyncHandler(async (req, res) => {
  const kycCase = await kycCaseModel.getDetail(req.params.id, pool);
  if (!kycCase) return res.status(404).json({ message: 'KYC case not found' });
  if (!(await canAccessCase(req.user, kycCase))) {
    return res.status(403).json({ message: 'You are not authorised to edit this KYC case' });
  }
  if (!(await hasPermission(req.user, KYC_MODULE, 'can_update'))) {
    return res.status(403).json({ message: 'You do not have permission to edit KYC customers' });
  }
  if (!kycCase.client_member_id) {
    return res.status(400).json({ message: 'This case has no linked customer to edit' });
  }

  const full_name = String(req.body?.full_name || '').trim();
  const phone = String(req.body?.phone || '').trim();
  if (!full_name) return res.status(400).json({ message: 'Name is required' });

  const { rows } = await pool.query(
    `UPDATE members SET full_name = $1, phone = $2, updated_at = now() WHERE id = $3 RETURNING id, full_name, phone`,
    [full_name, phone || null, kycCase.client_member_id]
  );
  res.json({ caseId: kycCase.id, client_name: rows[0].full_name, client_phone: rows[0].phone });
});

/**
 * DELETE /kyc/case/:id — remove a KYC case that isn't tied to a booking (booking-tied
 * KYC belongs to the booking's lifecycle — delete/cancel the booking instead). Cleans
 * up each document's stored file before the row (and its documents/ocr_results, via
 * cascade) is deleted. Gated by case access AND the "All KYCs" Delete permission.
 */
export const deleteCase = asyncHandler(async (req, res) => {
  const kycCase = await kycCaseModel.getDetail(req.params.id, pool);
  if (!kycCase) return res.status(404).json({ message: 'KYC case not found' });
  if (!(await canAccessCase(req.user, kycCase))) {
    return res.status(403).json({ message: 'You are not authorised to delete this KYC case' });
  }
  if (!(await hasPermission(req.user, KYC_MODULE, 'can_delete'))) {
    return res.status(403).json({ message: 'You do not have permission to delete KYC cases' });
  }
  if (kycCase.booking_id) {
    return res.status(400).json({ message: 'This KYC is linked to a booking — remove it from the booking first' });
  }

  const { rows: docs } = await pool.query('SELECT file_path FROM documents WHERE kyc_case_id = $1', [kycCase.id]);
  for (const d of docs) {
    try { await deleteKycDocument(d.file_path); } catch { /* best-effort file cleanup */ }
  }

  await pool.query('DELETE FROM kyc_cases WHERE id = $1', [kycCase.id]);
  res.json({ message: 'KYC case deleted', id: kycCase.id, removedDocuments: docs.length });
});

/** POST /kyc/document/:id/retry — reset to PENDING and re-enqueue OCR. */
export const retryDocument = asyncHandler(async (req, res) => {
  const { doc, denied } = await findAccessibleDocument(req.user, req.params.id);
  if (denied) return res.status(403).json({ message: 'You are not authorised to modify this document' });
  if (!doc) return res.status(404).json({ message: 'Document not found' });

  await pool.query(
    `UPDATE documents SET ocr_status = 'PENDING', ocr_error = NULL, ocr_started_at = NULL, ocr_completed_at = NULL WHERE id = $1`,
    [doc.id]
  );
  const jobId = await enqueueOcr(doc.id);
  await pool.query('UPDATE documents SET ocr_job_id = $1 WHERE id = $2', [jobId, doc.id]);

  const { caseId, bookingId } = await documentModel.getCaseAndBookingId(doc.id, pool);
  emitOcrUpdate({ bookingId, caseId, documentId: doc.id, status: 'PENDING' });
  res.json({ documentId: doc.id, jobId, ocr_status: 'PENDING' });
});

/** POST /kyc/case/:id/extract-preview — AI-powered preview of extracted fields.
 * Calls Groq on the raw OCR text of all documents to get intelligent extraction. */
export const extractPreview = asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM kyc_cases WHERE id = $1', [req.params.id]);
  const kycCase = rows[0];
  if (!kycCase) return res.status(404).json({ message: 'KYC case not found' });
  if (!(await canAccessCase(req.user, kycCase))) {
    return res.status(403).json({ message: 'You are not authorised to access this KYC case' });
  }

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
  if (!(await canAccessCase(req.user, kycCase))) {
    return res.status(403).json({ message: 'You are not authorised to verify this KYC case' });
  }

  const { member_update } = req.body || {};
  if (member_update && kycCase.client_member_id) {
    // Everything the printable KYC form can capture (all exist on the shared members
    // table) — the form round-trip writes the customer's full profile in one verify.
    const allowed = [
      'full_name', 'father_name', 'mother_name', 'spouse_name', 'gender', 'date_of_birth',
      'marital_status', 'religion', 'nationality', 'qualification', 'occupation', 'company_name',
      'phone', 'alt_phone', 'whatsapp', 'email',
      'address', 'city', 'state', 'pincode',
      'aadhar_no', 'pan_no', 'voter_id',
      'bank_name', 'account_no', 'ifsc_code', 'branch',
      'nominee_name', 'nominee_relation', 'nominee_phone',
    ];
    const data = {};
    for (const k of allowed) if (member_update[k] !== undefined && member_update[k] !== null && member_update[k] !== '') data[k] = member_update[k];
    // members.gender has a DB CHECK (MALE/FEMALE/OTHER) — OCR yields "Male"; coerce
    // or drop rather than failing the whole verify on a constraint violation.
    if (data.gender !== undefined) {
      const g = String(data.gender).trim().toUpperCase();
      if (['MALE', 'FEMALE', 'OTHER'].includes(g)) data.gender = g; else delete data.gender;
    }
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
  // Member-anchored cases have no booking yet — the rollup happens when an admin
  // creates the booking (the case is adopted and its status carried over).
  if (kycCase.booking_id) {
    await pool.query(
      `UPDATE bookings SET kyc_status = 'VERIFIED', status = CASE WHEN status = 'KYC_PENDING' THEN 'KYC_DONE' ELSE status END, updated_at = now() WHERE id = $1`,
      [kycCase.booking_id]
    );
  }

  emitOcrUpdate({ bookingId: kycCase.booking_id, caseId: kycCase.id, status: 'VERIFIED' });
  res.json({ message: 'KYC verified', caseId: kycCase.id });
});
