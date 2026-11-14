// Opt the authorised Unn form into English/Hindi. Issued terms are never rewritten.
import {writeFile} from 'node:fs/promises';
import pool from '../config/db.js';
import {validateApplicationTemplate,requirePublishableTemplate} from '../services/applicationFormTemplate.js';
const apply=process.argv.includes('--apply');
const expected=Number(process.argv.find(arg=>arg.startsWith('--revision='))?.split('=')[1]);
let client;
try{
 client=await pool.connect();await client.query('BEGIN');
 const{rows:[row]}=await client.query('SELECT t.*,s.name FROM application_form_templates t JOIN sites s ON s.id=t.site_id WHERE t.site_id=7 FOR UPDATE OF t');
 if(row?.name!=='Naya Baazar Unn Commercial'||!row.published)throw new Error('Expected the published Unn Naya Baazar form; nothing changed.');
 if(apply&&(!Number.isInteger(expected)||expected!==row.revision))throw new Error('The reviewed revision changed; nothing changed.');
 for(const version of [row.draft,row.published])requirePublishableTemplate(validateApplicationTemplate({...version,document_language:'en-hi'}));
 const{rows:[draw]}=await client.query('SELECT id,site_id,terms_snapshot FROM draw_registrations WHERE id=46');
 if(draw?.site_id!==7)throw new Error('Application 46 is not on the expected site; nothing changed.');
 if(!apply){await client.query('ROLLBACK');console.log(JSON.stringify({site_id:7,revision:row.revision,ready:true,document_language:'en-hi',issued_terms_preserved:true}));}
 else{
  const backup=`/private/tmp/naya-bilingual-before-${Date.now()}.json`;
  await writeFile(backup,JSON.stringify({template:row,draw}),{mode:0o600});
  const saved=await client.query(`UPDATE application_form_templates SET draft=jsonb_set(draft,'{document_language}','"en-hi"'::jsonb),published=jsonb_set(published,'{document_language}','"en-hi"'::jsonb),revision=revision+1,published_revision=revision+1,updated_at=now(),published_at=now() WHERE site_id=7 AND revision=$1 RETURNING site_id,revision,published_revision,draft,published`,[expected]);
  if(saved.rowCount!==1)throw new Error('The reviewed revision changed; nothing changed.');
  for(const key of ['draft','published']){
   const after={...saved.rows[0][key]};delete after.document_language;const before={...row[key]};delete before.document_language;
   // JSONB key ordering is stable in both database results.
   if(JSON.stringify(after)!==JSON.stringify(before))throw new Error('Unexpected template change; rolling back.');
  }
  const{rows:[verified]}=await client.query('SELECT terms_snapshot FROM draw_registrations WHERE id=46');
  if(verified.terms_snapshot!==draw.terms_snapshot)throw new Error('Issued terms changed; rolling back.');
  await client.query('COMMIT');console.log(JSON.stringify({site_id:7,revision:saved.rows[0].revision,published_revision:saved.rows[0].published_revision,document_language:'en-hi',issued_terms_preserved:true,backup}));
 }
}catch(error){if(client)await client.query('ROLLBACK');console.error(error.message);process.exitCode=1;}finally{client?.release();await pool.end();}
