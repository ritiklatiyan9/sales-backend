import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';
import { EVENTS } from '../services/whatsapp.service.js';

/**
 * Migration 042 — explicit WhatsApp template assignments and a recoverable archive.
 * Pins each stage's currently approved version once. Re-running this migration preserves
 * later assignments, including deliberately unassigned stages. No AWS calls are made.
 */
export async function migrateWhatsAppTemplateManagement(db = pool) {
  await db.query('ALTER TABLE whatsapp_templates ADD COLUMN IF NOT EXISTS title VARCHAR(80)');
  await db.query('ALTER TABLE whatsapp_templates ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ');
  await db.query('ALTER TABLE whatsapp_stage_settings ADD COLUMN IF NOT EXISTS template_name VARCHAR(64)');
  await db.query(`ALTER TABLE whatsapp_stage_settings ADD COLUMN IF NOT EXISTS template_assignment_initialized BOOLEAN NOT NULL DEFAULT FALSE`);
  for (const [event, spec] of Object.entries(EVENTS)) {
    await db.query(`UPDATE whatsapp_templates SET title = $2 || ' · v' || version WHERE event = $1 AND title IS NULL`, [event, spec.label]);
    const { rows: [template] } = await db.query(`SELECT name FROM whatsapp_templates
      WHERE event = $1 AND status = 'APPROVED' AND archived_at IS NULL ORDER BY version DESC LIMIT 1`, [event]);
    await db.query(`INSERT INTO whatsapp_stage_settings (event, attachment, template_name, template_assignment_initialized)
      VALUES ($1, $2, $3, TRUE)
      ON CONFLICT (event) DO UPDATE SET
        template_name = CASE WHEN whatsapp_stage_settings.template_assignment_initialized
          THEN whatsapp_stage_settings.template_name ELSE EXCLUDED.template_name END,
        template_assignment_initialized = TRUE`, [event, spec.attachment || null, template?.name || null]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await migrateWhatsAppTemplateManagement(); console.log('Migration 042_whatsapp_template_management complete'); }
  catch (e) { console.error('Migration 042_whatsapp_template_management failed:', e.message); process.exitCode = 1; }
  finally { await pool.end(); }
}
