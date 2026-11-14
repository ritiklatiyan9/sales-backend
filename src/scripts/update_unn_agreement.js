import {writeFile} from 'node:fs/promises';
import pool from '../config/db.js';
import {validateAgreementTemplate} from '../services/agreementTemplate.js';
import {NAYA_BAAZAR_AGREEMENT} from '../../../sales-dg-frontend/src/lib/nayaBaazarAgreement.js';
const apply=process.argv.includes('--apply');
const expected=Number(process.argv.find(arg=>arg.startsWith('--application-revision='))?.split('=')[1]);
let client;
try{
 client=await pool.connect();await client.query('BEGIN');
 const {rows:[site]}=await client.query('SELECT id,name FROM sites WHERE id=7 FOR UPDATE');
 const {rows:[application]}=await client.query('SELECT published_revision,published FROM application_form_templates WHERE site_id=7 FOR SHARE');
 const {rows:existing}=await client.query('SELECT * FROM agreement_templates WHERE site_id=7 FOR UPDATE');
 if(site?.name!=='Naya Baazar Unn Commercial')throw new Error('The Unn site could not be verified.');
 if(application?.published_revision!==expected)throw new Error('The reviewed application revision changed.');
 if(!application.published.terms.includes('within 30 calendar days')||!application.published.payment_plan.rental_options[0].timeline.includes('after the written allotment date'))throw new Error('Review the changed application terms before updating the agreement.');
 const template=validateAgreementTemplate(NAYA_BAAZAR_AGREEMENT);
 if(existing.length)throw new Error('Unn now has a saved agreement. Review that format before updating it.');
 if(!apply){await client.query('ROLLBACK');console.log(JSON.stringify({site_id:7,application_revision:expected,existing_formats:0,ready:true,name:template.name,sections:8}));}
 else{
  const backup=`/private/tmp/unn-agreement-before-${Date.now()}.json`;
  await writeFile(backup,JSON.stringify({site,existing,application}),{mode:0o600});
  const {rows:[saved]}=await client.query(`INSERT INTO agreement_templates(site_id,name,preset,design,body,is_default) VALUES(7,$1,$2,$3,$4,true) RETURNING id,site_id,name,revision,is_default`,[template.name,template.preset,JSON.stringify(template.design),template.body]);
  await client.query('COMMIT');console.log(JSON.stringify({...saved,application_revision:expected,backup}));
 }
}catch(error){if(client)await client.query('ROLLBACK');console.error(error.message);process.exitCode=1;}finally{client?.release();await pool.end();}
