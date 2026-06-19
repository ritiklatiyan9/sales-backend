import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 006 - widen documents.type.
 *
 * Migration 005 added 'FINAL_APPROVED_BOOKED_FORM' (26 chars) to the CHECK
 * constraint but the column was still VARCHAR(20), so uploading that document
 * failed with "value too long for type character varying(20)". This widens the
 * column. SAFETY: additive only — widening never truncates existing data.
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('ALTER TABLE documents ALTER COLUMN type TYPE VARCHAR(40)');
    await client.query('COMMIT');
    console.log('Migration 006_widen_documents_type complete');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 006_widen_documents_type failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
