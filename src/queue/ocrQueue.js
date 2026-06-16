import crypto from 'crypto';
import { processDocument } from '../services/ocrProcessor.js';

/**
 * In-process OCR queue. Previously this enqueued a Celery task onto Redis for a separate
 * Python worker; now OCR runs inside booking-api itself (see services/ocrProcessor.js),
 * so there is no broker and no worker service to deploy.
 *
 * `enqueueOcr` keeps the same signature the controllers use — it returns immediately with
 * a synthetic job id and processes the document in the background (fire-and-forget) with a
 * small concurrency cap so a burst of uploads doesn't overwhelm the Groq API.
 */
const MAX_CONCURRENCY = Number(process.env.OCR_CONCURRENCY || 3);
let active = 0;
const waiting = [];

const pump = () => {
  while (active < MAX_CONCURRENCY && waiting.length) {
    const { documentId } = waiting.shift();
    active += 1;
    processDocument(documentId)
      .catch((err) => console.error('[ocrQueue] processing error:', err.message))
      .finally(() => { active -= 1; pump(); });
  }
};

/**
 * Schedule OCR for a document. Returns a synthetic job id (stored as documents.ocr_job_id)
 * so the existing callers and DB columns are unchanged.
 */
export const enqueueOcr = async (documentId) => {
  const jobId = `inproc:${crypto.randomUUID()}`;
  waiting.push({ documentId });
  // Defer so the HTTP response returns before OCR work starts.
  setImmediate(pump);
  return jobId;
};

export const closeQueue = async () => { /* no external broker to close */ };
