import {writeFile} from 'node:fs/promises';
import pool from '../config/db.js';
import {validateAgreementTemplate} from '../services/agreementTemplate.js';
import {agreementPageBodies} from '../../../sales-dg-frontend/src/lib/agreementStudio.js';
const apply=process.argv.includes('--apply');
let client;
try{
 client=await pool.connect();await client.query('BEGIN');
 const {rows:[row]}=await client.query('SELECT * FROM agreement_templates WHERE id=2 AND site_id=7 FOR UPDATE');
 const {rows:[application]}=await client.query('SELECT published,published_revision FROM application_form_templates WHERE site_id=7 FOR SHARE');
 if(row?.revision!==3||application?.published_revision!==20)throw new Error('The reviewed agreement or application revision changed.');
 const body=row.body.replace('<div>','<div class="ag-application-section">').replaceAll('<div class="page-break">','<div class="ag-application-section page-break">');
 if(agreementPageBodies(body).length!==8)throw new Error('Review the changed agreement page structure.');
 const design={...row.design,header_style:'application',heading_style:'application',heading_font:application.published.heading_font||'Georgia',body_font:'Arial',font_size:8.5,line_height:1.4,paragraph_gap:3,margin_mm:14,accent_color:'#203f36',ink_color:'#243b32',border:'none',justify:false,letterhead_brand:application.published.brand_name,letterhead_logo_url:application.published.logo_url,letterhead_contact_line:application.published.contact_line};
 validateAgreementTemplate({design,body},{partial:true});
 await writeFile('/private/tmp/unn-agreement-design.json',JSON.stringify(design),{mode:0o600});
 if(!apply){await client.query('ROLLBACK');console.log(JSON.stringify({ready:true,agreement_revision:row.revision,pages:8,wording_preserved:true}));}
 else{
  const backup=`/private/tmp/unn-agreement-style-before-${Date.now()}.json`;
  await writeFile(backup,JSON.stringify(row),{mode:0o600});
  const {rows:[saved]}=await client.query('UPDATE agreement_templates SET body=$1,design=$2,revision=revision+1,updated_at=now() WHERE id=2 AND site_id=7 RETURNING id,site_id,revision,is_default',[body,JSON.stringify(design)]);
  await client.query('COMMIT');console.log(JSON.stringify({...saved,wording_preserved:true,backup}));
 }
}catch(error){if(client)await client.query('ROLLBACK');console.error(error.message);process.exitCode=1;}finally{client?.release();await pool.end();}
