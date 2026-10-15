import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';
import { PHONE_LOOKUP_SQL } from '../services/staffIdentity.service.js';

/** Additive shared-user migration. Does not derive staff credentials from client KYC. */
export async function migrateStaffIdentity(db = pool) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Keep the hash outside shared users: older Accounting APIs use SELECT * and
    // do not know how to remove a new credential column from their responses.
    await client.query(`CREATE TABLE IF NOT EXISTS booking_staff_identities (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      aadhaar_password_hash TEXT NOT NULL,
      password_fingerprint CHAR(64) NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await client.query('CREATE INDEX IF NOT EXISTS idx_booking_users_email_normalized ON users (lower(btrim(email)))');
    await client.query(`CREATE INDEX IF NOT EXISTS idx_booking_users_phone_normalized ON users ((${PHONE_LOOKUP_SQL}))`);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrateStaffIdentity().then(() => console.log('Staff phone sign-in and profile indexes ready.'))
    .catch(error => { console.error('Staff identity migration rolled back:', error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
