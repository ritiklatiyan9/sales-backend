import pool from '../config/db.js';
import { pathToFileURL } from 'node:url';

/** Preserve historical entries, including any duplicate registrations. New entries
 * have a stable named-draw key, protected independently of HTTP request retries. */
export async function migrateDrawEnrollment(db = pool) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('ALTER TABLE draw_registrations ADD COLUMN IF NOT EXISTS enrollment_key TEXT');
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_draw_active_enrollment
      ON draw_registrations (site_id, client_member_id, enrollment_key)
      WHERE enrollment_key IS NOT NULL AND status <> 'CANCELLED'`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_draw_member_enrollments
      ON draw_registrations (site_id, client_member_id, id DESC)`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrateDrawEnrollment()
    .then(() => console.log('Migration 031 complete: reusable clients and protected named-draw enrollment.'))
    .catch(error => { console.error('Migration 031 rolled back:', error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
