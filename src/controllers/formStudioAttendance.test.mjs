import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { drawFixture } from '../test/drawFixture.mjs';
import { migrateFormStudioAttendance } from '../migrations/025_form_studio_attendance.js';
import { validateApplicationTemplate } from '../services/applicationFormTemplate.js';
import { checkInDraw, correctAttendance, attendanceToken } from '../services/drawAttendance.js';
import { todayIST } from '../services/drawWorkflow.js';
import * as studio from './applicationForm.controller.js';
import { listDrawAttendance } from './drawAttendance.controller.js';
import { createDraw, setDrawSettings } from './draw.controller.js';

const admin={id:1,role:'admin'},agent={id:2,role:'agent'};
const call=(handler,{body={},params={},query={},user=admin}={})=>new Promise(resolve=>handler({body,params,query,user},{statusCode:200,status(value){this.statusCode=value;return this;},json(data){resolve({status:this.statusCode,data});}},error=>resolve({status:error.status||500,data:{message:error.message}})));
const seed=JSON.parse(await readFile(new URL('../seeds/mount-valley-application.json',import.meta.url),'utf8'));
const template={...seed,terms:'1. Registration. Read your application carefully.\n\n2. Draw day. Keep your issued token.'};

test('site templates and attendance use isolated PostgreSQL',async t=>{
 const f=await drawFixture();
 try {
  await f.db.exec(`CREATE TABLE user_sites(user_id INTEGER,site_id INTEGER);CREATE TABLE user_permissions(user_id INTEGER,module TEXT,can_read BOOLEAN,can_write BOOLEAN,can_update BOOLEAN,can_delete BOOLEAN);INSERT INTO user_sites VALUES(2,1);`);
  await migrateFormStudioAttendance(f.pool);await migrateFormStudioAttendance(f.pool);
  await call(setDrawSettings,{body:{site_id:1,required_amount:5000,wait_days:10}});
  const created=await call(createDraw,{body:{site_id:1,phone:'9876543210',full_name:'Test Applicant',request_key:'attendance-fixture'}});
  assert.equal(created.status,201,JSON.stringify(created.data));const drawId=created.data.id;
  const date=todayIST();
  await f.query(`UPDATE draw_registrations SET slip_no='SLIP-TEST-0001',qr_token='test-qr',status='SLIP_ISSUED',terms_snapshot='Original issued terms',draw_opening_date=$1 WHERE id=$2`,[date,drawId]);
  await t.test('validates uploaded references and design input',()=>{
   assert.equal(validateApplicationTemplate(template).brand_name,template.brand_name);
   assert.throws(()=>validateApplicationTemplate({...template,commercial_image:'javascript:alert(1)'}));
   assert.throws(()=>validateApplicationTemplate({...template,heading_font:'unknown'}));
   assert.throws(()=>validateApplicationTemplate({...template,terms:'x'.repeat(4501)}));
   assert.throws(()=>validateApplicationTemplate({...template,unknown:'field'}));
  });
  await t.test('draft, publication and revision conflicts preserve issued snapshots',async()=>{
   let saved=await call(studio.saveFormDraft,{params:{siteId:1},body:{template,revision:0}});
   assert.equal(saved.status,200,JSON.stringify(saved.data));assert.equal(saved.data.revision,1);
   assert.equal((await call(studio.getPublishedForm,{params:{siteId:1}})).data.template,null);
   assert.equal((await call(studio.saveFormDraft,{params:{siteId:1},body:{template,revision:0}})).status,409);
   assert.equal((await call(studio.publishForm,{params:{siteId:1},body:{revision:99}})).status,409);
   assert.equal((await call(studio.publishForm,{params:{siteId:1},body:{revision:1}})).status,200);
   assert.equal((await call(studio.getPublishedForm,{params:{siteId:1}})).data.template.commercial_title,'Naya Baazar');
   assert.equal((await call(studio.getPublishedForm,{params:{siteId:2}})).data.template,null);
   assert.equal((await f.query('SELECT terms_snapshot FROM draw_registrations WHERE id=$1',[drawId])).rows[0].terms_snapshot,'Original issued terms');
   assert.equal((await f.query('SELECT draw_terms FROM project_settings WHERE site_id=1')).rows[0].draw_terms,template.terms);
   const draft={...template,commercial_title:'Draft only'};
   assert.equal((await call(studio.saveFormDraft,{params:{siteId:1},body:{template:draft,revision:1}})).status,200);
   assert.equal((await call(studio.getPublishedForm,{params:{siteId:1}})).data.template.commercial_title,'Naya Baazar');
  });
  await t.test('requires explicit module permissions and assigned site',async()=>{
   assert.equal((await call(studio.getFormStudio,{params:{siteId:1},user:agent})).status,403);
   assert.equal((await call(studio.getPublishedForm,{params:{siteId:1},user:agent})).status,200);
   assert.equal((await call(studio.getPublishedForm,{params:{siteId:2},user:agent})).status,403);
   await assert.rejects(()=>checkInDraw({user:agent,siteId:1,date,token:'test-qr'}),e=>e.status===403);
   await f.query(`INSERT INTO user_permissions VALUES(2,'booking_draw_attendance',true,true,false,false),(2,'booking_form_studio',true,false,false,false)`);
   assert.equal((await call(studio.getFormStudio,{params:{siteId:1},user:agent})).status,200);
   assert.equal((await call(studio.saveFormDraft,{params:{siteId:1},user:agent,body:{template,revision:2}})).status,403);
   await assert.rejects(()=>checkInDraw({user:agent,siteId:2,date,token:'test-qr'}),e=>e.status===403);
  });
  let attendance;
  await t.test('scanning marks arrival once without changing draw outcome or money',async()=>{
   assert.equal(attendanceToken('https://example.test/verify/draw?token=test-qr'),'test-qr');
   const first=await checkInDraw({user:agent,siteId:1,date,token:'https://example.test/verify/draw?token=test-qr'});attendance=first.attendance;
   assert.equal(first.already_present,false);assert.equal(first.registration.client_name,'Test Applicant');
   const replay=await checkInDraw({user:agent,siteId:1,date,token:'slip-test-0001'});
   assert.equal(replay.already_present,true);assert.equal(replay.attendance.id,attendance.id);
   assert.equal(String(replay.attendance.checked_in_at),String(attendance.checked_in_at));
   assert.equal((await f.query('SELECT count(*)::int AS n FROM draw_attendance_events')).rows[0].n,1);
   const row=(await f.query('SELECT status,(SELECT COALESCE(SUM(amount),0) FROM draw_payments WHERE draw_registration_id=$1) AS total_paid FROM draw_registrations WHERE id=$1',[drawId])).rows[0];
   assert.equal(row.status,'SLIP_ISSUED');assert.equal(Number(row.total_paid),0);
  });
  await t.test('rejects wrong dates, site, missing token and cancelled entries',async()=>{
   await assert.rejects(()=>checkInDraw({user:admin,siteId:1,date:'2000-01-01',token:'test-qr'}),e=>e.status===409);
   await assert.rejects(()=>checkInDraw({user:admin,siteId:2,date,token:'test-qr'}),e=>e.status===404);
   await assert.rejects(()=>checkInDraw({user:admin,siteId:1,date,token:'missing'}),e=>e.status===404);
   for(const status of ['CANCELLED','REGISTERED']){
    await f.query('UPDATE draw_registrations SET status=$1 WHERE id=$2',[status,drawId]);
    await assert.rejects(()=>checkInDraw({user:admin,siteId:1,date,token:'test-qr'}),e=>e.status===409);
   }
   await f.query("UPDATE draw_registrations SET status='SLIP_ISSUED',draw_opening_date='2030-01-01' WHERE id=$1",[drawId]);
   await assert.rejects(()=>checkInDraw({user:admin,siteId:1,date,token:'test-qr'}),e=>e.status===409);
   await f.query('UPDATE draw_registrations SET draw_opening_date=$1 WHERE id=$2',[date,drawId]);
  });
  await t.test('roster counts, search and correction audit are consistent',async()=>{
   const roster=()=>call(listDrawAttendance,{query:{site_id:1,date},user:agent});
   assert.deepEqual((await roster()).data.summary,{total:1,present:1,remaining:0});
   assert.equal((await call(listDrawAttendance,{query:{site_id:1,date,status:'remaining'}})).data.items.length,0);
   assert.equal((await call(listDrawAttendance,{query:{site_id:1,date,q:'Test Applicant'}})).data.total,1);
   await assert.rejects(()=>correctAttendance({user:agent,siteId:1,id:attendance.id,reason:'Incorrect scan'}),e=>e.status===403);
   await assert.rejects(()=>correctAttendance({user:admin,siteId:1,id:attendance.id,reason:''}),e=>e.status===400);
   await correctAttendance({user:admin,siteId:1,id:attendance.id,reason:'Incorrect scan'});
   assert.deepEqual((await roster()).data.summary,{total:1,present:0,remaining:1});
   assert.equal((await f.query("SELECT reason FROM draw_attendance_events WHERE action='CORRECTED'")).rows[0].reason,'Incorrect scan');
   const second=await checkInDraw({user:agent,siteId:1,date,token:'test-qr'});assert.equal(second.already_present,false);
   await f.query("UPDATE user_permissions SET can_read=false WHERE module='booking_draw_attendance'");
   await assert.rejects(()=>checkInDraw({user:agent,siteId:1,date,token:'test-qr'}),e=>e.status===403);
   assert.equal((await roster()).status,403);
  });
 } finally {await f.close();}
});
