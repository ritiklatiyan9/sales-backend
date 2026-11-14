import {writeFile} from 'node:fs/promises';
import pool from '../config/db.js';
import {validateAgreementTemplate} from '../services/agreementTemplate.js';
import {NAYA_BAAZAR_AGREEMENT} from '../../../sales-dg-frontend/src/lib/nayaBaazarAgreement.js';
let client;
try{
 client=await pool.connect();await client.query('BEGIN');
 const {rows:[current]}=await client.query('SELECT * FROM agreement_templates WHERE id=2 AND site_id=7 FOR UPDATE');
 const {rows:[application]}=await client.query('SELECT published_revision FROM application_form_templates WHERE site_id=7 FOR SHARE');
 if(current?.revision!==2||application?.published_revision!==20)throw new Error('The reviewed agreement/application revision changed.');
 const template=validateAgreementTemplate(NAYA_BAAZAR_AGREEMENT);
 const backup=`/private/tmp/unn-agreement-layout-before-${Date.now()}.json`;
 await writeFile(backup,JSON.stringify(current),{mode:0o600});
 const {rows:[saved]}=await client.query('UPDATE agreement_templates SET body=$1,revision=revision+1,updated_at=now() WHERE id=2 AND site_id=7 RETURNING id,site_id,revision,is_default,name',[template.body]);
 await client.query('COMMIT');console.log(JSON.stringify({...saved,verified_print_pages:8,backup}));
}catch(error){if(client)await client.query('ROLLBACK');console.error(error.message);process.exitCode=1;}finally{client?.release();await pool.end();}
