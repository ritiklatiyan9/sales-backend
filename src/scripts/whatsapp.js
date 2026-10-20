import 'dotenv/config';
import pool from '../config/db.js';
import { EVENTS, refreshTemplates, sendTestMessage, submitTemplate } from '../services/whatsapp.service.js';

/**
 * WhatsApp helper (the same actions as WhatsApp Studio). Needs WHATSAPP_PHONE_NUMBER_ID
 * and migrations 039 + 040.
 *   npm run whatsapp -- templates                 submit the default template for every stage
 *                                                 that has none yet, then print review status
 *   npm run whatsapp -- test 98XXXXXXXX [STAGE]   send a stage's approved template (default
 *                                                 KYC_VERIFIED) with sample values
 *   npm run whatsapp -- log                       last 20 rows of the whatsapp_messages outbox
 */
const [command, mobile, stage = 'KYC_VERIFIED'] = process.argv.slice(2);

async function templates() {
  const { rows } = await pool.query(`SELECT DISTINCT event FROM whatsapp_templates WHERE status <> 'DELETED'`);
  const existing = new Set(rows.map((r) => r.event));
  for (const [event, spec] of Object.entries(EVENTS)) {
    if (existing.has(event)) continue;
    const created = await submitTemplate({ event, body: spec.body, hasDocument: Boolean(spec.attachment) });
    console.log(`${event}: submitted ${created.name}`);
  }
  await refreshTemplates();
  const { rows: list } = await pool.query(`SELECT event, name, has_document, status, category, rejected_reason
    FROM whatsapp_templates WHERE status <> 'DELETED' ORDER BY event, version`);
  console.table(list);
}

async function log() {
  const { rows } = await pool.query(`SELECT id, event, ref_id, status, phone, template, error, created_at
    FROM whatsapp_messages ORDER BY id DESC LIMIT 20`);
  console.table(rows.map((r) => ({ ...r, created_at: r.created_at.toISOString().slice(0, 19).replace('T', ' '), error: r.error?.slice(0, 60) })));
}

try {
  if (command === 'log') await log();
  else if (!process.env.WHATSAPP_PHONE_NUMBER_ID) throw new Error('Set WHATSAPP_PHONE_NUMBER_ID first (AWS console > End User Messaging Social > WhatsApp > your phone number).');
  else if (command === 'templates') await templates();
  else if (command === 'test') console.log(await sendTestMessage(stage, mobile));
  else throw new Error(`Usage: npm run whatsapp -- templates | test 98XXXXXXXX [${Object.keys(EVENTS).join('|')}] | log`);
} catch (error) {
  console.error(`${error.name}: ${error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
