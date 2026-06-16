/**
 * One-time / on-demand backfill: re-run Groq extraction over the latest OCR result
 * of every DONE document and rewrite ocr_results.extracted_fields with clean data.
 *
 * Usage:
 *   node src/scripts/reextract.js            # all DONE documents
 *   node src/scripts/reextract.js 6          # only booking #6
 */
import 'dotenv/config';
import pool from '../config/db.js';
import { extractKycFieldsWithAi } from '../services/groq.service.js';

const bookingId = process.argv[2] ? Number(process.argv[2]) : null;

// Latest OCR result per DONE document (optionally scoped to one booking).
const sql = `
  SELECT DISTINCT ON (d.id)
         d.id AS document_id, d.type, r.id AS result_id, r.raw_text
  FROM documents d
  JOIN ocr_results r ON r.document_id = d.id
  JOIN kyc_cases k ON k.id = d.kyc_case_id
  WHERE d.ocr_status = 'DONE'
    AND d.type <> 'PHOTO'
    ${bookingId ? 'AND k.booking_id = $1' : ''}
  ORDER BY d.id, r.processed_at DESC NULLS LAST, r.id DESC
`;

const { rows } = await pool.query(sql, bookingId ? [bookingId] : []);
console.log(`Re-extracting ${rows.length} document(s)${bookingId ? ` for booking ${bookingId}` : ''}…`);

let updated = 0;
for (const row of rows) {
  const text = row.raw_text?.text || '';
  if (!text.trim()) {
    console.log(`  doc ${row.document_id} [${row.type}] — no raw text, skipping`);
    continue;
  }
  const fields = await extractKycFieldsWithAi(text, row.type);
  if (!fields || !Object.keys(fields).length) {
    console.log(`  doc ${row.document_id} [${row.type}] — AI returned nothing, leaving as-is`);
    continue;
  }
  await pool.query('UPDATE ocr_results SET extracted_fields = $1 WHERE id = $2', [JSON.stringify(fields), row.result_id]);
  updated += 1;
  console.log(`  doc ${row.document_id} [${row.type}] -> {${Object.keys(fields).join(', ')}}`);
}

console.log(`Done. Updated ${updated}/${rows.length} document(s).`);
await pool.end();
