import { writeFile } from 'node:fs/promises';
import pool from '../config/db.js';
import { validateApplicationTemplate, requirePublishableTemplate } from '../services/applicationFormTemplate.js';
import { NAYA_BAAZAR_FORM_UPDATE } from '../../../sales-dg-frontend/src/lib/nayaBaazarBookingForm.js';

// Explicit import for the requested site. Dry-run by default; publication uses
// the normal Studio action after the six-page preview has been checked.
const apply = process.argv.includes('--apply');
const expected = Number(process.argv.find(arg => arg.startsWith('--revision='))?.split('=')[1]);
let client;
try {
  client = await pool.connect();
  await client.query('BEGIN');
  const { rows } = await client.query(`SELECT t.*, s.name FROM application_form_templates t
    JOIN sites s ON s.id=t.site_id WHERE t.site_id=7 FOR UPDATE OF t`);
  const row = rows[0];
  if (!row || row.name !== 'Naya Baazar Unn Commercial') throw new Error('Expected Naya Baazar Unn Commercial at site 7; nothing changed.');
  if (apply && (!Number.isInteger(expected) || expected !== row.revision)) throw new Error('The reviewed revision changed; nothing changed.');
  const draft = validateApplicationTemplate({ ...row.draft, ...NAYA_BAAZAR_FORM_UPDATE });
  requirePublishableTemplate(draft);
  console.log(JSON.stringify({ site_id:row.site_id, name:row.name, revision:row.revision, apply, clauses:6, installments:draft.payment_plan.installments.length, payout_fields:draft.payment_plan.payout_fields.length }));
  if (apply) {
    const backup = `/private/tmp/naya-baazar-form-before-${Date.now()}.json`;
    await writeFile(backup, JSON.stringify(row, null, 2), { mode:0o600 });
    const result = await client.query(`UPDATE application_form_templates SET draft=$1, revision=revision+1, updated_at=now()
      WHERE site_id=7 AND revision=$2 RETURNING site_id,revision,published_revision`, [JSON.stringify(draft), expected]);
    if (result.rowCount !== 1) throw new Error('The form changed; nothing imported.');
    await client.query('COMMIT');
    console.log(JSON.stringify({ ...result.rows[0], backup, draft_updated:true }));
  } else await client.query('ROLLBACK');
} catch (error) {
  if (client) await client.query('ROLLBACK');
  console.error(error.message);
  process.exitCode = 1;
} finally { client?.release(); await pool.end(); }
