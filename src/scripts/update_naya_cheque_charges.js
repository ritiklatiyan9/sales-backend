import {writeFile} from 'node:fs/promises';
import pool from '../config/db.js';
import {validateApplicationTemplate,requirePublishableTemplate} from '../services/applicationFormTemplate.js';
import {NAYA_BAAZAR_PAYMENT_PLAN} from '../../../sales-dg-frontend/src/lib/nayaBaazarBookingForm.js';

const apply=process.argv.includes('--apply');
const expected=Number(process.argv.find(arg=>arg.startsWith('--revision='))?.split('=')[1]);
const paymentAnchor='A cheque, transfer or other payment is recognised as received only when the funds have cleared.';
const chequeSentence='Actual bank cheque-return charges shall be borne by the Applicant for each dishonoured cheque, including during the grace period; see clause 8.2.';
const previousDishonour='A dishonoured cheque, failed transfer or reversed payment shall remain unpaid until replacement funds have cleared. The original grace-end date continues to apply; an unsuccessful payment attempt does not restart or extend the 15-day grace period.';
function updateWording(template){
  if(!template.terms.includes(paymentAnchor))throw new Error('The payment clause changed; review it before applying this update.');
  const terms=template.terms.includes(chequeSentence)?template.terms:template.terms.replace(paymentAnchor,`${paymentAnchor} ${chequeSentence}`);
  const clauses=template.payment_plan?.grace_clauses;
  if(!clauses?.[0]||!clauses[1])throw new Error('Expected the current payment clauses; nothing changed.');
  if(!clauses[0].body.includes('no late or bounce charge shall apply.')&&clauses[0].body!==NAYA_BAAZAR_PAYMENT_PLAN.grace_clauses[0].body)throw new Error('The grace-period wording changed; review it before applying this update.');
  if(clauses[1].body!==previousDishonour&&clauses[1].body!==NAYA_BAAZAR_PAYMENT_PLAN.grace_clauses[1].body)throw new Error('The cheque clause changed; review it before applying this update.');
  return validateApplicationTemplate({...template,terms,payment_plan:{...template.payment_plan,grace_clauses:clauses.map((clause,index)=>index<2?{...clause,body:NAYA_BAAZAR_PAYMENT_PLAN.grace_clauses[index].body}:clause)}});
}
let client;
try{
  client=await pool.connect();await client.query('BEGIN');
  const {rows}=await client.query('SELECT t.*,s.name FROM application_form_templates t JOIN sites s ON s.id=t.site_id WHERE t.site_id=7 FOR UPDATE OF t');
  const row=rows[0];
  if(row?.name!=='Naya Baazar Unn Commercial'||!row.published)throw new Error('Expected the published Unn Naya Baazar form; nothing changed.');
  if(apply&&(!Number.isInteger(expected)||expected!==row.revision))throw new Error('The reviewed revision changed; nothing changed.');
  const draft=updateWording(row.draft),published=updateWording(row.published);
  requirePublishableTemplate(published);
  if(!apply){await client.query('ROLLBACK');console.log(JSON.stringify({site_id:7,revision:row.revision,ready:true}));}
  else{
    const {rows:settings}=await client.query('SELECT site_id,draw_terms FROM project_settings WHERE site_id=7 FOR UPDATE');
    const backup=`/private/tmp/naya-cheque-terms-before-${Date.now()}.json`;
    await writeFile(backup,JSON.stringify({template:row,settings:settings[0]}),{mode:0o600});
    const saved=await client.query(`UPDATE application_form_templates SET draft=$1,published=$2,revision=revision+1,published_revision=revision+1,updated_at=now(),published_at=now() WHERE site_id=7 AND revision=$3 RETURNING site_id,revision,published_revision`,[JSON.stringify(draft),JSON.stringify(published),expected]);
    if(saved.rowCount!==1)throw new Error('The reviewed revision changed; nothing changed.');
    await client.query(`INSERT INTO project_settings(site_id,draw_terms) VALUES(7,$1) ON CONFLICT(site_id) DO UPDATE SET draw_terms=EXCLUDED.draw_terms,updated_at=now()`,[published.terms]);
    await client.query('COMMIT');console.log(JSON.stringify({...saved.rows[0],cheque_charges_published:true,backup}));
  }
}catch(error){if(client)await client.query('ROLLBACK');console.error(error.message);process.exitCode=1;}finally{client?.release();await pool.end();}
