import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 005 - allow the final signed booking form as a KYC archive document.
 *
 * SAFETY: additive only. It widens documents.type so staff can upload the
 * manually signed, finally approved booked form for future reference.
 */
const ALLOWED = [
  'AADHAAR',
  'PAN',
  'PHOTO',
  'CHEQUE',
  'VOTER_ID',
  'PASSPORT',
  'DL',
  'DOMICILE',
  'INCOME',
  'FINAL_APPROVED_BOOKED_FORM',
  'OTHER',
];

const migrate = async () => {
  const client = await pool.connect();
  try {
    const literals = ALLOWED.map((v) => `'${v}'`).join(', ');
    await client.query('BEGIN');
    await client.query('ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_type_check');
    await client.query(
      `ALTER TABLE documents ADD CONSTRAINT documents_type_check CHECK (type IN (${literals}))`
    );
    await client.query('COMMIT');
    console.log('Migration 005_final_approved_booked_form_doc_type complete');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 005_final_approved_booked_form_doc_type failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
