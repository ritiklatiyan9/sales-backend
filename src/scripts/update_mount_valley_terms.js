import { writeFile } from 'node:fs/promises';
import pool from '../config/db.js';
import { validateApplicationTemplate, requirePublishableTemplate } from '../services/applicationFormTemplate.js';
import { withMountValleyCancellationTerms } from '../services/mountValleyApplicationTerms.js';

// Dry-run by default. Apply only to the reviewed revision of the exact site.
const apply = process.argv.includes('--apply');
const revisionArg = process.argv.find(arg => arg.startsWith('--revision='));
const expected = revisionArg ? Number(revisionArg.split('=')[1]) : null;
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const { rows } = await client.query(`SELECT s.id,s.name,t.* FROM sites s
    JOIN application_form_templates t ON t.site_id=s.id
    WHERE s.name='Mount Valley Residency' FOR UPDATE OF t`);
  if (rows.length !== 1) throw new Error('Expected one Mount Valley Residency template; nothing changed.');
  const row = rows[0];
  if (apply && (!Number.isInteger(expected) || row.revision !== expected)) throw new Error('The reviewed form revision changed; inspect the current form before applying.');
  if (!row.published || !/unn commercial/i.test(row.published.brand_name || '')) throw new Error('Expected the published Unn Commercial form; nothing changed.');
  const revise = template => validateApplicationTemplate({ ...template, image_height:64, terms:withMountValleyCancellationTerms(template.terms) });
  const draft = revise(row.draft), published = revise(row.published);
  requirePublishableTemplate(published);
  console.log(JSON.stringify({ site_id:row.id, name:row.name, revision:row.revision, apply, terms:published.terms }, null, 2));
  if (apply) {
    const backup = `/private/tmp/mount-valley-form-before-${Date.now()}.json`;
    const { rows:settings } = await client.query('SELECT site_id,draw_terms FROM project_settings WHERE site_id=$1 FOR UPDATE', [row.id]);
    await writeFile(backup, JSON.stringify({ template:row, settings:settings[0] }, null, 2), { mode:0o600 });
    await client.query(`UPDATE application_form_templates SET draft=$1,published=$2,revision=revision+1,
      published_revision=revision+1,updated_at=now(),published_at=now() WHERE site_id=$3 AND revision=$4`,
    [JSON.stringify(draft),JSON.stringify(published),row.id,expected]);
    await client.query(`INSERT INTO project_settings(site_id,draw_terms) VALUES($1,$2)
      ON CONFLICT(site_id) DO UPDATE SET draw_terms=EXCLUDED.draw_terms,updated_at=now()`, [row.id,published.terms]);
    console.log(`Updated only site ${row.id}; issued application snapshots retained. Backup: ${backup}`);
    await client.query('COMMIT');
  } else { await client.query('ROLLBACK'); }
} catch (error) { await client.query('ROLLBACK'); console.error(error.message); process.exitCode=1; }
finally { client.release(); await pool.end(); }
