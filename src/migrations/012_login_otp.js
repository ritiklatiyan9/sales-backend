import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 012 — Email OTP second factor for admin-class logins.
 *
 * SAFETY: 100% additive. One NEW booking-module table; the only outward FK points
 * at users(id) and cascades FROM a user deletion (never into accounting data).
 * Re-runnable (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS).
 *
 * A row is a pending login challenge: after a super_admin/admin/sub_admin passes
 * the password (or Google) step, the booking-api stores a bcrypt hash of a 6-digit
 * OTP here, emails the code (Nodemailer), and returns `pending_token` instead of
 * JWTs. /auth/verify-otp consumes the row and mints the real token pair. Agents
 * never get a row — their login is single-step by design.
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: ref } = await client.query(`
      SELECT to_regclass('public.users') IS NOT NULL AS has_users
    `);
    if (!ref[0].has_users) {
      throw new Error('Required table missing: users — aborting (no changes made).');
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS login_otps (
        id             SERIAL PRIMARY KEY,
        user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        pending_token  VARCHAR(64) NOT NULL UNIQUE,
        otp_hash       VARCHAR(100) NOT NULL,
        attempts       INTEGER NOT NULL DEFAULT 0,
        expires_at     TIMESTAMPTZ NOT NULL,
        consumed_at    TIMESTAMPTZ,
        last_sent_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_login_otps_user ON login_otps(user_id)`);

    await client.query('COMMIT');
    console.log('Migration 012_login_otp complete (login_otps)');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 012_login_otp failed (rolled back, no changes):', err.message);
    throw err;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
