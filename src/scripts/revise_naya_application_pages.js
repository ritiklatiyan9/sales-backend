import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pool from '../config/db.js';
import { validateApplicationTemplate, requirePublishableTemplate } from '../services/applicationFormTemplate.js';
import { NAYA_BAAZAR_TERMS, NAYA_BAAZAR_PAYMENT_PLAN } from '../../../sales-dg-frontend/src/lib/nayaBaazarBookingForm.js';
import { reviseNayaIssuedTerms } from '../../../sales-dg-frontend/src/lib/nayaBaazarFormRevision.js';

// Explicit revision of the requested site and unsigned application 46 only.
// Preserve the recorded payment values, dates, artwork and all other applications.
const apply = process.argv.includes('--apply');
const expected = Number(process.argv.find(arg => arg.startsWith('--revision='))?.split('=')[1]);
const hash = value => createHash('sha256').update(value).digest('hex');
function revisedTemplate(template) {
  const source = template.payment_plan, copy = NAYA_BAAZAR_PAYMENT_PLAN;
  if (source?.rental_options?.map(row => row.option).join(',') !== 'A,B,C') throw new Error('Review the changed payment options before applying this revision.');
  const plan = { ...source };
  for (const key of ['title', 'subtitle', 'overview_only', 'show_payout_details', 'schedule_note', 'rental_benefit_heading', 'rental_introduction','rental_clauses']) plan[key] = copy[key];
  plan.rental_options = source.rental_options.map((row, index) => ({ ...row, benefit: copy.rental_options[index].benefit, ...(index < 2 ? { timeline: copy.rental_options[index].timeline } : {}) }));
  const revised = validateApplicationTemplate({ ...template, terms: NAYA_BAAZAR_TERMS, terms_subtitle: 'Read all terms together with the payment plan and payment conditions before signing.', payment_plan: plan });
  requirePublishableTemplate(revised);
  return revised;
}

let client;
try {
  client = await pool.connect();
  await client.query('BEGIN');
  const { rows: [row] } = await client.query('SELECT t.*, s.name FROM application_form_templates t JOIN sites s ON s.id=t.site_id WHERE t.site_id=7 FOR UPDATE OF t');
  const { rows: [draw] } = await client.query('SELECT id,site_id,terms_snapshot FROM draw_registrations WHERE id=46 FOR UPDATE');
  if (row?.name !== 'Naya Baazar Unn Commercial' || !row.published || draw?.site_id !== 7) throw new Error('The requested site/application could not be verified.');
  if (apply && (!Number.isInteger(expected) || row.revision !== expected)) throw new Error('The reviewed form revision changed.');
  const { rowCount: signed } = await client.query('SELECT 1 FROM draw_application_signatures WHERE draw_registration_id=46');
  if (signed) throw new Error('Application 46 has been signed; its terms cannot be revised while retaining those signatures.');
  const draft = revisedTemplate(row.draft), published = revisedTemplate(row.published), terms = reviseNayaIssuedTerms(draw.terms_snapshot);
  const { rows: [settings] } = await client.query('SELECT site_id,draw_terms FROM project_settings WHERE site_id=7 FOR UPDATE');
  if (!apply) {
    await client.query('ROLLBACK');
    console.log(JSON.stringify({ site_id: 7, application_id: 46, revision: row.revision, ready: true, signed: false, application_terms_changed: terms !== draw.terms_snapshot, template_terms_characters: published.terms.length }));
  } else {
    const backup = `/private/tmp/naya-pages-before-${Date.now()}.json`;
    await writeFile(backup, JSON.stringify({ template: row, settings, draw }), { mode: 0o600 });
    const { rows: [saved] } = await client.query(`UPDATE application_form_templates SET draft=$1,published=$2,revision=revision+1,published_revision=revision+1,updated_at=now(),published_at=now() WHERE site_id=7 AND revision=$3 RETURNING site_id,revision,published_revision`, [JSON.stringify(draft), JSON.stringify(published), expected]);
    if (!saved) throw new Error('The reviewed form revision changed.');
    await client.query('UPDATE project_settings SET draw_terms=$1,updated_at=now() WHERE site_id=7', [published.terms]);
    if (terms !== draw.terms_snapshot) {
      await client.query('UPDATE draw_registrations SET terms_snapshot=$1,updated_at=now() WHERE id=46 AND site_id=7', [terms]);
      await client.query(`INSERT INTO draw_events(draw_registration_id,event_type,detail) VALUES(46,'APPLICATION_TERMS_REVISED',$1)`, [JSON.stringify({ reason: 'Requested 30-day refund period and clarified rent terms', previous_terms_sha256: hash(draw.terms_snapshot), revised_terms_sha256: hash(terms), template_revision: saved.revision })]);
    }
    await client.query('COMMIT');
    console.log(JSON.stringify({ ...saved, application_id: 46, applied: true, backup }));
  }
} catch (error) {
  if (client) await client.query('ROLLBACK');
  console.error(error.message);
  process.exitCode = 1;
} finally {
  client?.release();
  await pool.end();
}
