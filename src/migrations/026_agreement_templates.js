import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

// Agreement Form Studio: many formats per site, at most one default used for printing.
export async function migrateAgreementTemplates(db = pool) {
  await db.query(`CREATE TABLE IF NOT EXISTS agreement_templates (
    id SERIAL PRIMARY KEY,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    name VARCHAR(120) NOT NULL,
    preset VARCHAR(40) NOT NULL,
    design JSONB NOT NULL DEFAULT '{}'::jsonb,
    body TEXT NOT NULL DEFAULT '',
    is_default BOOLEAN NOT NULL DEFAULT false,
    revision INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER REFERENCES users(id),
    updated_by INTEGER REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await db.query('CREATE INDEX IF NOT EXISTS agreement_templates_site_idx ON agreement_templates(site_id)');
  await db.query('CREATE UNIQUE INDEX IF NOT EXISTS agreement_templates_one_default ON agreement_templates(site_id) WHERE is_default');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await migrateAgreementTemplates(); console.log('Agreement templates table ready.'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { await pool.end(); }
}
