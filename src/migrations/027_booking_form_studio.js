import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

export async function migrateBookingFormStudio(db = pool) {
  await db.query(`CREATE TABLE IF NOT EXISTS booking_form_templates (
    site_id INTEGER PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
    draft JSONB NOT NULL DEFAULT '{}'::jsonb,
    published JSONB,
    revision INTEGER NOT NULL DEFAULT 1,
    published_revision INTEGER,
    updated_by INTEGER REFERENCES users(id),
    published_by INTEGER REFERENCES users(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at TIMESTAMPTZ
  )`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await migrateBookingFormStudio(); console.log('Booking Form Studio table ready.'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { await pool.end(); }
}
