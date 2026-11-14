import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateApplicationTemplate, requirePublishableTemplate } from './applicationFormTemplate.js';

import { DEFENCE_GARDEN_PAYMENT_PLAN } from '../../../sales-dg-frontend/src/lib/defenceGardenPaymentPlan.js';
import { NAYA_BAAZAR_FORM_UPDATE } from '../../../sales-dg-frontend/src/lib/nayaBaazarBookingForm.js';

const template = JSON.parse(await readFile(new URL('../seeds/mount-valley-application.json', import.meta.url), 'utf8'));
const features = ['roads', 'courtyard', 'retail', 'landscape', 'lighting', 'access'].map(icon => ({ icon, title: icon, body: 'Project amenity.' }));

test('six commercial amenities retain their selected icons', () => {
  assert.deepEqual(validateApplicationTemplate({ ...template, features }).features, features);
  assert.deepEqual(validateApplicationTemplate(template).features, template.features);
});

test('amenities reject unsupported icons and more than six entries', () => {
  assert.throws(() => validateApplicationTemplate({ ...template, features: [...features, features[0]] }), /up to six/);
  assert.throws(() => validateApplicationTemplate({ ...template, features: [{ ...features[0], icon: 'unknown' }] }), /supported commercial amenity icon/);
  assert.throws(() => validateApplicationTemplate({ ...template, features: [{ ...features[0], body: 123 }] }), /Each highlight/);
});

test('commercial overview copy is optional, while the actual project name and artwork remain required', () => {
  const ready = { ...template, terms:'1. Scheme terms.', commercial_heading:'', commercial_description:'' };
  assert.doesNotThrow(() => requirePublishableTemplate(ready));
  assert.throws(() => requirePublishableTemplate({ ...ready, commercial_title:'  ' }), /Complete Commercial name before publishing/);
  assert.throws(() => requirePublishableTemplate({ ...ready, commercial_image:'' }), /Complete Commercial artwork before publishing/);
});

test('PDF payment details, dates, amounts and off switches survive template validation',()=>{
 const plan=structuredClone(DEFENCE_GARDEN_PAYMENT_PLAN);
 assert.deepEqual(validateApplicationTemplate({...template,payment_plan:plan}).payment_plan,plan);
 plan.enabled=false; plan.show_installments=false; plan.show_rental_options=false; plan.installments[0].enabled=false;
 assert.deepEqual(validateApplicationTemplate({...template,payment_plan:plan}).payment_plan,plan);
 assert.equal(validateApplicationTemplate(template).payment_plan,undefined);
});
test('payment plan rejects invalid amounts, dates, visibility and oversized content',()=>{
 const invalid=mutate=>{const plan=structuredClone(DEFENCE_GARDEN_PAYMENT_PLAN);mutate(plan);assert.throws(()=>validateApplicationTemplate({...template,payment_plan:plan}));};
 invalid(plan=>plan.enabled='false'); invalid(plan=>plan.installments[0].amount='-10'); invalid(plan=>plan.installments[0].amount='1.001');
 invalid(plan=>plan.installments[0].due_date='2027-02-30'); invalid(plan=>plan.booking_deposit='NaN'); invalid(plan=>plan.rental_clauses[0].body='x'.repeat(901));
 invalid(plan=>plan.installments[0].unknown='x'); invalid(plan=>plan.rental_options.push(plan.rental_options[0]));
});

test('updated PDF details retain their structured payment and refund content through publishing validation',()=>{
 const result=validateApplicationTemplate({...template,...NAYA_BAAZAR_FORM_UPDATE});
 assert.deepEqual(result.payment_plan,NAYA_BAAZAR_FORM_UPDATE.payment_plan);
 assert.equal(result.terms,NAYA_BAAZAR_FORM_UPDATE.terms);
 assert.doesNotThrow(()=>requirePublishableTemplate(result));
 for(const grace_days of [-1,1.5,91,'15'])assert.throws(()=>validateApplicationTemplate({...result,payment_plan:{...result.payment_plan,grace_days}}),/Grace period/);
 assert.throws(()=>validateApplicationTemplate({...result,payment_plan:{...result.payment_plan,payout_fields:[{label:'Bank',value:'',unknown:true}]}}),/Unknown payout field/);
});

test('document language persists explicitly and rejects unsupported bilingual modes',()=>{
 for(const document_language of ['en','en-hi'])assert.equal(validateApplicationTemplate({...template,document_language}).document_language,document_language);
 assert.equal(validateApplicationTemplate(template).document_language,undefined);
 for(const document_language of ['hi','auto','EN-HI',true,{}])assert.throws(()=>validateApplicationTemplate({...template,document_language}),/Choose English or English and Hindi/);
});

test('up to three ordered commercial renders survive validation and satisfy artwork publishing',()=>{
 const commercial_images=['/images/first.png','https://example.com/second.png','/images/third.png'];
 const validated=validateApplicationTemplate({...template,commercial_image:'',commercial_images});
 assert.deepEqual(validated.commercial_images,commercial_images);
 assert.doesNotThrow(()=>requirePublishableTemplate({...validated,terms:'1. Approved terms.'}));
 assert.throws(()=>requirePublishableTemplate({...validated,terms:'1. Approved terms.',commercial_images:[]}),/Commercial artwork/);
 for(const images of ['image.png',[...commercial_images,'/fourth.png'],[''],['javascript:alert(1)'],['//elsewhere.example/img.png'],[null]])assert.throws(()=>validateApplicationTemplate({...template,commercial_images:images}));
});
