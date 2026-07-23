import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 019 — durable document-to-account-member slot metadata.
 *
 * Accounts migration 072 already adds this column on shared deployments. This
 * idempotent Booking-side migration keeps standalone/fresh installs compatible
 * and lets duplex Aadhaar pages remain explicitly Front/Back after replacements.
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      ALTER TABLE documents
        ADD COLUMN IF NOT EXISTS member_document_field VARCHAR(80)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_documents_case_member_field
        ON documents (kyc_case_id, member_document_field)
        WHERE member_document_field IS NOT NULL
    `);
    await client.query('COMMIT');
    console.log('Migration 019_document_member_field complete');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Migration 019_document_member_field failed (rolled back):', error.message);
    throw error;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
