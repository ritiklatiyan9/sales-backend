import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

/** Explicit, audited person links; never infer a login identity from a KYC operator. */
export async function migrateKycLoginIdentity(db = pool) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('ALTER TABLE booking_staff_identities ADD COLUMN IF NOT EXISTS aadhaar_last4 CHAR(4)');
    await client.query(`CREATE TABLE IF NOT EXISTS booking_user_kyc_links (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      member_id INTEGER NOT NULL UNIQUE REFERENCES members(id),
      kyc_case_id INTEGER REFERENCES kyc_cases(id) ON DELETE SET NULL,
      phone VARCHAR(10) NOT NULL CHECK (phone ~ '^[6-9][0-9]{9}$'),
      aadhaar_last4 CHAR(4) NOT NULL CHECK (aadhaar_last4 ~ '^[0-9]{4}$'),
      linked_by INTEGER NOT NULL REFERENCES users(id),
      linked_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS booking_kyc_login_events (
      id BIGSERIAL PRIMARY KEY,
      actor_user_id INTEGER NOT NULL REFERENCES users(id),
      target_user_id INTEGER NOT NULL REFERENCES users(id),
      member_id INTEGER NOT NULL REFERENCES members(id),
      kyc_case_id INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await client.query('CREATE INDEX IF NOT EXISTS idx_booking_kyc_login_events_target ON booking_kyc_login_events (target_user_id, id DESC)');
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrateKycLoginIdentity().then(() => console.log('Explicit KYC login linking ready.'))
    .catch(error => { console.error('KYC login migration rolled back:', error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
