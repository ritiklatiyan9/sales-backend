import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

export async function migrateClientInvitations(db = pool) {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    await c.query(`CREATE TABLE IF NOT EXISTS booking_client_invitations (
      id BIGSERIAL PRIMARY KEY,
      member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      code_hash CHAR(64) NOT NULL UNIQUE,
      issued_by INTEGER NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await c.query('CREATE INDEX IF NOT EXISTS booking_client_invitation_member_idx ON booking_client_invitations(member_id)');
    await c.query('COMMIT');
  } catch (error) { await c.query('ROLLBACK'); throw error; }
  finally { c.release(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrateClientInvitations().then(() => console.log('Client invitations ready.'))
    .catch(error => { console.error('Client invitation migration failed:', error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
