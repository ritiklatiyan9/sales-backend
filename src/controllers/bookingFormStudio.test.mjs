import test from 'node:test';
import assert from 'node:assert/strict';
import { drawFixture } from '../test/drawFixture.mjs';
import { migrateBookingFormStudio } from '../migrations/027_booking_form_studio.js';
import { validateBookingTemplate } from '../services/bookingFormTemplate.js';
import * as studio from './bookingForm.controller.js';

const admin = {id:1,role:'admin'}, agent = {id:2,role:'agent'};
const call = (handler,{body={},params={siteId:1},user=admin}={}) => new Promise(resolve => handler({body,params,user},{statusCode:200,status(value){this.statusCode=value;return this;},json(data){resolve({status:this.statusCode,data});}},error => resolve({status:error.status || 500,data:{message:error.message}})));
const template = {
  form_title:'Booking Form', brand_name:'Site A', accent_color:'#234234', heading_font:'Georgia', body_font:'Arial', design:'classic',
  applicant_title:'Applicant', related_title:'Related parties', property_title:'Property & payment', kyc_title:'KYC',
  declarations_title:'Declarations', declarations:'1. Details. Please check all entries.', terms_title:'Terms', terms:'1. Payments. Keep the receipt.',
  office_title:'Office acceptance', acceptance_note:'I acknowledge the completed form.',
};

test('Booking Form Studio publication, isolation and permission boundaries', async t => {
  const f = await drawFixture();
  try {
    await f.db.exec(`CREATE TABLE user_sites(user_id INTEGER,site_id INTEGER); CREATE TABLE user_permissions(user_id INTEGER,module TEXT,can_read BOOLEAN,can_write BOOLEAN,can_update BOOLEAN,can_delete BOOLEAN); INSERT INTO user_sites VALUES(2,1);`);
    await migrateBookingFormStudio(f.pool); await migrateBookingFormStudio(f.pool);
    await f.query(`INSERT INTO project_settings(site_id,company_address,payment_terms,document_config) VALUES(1,'Site office','Existing payment terms',$1) ON CONFLICT(site_id) DO UPDATE SET company_address=EXCLUDED.company_address,payment_terms=EXCLUDED.payment_terms,document_config=EXCLUDED.document_config`,[JSON.stringify({booking_rules:'Existing site terms'})]);
    await t.test('designer imports the same company details and terms as the printed form', async () => {
      const source = (await call(studio.getFormStudio)).data.source_settings;
      assert.equal(source.company_address,'Site office');
      assert.equal(source.payment_terms,'Existing payment terms');
      assert.equal(source.document_config.booking_rules,'Existing site terms');
    });
    await t.test('validates styles, images, page limits and required wording', () => {
      assert.equal(validateBookingTemplate(template).form_title, 'Booking Form');
      for (const change of [{terms:'x'.repeat(3801)},{declarations:'x\n'.repeat(30)},{cover_image:'javascript:alert(1)'},{design:'unknown'},{accent_color:'red'},{extra:'value'}]) assert.throws(() => validateBookingTemplate({...template,...change}));
    });
    await t.test('drafts stay private until publication; stale writes cannot replace a design', async () => {
      assert.equal((await call(studio.getPublishedForm)).data.template, null);
      const saved = await call(studio.saveFormDraft,{body:{template,revision:0}});
      assert.equal(saved.status,200,JSON.stringify(saved.data)); assert.equal(saved.data.revision,1);
      assert.equal((await call(studio.getPublishedForm)).data.template,null);
      assert.equal((await call(studio.saveFormDraft,{body:{template,revision:0}})).status,409);
      assert.equal((await call(studio.publishForm,{body:{revision:2}})).status,409);
      assert.equal((await call(studio.publishForm,{body:{revision:1}})).status,200);
      assert.equal((await call(studio.getPublishedForm)).data.template.brand_name,'Site A');
      assert.equal((await call(studio.getPublishedForm,{params:{siteId:2}})).data.template,null);
      const draft = await call(studio.saveFormDraft,{body:{template:{...template,brand_name:'Unpublished'},revision:1}});
      assert.equal(draft.data.revision,2);
      assert.equal((await call(studio.getPublishedForm)).data.template.brand_name,'Site A');
      await call(studio.saveFormDraft,{body:{template:{...template,terms:''},revision:2}});
      assert.equal((await call(studio.publishForm,{body:{revision:3}})).status,400);
      assert.equal((await call(studio.getPublishedForm)).data.revision,1);
    });
    await t.test('assigned-site readers can print; studio actions need their own module permission', async () => {
      assert.equal((await call(studio.getPublishedForm,{user:agent})).status,200);
      assert.equal((await call(studio.getPublishedForm,{user:agent,params:{siteId:2}})).status,403);
      assert.equal((await call(studio.getFormStudio,{user:agent})).status,403);
      await f.query(`INSERT INTO user_permissions VALUES(2,'booking_form_studio',true,true,true,false)`);
      assert.equal((await call(studio.getFormStudio,{user:agent})).status,403);
      await f.query(`INSERT INTO user_permissions VALUES(2,'booking_document_studio',true,false,false,false)`);
      assert.equal((await call(studio.getFormStudio,{user:agent})).status,200);
      assert.equal((await call(studio.saveFormDraft,{user:agent,body:{template,revision:3}})).status,403);
      assert.equal((await call(studio.publishForm,{user:agent,body:{revision:3}})).status,403);
      await f.query(`UPDATE user_permissions SET can_write=true WHERE module='booking_document_studio'`);
      assert.equal((await call(studio.saveFormDraft,{user:agent,body:{template,revision:0}})).status,409);
      assert.equal((await call(studio.saveFormDraft,{user:agent,body:{template,revision:3}})).status,403);
    });
  } finally { await f.close(); }
});
