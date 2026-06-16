// Show the most recent document's OCR raw text + extracted fields (debugging).
import 'dotenv/config';
import pool from './src/config/db.js';

const { rows } = await pool.query(`
  SELECT d.id, d.type, d.ocr_status, d.ocr_error, d.file_path,
         r.raw_text, r.extracted_fields, r.confidence_overall, r.confidence_map
  FROM documents d
  LEFT JOIN LATERAL (SELECT * FROM ocr_results o WHERE o.document_id = d.id ORDER BY o.id DESC LIMIT 1) r ON true
  ORDER BY d.id DESC LIMIT 1
`);
const d = rows[0];
if (!d) { console.log('no documents'); process.exit(0); }
console.log('doc id        :', d.id, '| type:', d.type, '| status:', d.ocr_status);
console.log('file_path     :', d.file_path);
console.log('confidence    :', d.confidence_overall);
console.log('extracted     :', JSON.stringify(d.extracted_fields));
console.log('conf_map      :', JSON.stringify(d.confidence_map));
console.log('--- RAW OCR TEXT ---');
console.log(d.raw_text?.text || '(none)');
await pool.end();
