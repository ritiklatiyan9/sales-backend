import pool from '../config/db.js';
import { validateApplicationTemplate, requirePublishableTemplate } from '../services/applicationFormTemplate.js';
import { DEFENCE_GARDEN_PAYMENT_PLAN } from '../../../sales-dg-frontend/src/lib/defenceGardenPaymentPlan.js';

// Explicit, one-time import for the site named in the user request. Preserve all
// existing design fields, issued terms, application identities and payment data.
const publish = process.argv.includes('--publish');
const revisionArg = process.argv.find(arg => arg.startsWith('--expected-revision='));
const expectedRevision = revisionArg ? Number(revisionArg.split('=')[1]) : null;
let client;
try {
  client = await pool.connect();
  await client.query('BEGIN');
  const { rows } = await client.query(`SELECT t.*,s.name,draft=published AS unchanged FROM application_form_templates t JOIN sites s ON s.id=t.site_id WHERE t.site_id=7 FOR UPDATE OF t`);
  const row = rows[0];
  if (!row || !/naya\s*baazar/i.test(row.name)) throw new Error('Expected Naya Baazar at site 7; nothing changed.');
  if (expectedRevision !== null && row.revision !== expectedRevision) throw new Error('The form revision changed; reload before importing.');
  if (row.draft.payment_plan) throw new Error('Payment details already exist; use Form Studio to edit them.');
  if (publish && !row.unchanged) throw new Error('The draft contains other changes. Save the payment plan as a draft and review before publishing.');
  const validated = validateApplicationTemplate({ ...row.draft, payment_plan:DEFENCE_GARDEN_PAYMENT_PLAN });
  if (publish) requirePublishableTemplate(validated);
  const draft = { ...row.draft, payment_plan:validated.payment_plan };
  const { rows:saved } = await client.query(`UPDATE application_form_templates SET draft=$1,revision=revision+1,updated_at=now(),published=CASE WHEN $2 THEN $1::jsonb ELSE published END,published_revision=CASE WHEN $2 THEN revision+1 ELSE published_revision END,published_at=CASE WHEN $2 THEN now() ELSE published_at END WHERE site_id=7 AND revision=$3 RETURNING site_id,revision,published_revision`, [JSON.stringify(draft),publish,row.revision]);
  if (!saved.length) throw new Error('The form changed; nothing imported.');
  await client.query('COMMIT');
  console.log(JSON.stringify({ ...saved[0], payment_plan_imported:true, published:publish }));
} catch (error) {
  if (client) await client.query('ROLLBACK');
  console.error(error.message);
  process.exitCode = 1;
} finally { client?.release(); await pool.end(); }
