import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

/**
 * Migration 041 — WhatsApp Marketing (site-based bulk campaigns).
 *
 * Marketing templates live in whatsapp_templates (event 'MARKETING') with the site that
 * owns them and their header/button options. A campaign queues one whatsapp_messages row
 * per customer (campaign_id set); the worker sends them under the daily marketing limit,
 * after transactional messages. whatsapp_opt_outs is the do-not-message list for marketing.
 *
 * SAFETY: additive, booking-owned tables only; re-runnable.
 */
export async function migrateWhatsAppMarketing(db = pool) {
  await db.query('ALTER TABLE whatsapp_templates ADD COLUMN IF NOT EXISTS site_id INTEGER');
  await db.query(`ALTER TABLE whatsapp_templates ADD COLUMN IF NOT EXISTS options JSONB NOT NULL DEFAULT '{}'::jsonb`);
  await db.query('ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS campaign_id INTEGER');
  await db.query('CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_campaign ON whatsapp_messages (campaign_id) WHERE campaign_id IS NOT NULL');
  await db.query(`CREATE TABLE IF NOT EXISTS whatsapp_campaigns (
    id SERIAL PRIMARY KEY,
    site_id INTEGER NOT NULL,
    template_name VARCHAR(64) NOT NULL,
    media_id TEXT,
    status VARCHAR(12) NOT NULL DEFAULT 'SENDING',
    recipients INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    cancelled_at TIMESTAMPTZ
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS whatsapp_opt_outs (
    phone VARCHAR(16) PRIMARY KEY,
    reason TEXT,
    created_by INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await migrateWhatsAppMarketing(); console.log('Migration 041_whatsapp_marketing complete'); }
  catch (e) { console.error('Migration 041_whatsapp_marketing failed:', e.message); process.exitCode = 1; }
  finally { await pool.end(); }
}
