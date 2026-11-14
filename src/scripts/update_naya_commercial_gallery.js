import {writeFile} from 'node:fs/promises';
import pool from '../config/db.js';
import {validateApplicationTemplate,requirePublishableTemplate} from '../services/applicationFormTemplate.js';
import {NAYA_BAAZAR_COMMERCIAL_GALLERY} from '../../../sales-dg-frontend/src/lib/nayaBaazarBookingForm.js';
const apply=process.argv.includes('--apply');
const expected=Number(process.argv.find(arg=>arg.startsWith('--revision='))?.split('=')[1]);
let client;
try{
 client=await pool.connect();await client.query('BEGIN');
 const{rows:[row]}=await client.query('SELECT t.*,s.name FROM application_form_templates t JOIN sites s ON s.id=t.site_id WHERE t.site_id=7 FOR UPDATE OF t');
 if(row?.name!=='Naya Baazar Unn Commercial'||!row.published)throw new Error('Expected the published Unn Naya Baazar form; nothing changed.');
 if(apply&&(!Number.isInteger(expected)||expected!==row.revision))throw new Error('The reviewed revision changed; nothing changed.');
 for(const version of [row.draft,row.published])requirePublishableTemplate(validateApplicationTemplate({...version,commercial_images:NAYA_BAAZAR_COMMERCIAL_GALLERY}));
 if(!apply){await client.query('ROLLBACK');console.log(JSON.stringify({site_id:7,revision:row.revision,ready:true,commercial_images:NAYA_BAAZAR_COMMERCIAL_GALLERY}));}
 else{
  const backup=`/private/tmp/naya-gallery-before-${Date.now()}.json`;
  await writeFile(backup,JSON.stringify({template:row}),{mode:0o600});
  const saved=await client.query(`UPDATE application_form_templates SET draft=jsonb_set(draft,'{commercial_images}',$1::jsonb),published=jsonb_set(published,'{commercial_images}',$1::jsonb),revision=revision+1,published_revision=revision+1,updated_at=now(),published_at=now() WHERE site_id=7 AND revision=$2 RETURNING site_id,revision,published_revision,draft,published`,[JSON.stringify(NAYA_BAAZAR_COMMERCIAL_GALLERY),expected]);
  if(saved.rowCount!==1)throw new Error('The reviewed revision changed; nothing changed.');
  for(const key of ['draft','published']){
   const before={...row[key]},after={...saved.rows[0][key]};delete before.commercial_images;delete after.commercial_images;
   if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('Unexpected template change; rolling back.');
  }
  await client.query('COMMIT');console.log(JSON.stringify({site_id:7,revision:saved.rows[0].revision,published_revision:saved.rows[0].published_revision,images_published:3,backup}));
 }
}catch(error){if(client)await client.query('ROLLBACK');console.error(error.message);process.exitCode=1;}finally{client?.release();await pool.end();}
