import crypto from 'crypto';
import { processDocument } from '../services/ocrProcessor.js';

/**
 * In-process OCR queue. Previously this enqueued a Celery task onto Redis for a separate
 * Python worker; now OCR runs inside booking-api itself (see services/ocrProcessor.js),
 * so there is no broker and no worker service to deploy.
 *
 * `enqueueOcr` keeps the same signature the controllers use — it returns immediately with
 * a synthetic job id and processes the document in the background (fire-and-forget) with a
 * strict single-worker cap so a burst of uploads cannot overwhelm an OCR provider.
 */
const MAX_CONCURRENCY = 1;
let active = 0;
const waiting = [];
// A document may be enqueued by upload, retry, or more than one API instance event.
// Keep one job identity until that document finishes, preventing duplicate LLM calls.
const jobsByDocument = new Map();

const pump = () => {
  while (active < MAX_CONCURRENCY && waiting.length) {
    const { documentId, preload, jobId } = waiting.shift();
    active += 1;
    processDocument(documentId, preload)
      .catch((err) => console.error('[ocrQueue] processing error:', err.message))
      .finally(() => {
        active -= 1;
        if (jobsByDocument.get(String(documentId)) === jobId) {
          jobsByDocument.delete(String(documentId));
        }
        pump();
      });
  }
};

/**
 * Schedule OCR for a document. Returns a synthetic job id (stored as documents.ocr_job_id)
 * so the existing callers and DB columns are unchanged.
 *
 * `preload` (optional) = { buffer, mimeType } — the upload handler already holds the
 * file bytes in memory, so passing them here lets the processor skip the storage
 * round-trip entirely and start OCR immediately (retries omit it and fetch normally).
 */
export const enqueueOcr = async (documentId, preload) => {
  const documentKey = String(documentId);
  const existingJobId = jobsByDocument.get(documentKey);
  if (existingJobId) {
    console.log(`[ocrQueue] duplicate enqueue ignored document_id=${documentId} job=${existingJobId}`);
    return existingJobId;
  }
  const jobId = `inproc:${crypto.randomUUID()}`;
  jobsByDocument.set(documentKey, jobId);
  waiting.push({ documentId, preload, jobId });
  // Defer so the HTTP response returns before OCR work starts.
  setImmediate(pump);
  return jobId;
};

/**
 * Restore jobs lost during a process restart. Only PROCESSING rows older than ten
 * minutes are considered abandoned; current work owned by another live instance is
 * left untouched. Recovered jobs enter the same one-at-a-time queue.
 */
export const recoverOcrQueue = async (pool) => {
  await pool.query(
    `UPDATE documents
        SET ocr_status='PENDING', ocr_error=NULL, ocr_started_at=NULL, updated_at=now()
      WHERE ocr_status='PROCESSING'
        AND ocr_started_at < now() - interval '10 minutes'`
  );
  const { rows } = await pool.query(
    `SELECT id
       FROM documents
      WHERE ocr_status='PENDING'
      ORDER BY created_at ASC, id ASC`
  );
  for (const row of rows) await enqueueOcr(row.id);
  if (rows.length) console.log(`[ocrQueue] recovered ${rows.length} pending document(s)`);
};

export const closeQueue = async () => { /* no external broker to close */ };
