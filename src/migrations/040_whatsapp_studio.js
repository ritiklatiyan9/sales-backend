import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';
import { EVENTS, compileBody } from '../services/whatsapp.service.js';

// Submitted before WhatsApp Studio existed (from these default texts); adopted as version 1
// so their Meta review carries on.
const SUBMITTED = {
  REGISTERED: 'dgg_member_id_issued',
  KYC_VERIFIED: 'dgg_kyc_verified',
  BOOKING_CREATED: 'dgg_booking_confirmed',
  ALLOTTED: 'dgg_unit_allotted',
};

/**
 * Migration 040 — WhatsApp Studio.
 *
 * whatsapp_templates: every template version submitted to Meta for a stage. `body` keeps
 * the Studio's {field} text; `fields` maps Meta's {{1}}..{{n}} to those fields. The newest
 * APPROVED version is the one that sends. Deleted versions stay as status DELETED so a
 * name is never reused. whatsapp_stage_settings: per stage on/off and attached document.
 *
 * SAFETY: additive, booking-owned tables only; re-runnable.
 */
export async function migrateWhatsAppStudio(db = pool) {
  await db.query(`CREATE TABLE IF NOT EXISTS whatsapp_templates (
    id SERIAL PRIMARY KEY,
    event VARCHAR(30) NOT NULL,
    version INTEGER NOT NULL,
    name VARCHAR(64) NOT NULL UNIQUE,
    body TEXT NOT NULL,
    fields TEXT[] NOT NULL DEFAULT '{}',
    has_document BOOLEAN NOT NULL DEFAULT FALSE,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    category VARCHAR(20),
    rejected_reason TEXT,
    meta_template_id TEXT,
    created_by INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (event, version)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS whatsapp_stage_settings (
    event VARCHAR(30) PRIMARY KEY,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    attachment VARCHAR(40),
    updated_by INTEGER,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  for (const [event, name] of Object.entries(SUBMITTED)) {
    await db.query(
      'INSERT INTO whatsapp_templates (event, version, name, body, fields) VALUES ($1, 1, $2, $3, $4) ON CONFLICT DO NOTHING',
      [event, name, EVENTS[event].body, compileBody(event, EVENTS[event].body).fields],
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await migrateWhatsAppStudio(); console.log('Migration 040_whatsapp_studio complete'); }
  catch (e) { console.error('Migration 040_whatsapp_studio failed:', e.message); process.exitCode = 1; }
  finally { await pool.end(); }
}
