import 'dotenv/config';
import crypto from 'crypto';
import pool from '../config/db.js';

/**
 * Migration 014 — public verification QR for KYC cases.
 *
 * Adds kyc_cases.qr_token (unguessable 128-bit hex capability, same pattern as
 * draw_registrations.qr_token) and backfills existing rows. The printed KYC form's
 * QR encodes a public verify URL resolved LIVE against this token.
 *
 * SAFETY: 100% additive + re-runnable; backfill only touches rows with NULL tokens.
 * Tokens are generated in Node (crypto.randomBytes) so no pgcrypto extension needed.
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`ALTER TABLE kyc_cases ADD COLUMN IF NOT EXISTS qr_token VARCHAR(64) UNIQUE`);
    const { rows } = await client.query(`SELECT id FROM kyc_cases WHERE qr_token IS NULL`);
    for (const { id } of rows) {
      await client.query('UPDATE kyc_cases SET qr_token = $1 WHERE id = $2 AND qr_token IS NULL',
        [crypto.randomBytes(16).toString('hex'), id]);
    }
    await client.query('COMMIT');
    console.log(`Migration 014_kyc_qr_token complete (backfilled ${rows.length} case tokens)`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 014_kyc_qr_token failed (rolled back, no changes):', err.message);
    throw err;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
