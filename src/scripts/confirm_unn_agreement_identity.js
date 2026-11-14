import {writeFile} from 'node:fs/promises';
import pool from '../config/db.js';
import {validateAgreementTemplate} from '../services/agreementTemplate.js';
import {validateApplicationTemplate} from '../services/applicationFormTemplate.js';
import {NAYA_BAAZAR_AGREEMENT} from '../../../sales-dg-frontend/src/lib/nayaBaazarAgreement.js';
const oldName='Narayan Landmark Developers Pvt Ltd',legalName='Narayana Landmark Developers Pvt. Ltd.';
let client;
try{
 client=await pool.connect();await client.query('BEGIN');
 const {rows:[agreement]}=await client.query('SELECT * FROM agreement_templates WHERE id=2 AND site_id=7 FOR UPDATE');
 const {rows:[application]}=await client.query('SELECT * FROM application_form_templates WHERE site_id=7 FOR UPDATE');
 const {rows:[settings]}=await client.query('SELECT site_id,company_legal_name,company_brand_name,company_address,company_city,company_phone,company_email,company_website,logo_url,draw_terms FROM project_settings WHERE site_id=7 FOR UPDATE');
 if(agreement?.revision!==1||application?.revision!==19||settings?.company_legal_name!==legalName)throw new Error('The reviewed agreement, application or confirmed company name changed.');
 const template=validateAgreementTemplate(NAYA_BAAZAR_AGREEMENT);
 const revise=value=>validateApplicationTemplate({...value,legal_name:legalName,terms:value.terms.replaceAll(oldName,legalName)});
 const draft=revise(application.draft),published=revise(application.published);
 const backup=`/private/tmp/unn-identity-before-${Date.now()}.json`;
 await writeFile(backup,JSON.stringify({agreement,application,settings}),{mode:0o600});
 await client.query('UPDATE agreement_templates SET body=$1,revision=revision+1,updated_at=now() WHERE id=2 AND site_id=7',[template.body]);
 await client.query('UPDATE application_form_templates SET draft=$1,published=$2,revision=revision+1,published_revision=revision+1,updated_at=now(),published_at=now() WHERE site_id=7',[JSON.stringify(draft),JSON.stringify(published)]);
 await client.query('UPDATE project_settings SET draw_terms=$1,updated_at=now() WHERE site_id=7',[published.terms]);
 await client.query('COMMIT');
 await writeFile('/private/tmp/unn-agreement-preview-settings.json',JSON.stringify(settings),{mode:0o600});
 console.log(JSON.stringify({agreement_id:2,agreement_revision:2,application_revision:20,legal_name:legalName,backup}));
}catch(error){if(client)await client.query('ROLLBACK');console.error(error.message);process.exitCode=1;}finally{client?.release();await pool.end();}
