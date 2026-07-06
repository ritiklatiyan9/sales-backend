/**
 * In-process OCR processor — runs the whole OCR pipeline inside booking-api.
 *
 * This is the Node port of the old Python Celery task (ocr-worker/tasks.py + db.py):
 * fetch the file → run the OCR engine → write ocr_results → flip document status →
 * roll up the KYC case + booking → emit a socket event for live UI updates.
 *
 * It runs fire-and-forget from the upload handler (see queue/ocrQueue.js) so the HTTP
 * response still returns immediately and the UI keeps its PENDING → PROCESSING → DONE
 * live flow — only now there is no Redis broker and no separate worker process.
 */
import pool from '../config/db.js';
import { fetchKycDocumentBytes } from '../utils/s3.js';
import { emitOcrUpdate } from '../config/socket.js';
import { runOcr } from './ocr.service.js';

/** case_id + booking_id for a document (for socket room targeting). booking_id is
 * null for member-anchored KYC cases created before any booking exists. */
const getCaseAndBookingId = async (documentId) => {
  const { rows } = await pool.query(
    `SELECT k.id AS case_id, k.booking_id FROM documents d JOIN kyc_cases k ON k.id = d.kyc_case_id WHERE d.id = $1`,
    [documentId]
  );
  return { caseId: rows[0]?.case_id || null, bookingId: rows[0]?.booking_id || null };
};

const setProcessing = (documentId) =>
  pool.query(
    `UPDATE documents SET ocr_status='PROCESSING', ocr_started_at=now(), updated_at=now() WHERE id=$1`,
    [documentId]
  );

const saveResult = ({ documentId, text, fields, confidence, confidenceMap, engine }) =>
  pool.query(
    `INSERT INTO ocr_results
       (document_id, raw_text, extracted_fields, confidence_overall, confidence_map, engine, processed_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())`,
    [
      documentId,
      JSON.stringify({ text }),
      JSON.stringify(fields),
      Math.round(confidence * 1000) / 1000,
      JSON.stringify(confidenceMap),
      engine,
    ]
  );

const setDone = (documentId, engine) =>
  pool.query(
    `UPDATE documents SET ocr_status='DONE', ocr_engine=$1, ocr_completed_at=now(), ocr_error=NULL, updated_at=now() WHERE id=$2`,
    [engine, documentId]
  );

const setFailed = (documentId, error) =>
  pool.query(
    `UPDATE documents SET ocr_status='FAILED', ocr_error=$1, ocr_completed_at=now(), updated_at=now() WHERE id=$2`,
    [String(error?.message || error).slice(0, 2000), documentId]
  );

/**
 * If every document in the case is DONE, advance case + booking to OCR_DONE
 * (unless already VERIFIED). Returns the booking_id.
 */
const rollupCaseAndBooking = async (documentId) => {
  const { rows } = await pool.query(
    `SELECT k.id AS case_id, k.booking_id, k.status AS case_status
       FROM documents d JOIN kyc_cases k ON k.id = d.kyc_case_id WHERE d.id = $1`,
    [documentId]
  );
  const row = rows[0];
  if (!row) return null;

  const { rows: countRows } = await pool.query(
    `SELECT count(*) FILTER (WHERE ocr_status <> 'DONE') AS not_done, count(*) AS total
       FROM documents WHERE kyc_case_id = $1`,
    [row.case_id]
  );
  const allDone = Number(countRows[0].total) > 0 && Number(countRows[0].not_done) === 0;

  if (allDone && row.case_status !== 'VERIFIED') {
    await pool.query(`UPDATE kyc_cases SET status='OCR_DONE', updated_at=now() WHERE id=$1`, [row.case_id]);
    if (row.booking_id) {
      await pool.query(
        `UPDATE bookings SET kyc_status='OCR_DONE', updated_at=now() WHERE id=$1 AND kyc_status <> 'VERIFIED'`,
        [row.booking_id]
      );
    }
  }
  return row.booking_id;
};

/**
 * Result cache — if the exact same file (by sha-256 hash) was already OCR'd
 * successfully for the same document type, reuse that result instead of paying
 * for another vision call. Covers re-uploads and replace-with-same-file.
 */
const findCachedResult = async (doc) => {
  if (!doc.file_hash) return null;
  const { rows } = await pool.query(
    `SELECT r.raw_text, r.extracted_fields, r.confidence_overall, r.confidence_map, r.engine
       FROM documents d2
       JOIN ocr_results r ON r.document_id = d2.id
      WHERE d2.file_hash = $1 AND d2.id <> $2 AND d2.type = $3 AND d2.ocr_status = 'DONE'
      ORDER BY r.processed_at DESC
      LIMIT 1`,
    [doc.file_hash, doc.id, doc.type]
  );
  const hit = rows[0];
  if (!hit) return null;
  return {
    text: hit.raw_text?.text || '',
    fields: hit.extracted_fields || {},
    confidence: Number(hit.confidence_overall) || 0,
    confidenceMap: hit.confidence_map || {},
    engine: `cache:${hit.engine || 'unknown'}`,
  };
};

/**
 * Process one document end-to-end. Never throws (errors are recorded as FAILED), so it
 * is safe to call fire-and-forget. Emits live pipeline stage events the UI renders as
 * an animated progress timeline: FETCH → PREPROCESS → OCR → VALIDATE → DONE.
 */
export const processDocument = async (documentId, preload) => {
  console.log(`[ocrProcessor] start document_id=${documentId}`);
  const { rows } = await pool.query('SELECT * FROM documents WHERE id = $1', [documentId]);
  const doc = rows[0];
  if (!doc) {
    console.warn(`[ocrProcessor] document ${documentId} not found — skipping`);
    return;
  }

  const { caseId, bookingId } = await getCaseAndBookingId(documentId);
  const stage = (s) => emitOcrUpdate({ bookingId, caseId, documentId, status: 'PROCESSING', stage: s });

  try {
    await setProcessing(documentId);
    stage('FETCH');

    // Cache hit → skip the vision call entirely (same bytes, same doc type).
    const cached = await findCachedResult(doc);
    let result;
    if (cached) {
      console.log(`[ocrProcessor] cache hit for document_id=${documentId} (hash ${String(doc.file_hash).slice(0, 12)}…)`);
      stage('VALIDATE');
      result = cached;
    } else {
      // Fast path: use the in-memory bytes handed over by the upload request when
      // available — skips the storage round-trip so OCR starts instantly.
      const fileBytes = preload?.buffer?.length
        ? preload.buffer
        : await fetchKycDocumentBytes(doc.file_path);
      result = await runOcr(fileBytes, preload?.mimeType || doc.mime_type, doc.type, stage);
    }

    await saveResult({ documentId, ...result });
    await setDone(documentId, result.engine);
    const bId = await rollupCaseAndBooking(documentId);
    emitOcrUpdate({ bookingId: bId || bookingId, caseId, documentId, status: 'DONE', stage: 'DONE' });
    console.log(`[ocrProcessor] done document_id=${documentId} fields=${Object.keys(result.fields).join(',')}`);
  } catch (err) {
    console.error(`[ocrProcessor] FAILED document_id=${documentId}:`, err.message);
    await setFailed(documentId, err);
    let bId = bookingId;
    try { bId = await rollupCaseAndBooking(documentId); } catch { /* ignore */ }
    emitOcrUpdate({ bookingId: bId || bookingId, caseId, documentId, status: 'FAILED', stage: 'FAILED' });
  }
};
