import {writeFile} from 'node:fs/promises';
import pool from '../config/db.js';
import {validateApplicationTemplate,requirePublishableTemplate} from '../services/applicationFormTemplate.js';
import {professionalNayaBaazarWording} from '../../../sales-dg-frontend/src/lib/nayaBaazarBookingForm.js';

// Wording-only update for the requested site. Preserve draft design preferences,
// the published design and every issued registration's immutable terms snapshot.
const apply=process.argv.includes('--apply');
const expected=Number(process.argv.find(arg=>arg.startsWith('--revision='))?.split('=')[1]);
let client;
try {
  client=await pool.connect();
  await client.query('BEGIN');
  const {rows}=await client.query('SELECT t.*,s.name FROM application_form_templates t JOIN sites s ON s.id=t.site_id WHERE t.site_id=7 FOR UPDATE OF t');
  const row=rows[0];
  if(row?.name!=='Naya Baazar Unn Commercial'||!row.published)throw new Error('Expected the published Unn Naya Baazar form; nothing changed.');
  if(apply&&(!Number.isInteger(expected)||expected!==row.revision))throw new Error('The reviewed revision changed; nothing changed.');
  const draft=validateApplicationTemplate(professionalNayaBaazarWording(row.draft));
  const published=validateApplicationTemplate(professionalNayaBaazarWording(row.published));
  requirePublishableTemplate(published);
  const summary={site_id:7,revision:row.revision,apply,main_clauses:6,terms_characters:published.terms.length,draft_design:draft.design_style,published_design:published.design_style};
  console.log(JSON.stringify(summary));
  if(!apply){await client.query('ROLLBACK');}
  else {
    const {rows:settings}=await client.query('SELECT site_id,draw_terms FROM project_settings WHERE site_id=7 FOR UPDATE');
    const backup=`/private/tmp/naya-professional-terms-before-${Date.now()}.json`;
    await writeFile(backup,JSON.stringify({template:row,settings:settings[0]}),{mode:0o600});
    const saved=await client.query(`UPDATE application_form_templates SET draft=$1,published=$2,revision=revision+1,published_revision=revision+1,updated_at=now(),published_at=now() WHERE site_id=7 AND revision=$3 RETURNING site_id,revision,published_revision`,[JSON.stringify(draft),JSON.stringify(published),expected]);
    if(saved.rowCount!==1)throw new Error('The reviewed revision changed; nothing changed.');
    await client.query(`INSERT INTO project_settings(site_id,draw_terms) VALUES(7,$1) ON CONFLICT(site_id) DO UPDATE SET draw_terms=EXCLUDED.draw_terms,updated_at=now()`,[published.terms]);
    await client.query('COMMIT');
    console.log(JSON.stringify({...saved.rows[0],wording_published:true,backup}));
  }
}catch(error){if(client)await client.query('ROLLBACK');console.error(error.message);process.exitCode=1;}finally{client?.release();await pool.end();}
