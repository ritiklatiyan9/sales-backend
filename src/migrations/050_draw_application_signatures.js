import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

export async function migrateDrawApplicationSignatures(db = pool) {
  await db.query(`CREATE TABLE IF NOT EXISTS draw_application_signatures (
    draw_registration_id INTEGER PRIMARY KEY REFERENCES draw_registrations(id) ON DELETE CASCADE,
    applicant TEXT NOT NULL,
    authority TEXT NOT NULL,
    signed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    signed_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await migrateDrawApplicationSignatures();
    console.log('Booking application signatures ready. Existing signatures retained.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { await pool.end(); }
}
