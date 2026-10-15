import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

/** Clients have a separate credential realm; never create or change shared users. */
export async function migrateClientPortal(db = pool) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TABLE IF NOT EXISTS booking_client_accounts (
      id SERIAL PRIMARY KEY,
      phone VARCHAR(10) NOT NULL CHECK (phone ~ '^[6-9][0-9]{9}$'),
      identity_key CHAR(64) NOT NULL,
      password_hash TEXT NOT NULL,
      aadhaar_last4 CHAR(4) NOT NULL CHECK (aadhaar_last4 ~ '^[0-9]{4}$'),
      password_changed BOOLEAN NOT NULL DEFAULT false,
      token_version INTEGER NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (phone, identity_key)
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS booking_client_members (
      account_id INTEGER NOT NULL REFERENCES booking_client_accounts(id) ON DELETE CASCADE,
      member_id INTEGER NOT NULL UNIQUE REFERENCES members(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (account_id, member_id)
    )`);
    // Login has no site selected. Existing registry index starts with site_id.
    await client.query(`CREATE INDEX IF NOT EXISTS idx_members_portal_phone
      ON members ((RIGHT(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g'), 10)), id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_client_bookings_history ON bookings (client_member_id, site_id, id DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_client_draws_history ON draw_registrations (client_member_id, site_id, id DESC)`);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrateClientPortal().then(() => console.log('Separate client portal accounts ready.'))
    .catch(error => { console.error('Client portal migration rolled back:', error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
