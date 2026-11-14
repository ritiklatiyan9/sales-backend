import { schemaHas } from '../config/db.js';
export async function migrateApplicationFormVersions(db) {
  if (!(await schemaHas({columns:[['draw_application_signatures','form_snapshot'],['draw_application_signatures','form_hash']],relations:['draw_application_signature_versions']},db))) {
    await db.query('ALTER TABLE draw_application_signatures ADD COLUMN IF NOT EXISTS form_snapshot JSONB, ADD COLUMN IF NOT EXISTS form_hash TEXT');
    await db.query(`CREATE TABLE IF NOT EXISTS draw_application_signature_versions (
      id BIGSERIAL PRIMARY KEY,
      draw_registration_id INTEGER NOT NULL REFERENCES draw_registrations(id) ON DELETE CASCADE,
      applicant TEXT NOT NULL, authority TEXT NOT NULL,
      signed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      signed_at TIMESTAMPTZ NOT NULL, form_snapshot JSONB, form_hash TEXT
    )`);
    // Preserve legacy ink without claiming to know its historical form version.
    await db.query(`INSERT INTO draw_application_signature_versions(draw_registration_id,applicant,authority,signed_by,signed_at,form_snapshot,form_hash)
      SELECT s.draw_registration_id,s.applicant,s.authority,s.signed_by,s.signed_at,s.form_snapshot,s.form_hash FROM draw_application_signatures s
      WHERE NOT EXISTS(SELECT 1 FROM draw_application_signature_versions v WHERE v.draw_registration_id=s.draw_registration_id)`);
  }
}
