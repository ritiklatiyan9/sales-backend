import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

// Shared with Accounts migration 228. Either API may be deployed first; no
// existing per-app choice is overwritten when either migration runs again.
export async function migrateBookingAccountsLoginAccess(db = pool) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('shared_booking_accounts_login_access'))");
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS can_login_accounts BOOLEAN NOT NULL DEFAULT TRUE`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS can_login_booking BOOLEAN NOT NULL DEFAULT TRUE`);
    await client.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema=current_schema() AND table_name='users' AND column_name='can_login_booking_accounts') THEN
        ALTER TABLE users ADD COLUMN can_login_booking_accounts BOOLEAN NOT NULL DEFAULT TRUE;
        UPDATE users SET can_login_booking_accounts=can_login_booking;
      END IF;
    END $$`);
    await client.query(`CREATE TABLE IF NOT EXISTS login_otps (
      id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      pending_token VARCHAR(64) NOT NULL UNIQUE, otp_hash VARCHAR(100) NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ, last_sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await client.query('ALTER TABLE login_otps ADD COLUMN IF NOT EXISTS app_context TEXT');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrateBookingAccountsLoginAccess().then(() => console.log('Booking and Accountancy login access ready.'))
    .catch(error => { console.error('App login access migration failed:', error.code || 'MIGRATION_FAILED'); process.exitCode = 1; })
    .finally(() => pool.end());
}
