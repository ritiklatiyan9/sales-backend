import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 016 — FINAL_BOOKING_FORM document type.
 *
 * A new LAST timeline stop on the booking's document workspace: the actual final
 * approved Booking Form (PDF/DOC/photo), uploaded purely for storage — no OCR runs
 * on it (see NO_OCR in components/kyc/workspace.jsx and skipOcr in kyc.controller.js).
 * Distinct from FINAL_APPROVED_BOOKED_FORM, which this change relabels in the UI to
 * "Final KYC Written" — the two are different documents at different stages.
 *
 * SAFETY: additive — widens the documents_type CHECK following the exact drop/re-add
 * pattern of migrations 002/005/010. No data is touched.
 */
const TYPES = [
  'AADHAAR', 'PAN', 'PHOTO', 'CHEQUE', 'VOTER_ID', 'PASSPORT', 'DL',
  'DOMICILE', 'INCOME', 'FINAL_APPROVED_BOOKED_FORM', 'KYC_FORM', 'FINAL_BOOKING_FORM', 'OTHER',
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
    console.log('Migration 016_final_booking_form_doc_type complete (documents.type += FINAL_BOOKING_FORM)');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 016_final_booking_form_doc_type failed (rolled back, no changes):', err.message);
    throw err;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
