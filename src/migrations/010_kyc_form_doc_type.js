import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 010 — KYC_FORM document type.
 *
 * The printable KYC Application Form (generated at /kyc/:id/print, filled by pen,
 * scanned/photographed back) uploads as its own document type so OCR can run a
 * form-specific extraction (all booking-form fields + the printed agent code).
 *
 * SAFETY: additive — widens the documents_type CHECK following the exact drop/re-add
 * pattern of migrations 002/005. No data is touched.
 */
const TYPES = [
  'AADHAAR', 'PAN', 'PHOTO', 'CHEQUE', 'VOTER_ID', 'PASSPORT', 'DL',
  'DOMICILE', 'INCOME', 'FINAL_APPROVED_BOOKED_FORM', 'KYC_FORM', 'OTHER',
];

const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_type_check');
    await client.query(`
      ALTER TABLE documents ADD CONSTRAINT documents_type_check
        CHECK (type IN (${TYPES.map((t) => `'${t}'`).join(', ')}))
    `);
    await client.query('COMMIT');
    console.log('Migration 010_kyc_form_doc_type complete (documents.type += KYC_FORM)');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 010_kyc_form_doc_type failed (rolled back, no changes):', err.message);
    throw err;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
