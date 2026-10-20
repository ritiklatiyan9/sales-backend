import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

/**
 * Migration 039 — customer WhatsApp notifications (AWS End User Messaging Social).
 *
 * whatsapp_messages is both the outbox and the delivery log: hooks (and the Accounting
 * KYC verify) INSERT a QUEUED row after their own COMMIT; services/whatsapp.service.js
 * claims rows, sends the approved template and records SENT / FAILED / SKIPPED /
 * EXPIRED. UNIQUE dedupe_key ('<EVENT>:<id>') makes every event send at most once,
 * whatever retries, double clicks or extra API instances do.
 *
 * SAFETY: additive, booking-owned table only; re-runnable.
 */
export async function migrateWhatsAppMessages(db = pool) {
  await db.query(`CREATE TABLE IF NOT EXISTS whatsapp_messages (
    id BIGSERIAL PRIMARY KEY,
    dedupe_key TEXT NOT NULL UNIQUE,
    event VARCHAR(20) NOT NULL,
    ref_id INTEGER NOT NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'QUEUED',
    phone VARCHAR(16),
    template VARCHAR(64),
    provider_message_id TEXT,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_queued ON whatsapp_messages (id) WHERE status = 'QUEUED'`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await migrateWhatsAppMessages(); console.log('Migration 039_whatsapp_messages complete'); }
  catch (e) { console.error('Migration 039_whatsapp_messages failed:', e.message); process.exitCode = 1; }
  finally { await pool.end(); }
}
