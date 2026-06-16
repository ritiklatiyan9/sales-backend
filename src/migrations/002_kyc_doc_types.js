import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 002 — allow DOMICILE & INCOME KYC document types.
 *
 * SAFETY: 100% additive. It only WIDENS the existing CHECK constraint on
 * documents.type to permit two more values ('DOMICILE','INCOME'). No data is
 * altered or deleted — every existing row already holds a value that remains
 * valid under the widened set. Idempotent (drop IF EXISTS + recreate).
 */
const ALLOWED = ['AADHAAR', 'PAN', 'PHOTO', 'CHEQUE', 'VOTER_ID', 'PASSPORT', 'DL', 'DOMICILE', 'INCOME', 'OTHER'];

const migrate = async () => {
  const client = await pool.connect();
  try {
    // CHECK expressions can't use bind parameters; these values are fixed constants
    // (no user input), so inlining them as SQL string literals is safe.
    const literals = ALLOWED.map((v) => `'${v}'`).join(', ');
    await client.query('BEGIN');
    await client.query('ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_type_check');
    await client.query(
      `ALTER TABLE documents ADD CONSTRAINT documents_type_check CHECK (type IN (${literals}))`
    );
    await client.query('COMMIT');
    console.log('Migration 002_kyc_doc_types complete — documents.type now allows DOMICILE, INCOME');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 002_kyc_doc_types failed (rolled back, no changes):', err.message);
    throw err;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
