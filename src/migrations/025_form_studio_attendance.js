import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

export async function migrateFormStudioAttendance(db = pool) {
  await db.query(`CREATE TABLE IF NOT EXISTS application_form_templates (
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
  await db.query(`CREATE TABLE IF NOT EXISTS draw_attendance (
    id SERIAL PRIMARY KEY,
    draw_registration_id INTEGER NOT NULL REFERENCES draw_registrations(id),
    attendance_date DATE NOT NULL,
    present BOOLEAN NOT NULL DEFAULT true,
    checked_in_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    checked_in_by INTEGER NOT NULL REFERENCES users(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(draw_registration_id, attendance_date)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS draw_attendance_events (
    id SERIAL PRIMARY KEY,
    attendance_id INTEGER NOT NULL REFERENCES draw_attendance(id),
    action VARCHAR(30) NOT NULL CHECK (action IN ('CHECKED_IN','CORRECTED')),
    actor_id INTEGER NOT NULL REFERENCES users(id),
    reason VARCHAR(300),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await db.query('CREATE INDEX IF NOT EXISTS draw_attendance_date_idx ON draw_attendance(attendance_date, present)');
  await db.query('CREATE INDEX IF NOT EXISTS draw_roster_site_date_idx ON draw_registrations(site_id, draw_opening_date)');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await migrateFormStudioAttendance(); console.log('Form Studio and attendance tables ready.'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { await pool.end(); }
}
