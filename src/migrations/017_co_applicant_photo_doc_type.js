import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 017 — CO_APPLICANT_PHOTO document type.
 *
 * A new booking-only timeline stop: the joint/co-applicant's photo, uploaded purely
 * for storage — no OCR runs on it (see NO_OCR in components/kyc/workspace.jsx and
 * skipOcr in kyc.controller.js). The co-applicant's TEXT details (name, relation,
 * DOB, phone, etc.) are captured separately and persist onto the shared `members`
 * table's co_applicant_* columns (added by Accounts/rgaccountbackend/migrate_co_applicant.js).
 *
 * SAFETY: additive — widens the (booking-owned) documents_type CHECK following the
 * exact drop/re-add pattern of migrations 002/005/010/016. No data is touched.
 */
const TYPES = [
  'AADHAAR', 'PAN', 'PHOTO', 'CHEQUE', 'VOTER_ID', 'PASSPORT', 'DL',
  'DOMICILE', 'INCOME', 'FINAL_APPROVED_BOOKED_FORM', 'KYC_FORM',
  'FINAL_BOOKING_FORM', 'CO_APPLICANT_PHOTO', 'OTHER',
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
    console.log('Migration 017_co_applicant_photo_doc_type complete (documents.type += CO_APPLICANT_PHOTO)');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 017_co_applicant_photo_doc_type failed (rolled back, no changes):', err.message);
    throw err;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
