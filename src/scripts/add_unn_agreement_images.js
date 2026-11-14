import {writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import pool from '../config/db.js';
import {validateAgreementTemplate} from '../services/agreementTemplate.js';
import {agreementProjectOverview} from '../../../sales-dg-frontend/src/lib/agreementProjectOverview.js';
import {agreementPageBodies} from '../../../sales-dg-frontend/src/lib/agreementStudio.js';
const apply=process.argv.includes('--apply');
let client;
try{
 client=await pool.connect();await client.query('BEGIN');
 const {rows:[row]}=await client.query('SELECT * FROM agreement_templates WHERE id=2 AND site_id=7 FOR UPDATE');
 const {rows:[application]}=await client.query('SELECT published,published_revision FROM application_form_templates WHERE site_id=7 FOR SHARE');
 if(row?.revision!==4||application?.published_revision!==20)throw new Error('The reviewed agreement or application revision changed.');
 if(agreementPageBodies(row.body).length!==8)throw new Error('Review the changed agreement page structure.');
 const design={...row.design,show_applicant_photo:true,show_project_overview:true,project_overview:agreementProjectOverview(application.published)};
 validateAgreementTemplate({design},{partial:true});
 await writeFile('/private/tmp/unn-agreement-design.json',JSON.stringify(design),{mode:0o600});
 const bodyHash=createHash('sha256').update(row.body).digest('hex');
 if(!apply){await client.query('ROLLBACK');console.log(JSON.stringify({ready:true,agreement_revision:row.revision,project_images:design.project_overview.commercial_images.length,amenities:design.project_overview.features.length,pages:9,wording_sha256:bodyHash}));}
 else{
  const backup=`/private/tmp/unn-agreement-images-before-${Date.now()}.json`;
  await writeFile(backup,JSON.stringify(row),{mode:0o600});
  const {rows:[saved]}=await client.query('UPDATE agreement_templates SET design=$1,revision=revision+1,updated_at=now() WHERE id=2 AND site_id=7 RETURNING id,site_id,revision,is_default,body',[JSON.stringify(design)]);
  if(saved.body!==row.body)throw new Error('Agreement wording changed unexpectedly.');
  await client.query('COMMIT');console.log(JSON.stringify({id:saved.id,site_id:saved.site_id,revision:saved.revision,is_default:saved.is_default,project_images:3,wording_preserved:true,backup}));
 }
}catch(error){if(client)await client.query('ROLLBACK');console.error(error.message);process.exitCode=1;}finally{client?.release();await pool.end();}
