import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { migrateMobilePush } from '../migrations/045_mobile_push.js';
import { postingPolicySql } from '../test/mobilePostingPolicy.fixture.mjs';
import { clientIdentityKey } from './clientPortal.service.js';
import { createMobilePushDevices, createMobilePushWorker, createMobilePushCycle, pushMessage, readMobilePushServiceAccount, validateMobilePushProject, REMINDER_SCAN_INTERVAL_MS } from './mobilePush.service.js';
process.env.CLIENT_PORTAL_IDENTITY_SECRET='isolated-stable-client-identity-secret';

const token = 'test_firebase_token_1234567890';
test('server credential file is read by absolute path and fails closed', t => {
 const dir = mkdtempSync(join(tmpdir(), 'mra-fcm-test-'));
 t.after(() => rmSync(dir, { recursive: true, force: true }));
 const file = join(dir, 'service-account.json');
 const account = {project_id:'test-project', client_email:'test@example.invalid', private_key:'fictional'};
 writeFileSync(file, JSON.stringify(account));
 assert.deepEqual(readMobilePushServiceAccount({MRA_FCM_SERVICE_ACCOUNT_FILE:file}), account);
 assert.deepEqual(readMobilePushServiceAccount({MRA_FCM_SERVICE_ACCOUNT_B64:Buffer.from(JSON.stringify(account)).toString('base64')}), account);
 assert.throws(() => readMobilePushServiceAccount({MRA_FCM_SERVICE_ACCOUNT_FILE:'relative.json', MRA_FCM_SERVICE_ACCOUNT_JSON:JSON.stringify(account)}));
 assert.throws(() => readMobilePushServiceAccount({MRA_FCM_SERVICE_ACCOUNT_FILE:join(dir,'missing.json'), MRA_FCM_SERVICE_ACCOUNT_JSON:JSON.stringify(account)}));
 writeFileSync(file, '{bad json');
 assert.throws(() => readMobilePushServiceAccount({MRA_FCM_SERVICE_ACCOUNT_FILE:file}));
});

test('the sender refuses credentials for a different Firebase app project',()=>{
 assert.equal(validateMobilePushProject({project_id:'myrealassets-380f8'},{}),'myrealassets-380f8');
 assert.throws(()=>validateMobilePushProject({project_id:'defencegardenbooking'},{}),/project mismatch/);
 assert.equal(validateMobilePushProject({project_id:'isolated-test-project'},{MRA_FCM_PROJECT_ID:'isolated-test-project'}),'isolated-test-project');
 assert.throws(()=>validateMobilePushProject({project_id:'myrealassets-380f8'},{MRA_FCM_PROJECT_ID:'isolated-test-project'}),/project mismatch/);
});

test('installment alerts use the OS notification payload and reminder channel without exposing account data', () => {
 const now=Date.parse('2026-11-07T04:00:00Z');
 for (const offset of [3,1,0]) {
   const message=pushMessage('installment',{reminderOffset:offset,now});
   assert.deepEqual(message.data,{type:'installment'});
   assert.equal(message.notification.title,'Installment reminder');
   assert.equal(message.android.priority,'high');
   assert.equal(message.android.notification.channelId,'installment_reminders');
   assert.equal(message.android.notification.priority,'high');
   assert.equal(message.android.notification.sound,'default');
   assert.equal(message.android.notification.tag,'installment_reminder');
   assert.equal(now+message.android.ttl,Date.parse('2026-11-07T23:59:59+05:30'));
   assert.equal(message.apns.headers['apns-push-type'],'alert');
   assert.equal(message.apns.headers['apns-priority'],'10');
   assert.equal(message.apns.headers['apns-expiration'],String(Date.parse('2026-11-07T23:59:59+05:30')/1000));
   assert.equal(message.apns.payload.aps.sound,'default');
 }
 assert.match(pushMessage('installment',{reminderOffset:0,now}).notification.body,/due today/);
 assert.match(pushMessage('installment',{reminderOffset:1,now}).notification.body,/due tomorrow/);
 assert.equal(pushMessage('payment').android.notification.channelId,'property_activity');
});

test('worker scans throughout the day for late registrations and plan changes without scanning every queue poll', async () => {
 let time=0,date='2026-11-07',scans=0,expansions=0,dispatches=0;
 const queries=[];
 const cycle=createMobilePushCycle({query:async sql=>{queries.push(sql);}}, {
   enqueueReminders:async()=>{scans++;},
   expandOne:async()=>{expansions++;return false;},
   dispatchOne:async()=>{dispatches++;return false;},
 },{now:()=>time,today:()=>date});
 await cycle();
 assert.equal(scans,1);
 assert.equal(queries.length,2);
 time=60_000;
 await cycle();
 assert.equal(scans,1);
 time=REMINDER_SCAN_INTERVAL_MS;
 await cycle();
 assert.equal(scans,2,'same-day clients and corrected plans get another scan');
 date='2026-11-08';
 await cycle();
 assert.equal(scans,3,'India midnight starts the next reminder day immediately');
 assert.equal(queries.length,4,'retention cleanup remains daily');
 assert.equal(expansions,4);
 assert.equal(dispatches,4);
});

test('an incomplete reminder scan still drains deliveries and retries at the next poll',async()=>{
 let scans=0,dispatches=0;
 const cycle=createMobilePushCycle({query:async()=>{}},{
   enqueueReminders:async()=>{scans++;if(scans===1)throw new Error('REMINDER_SCAN_INCOMPLETE');},
   expandOne:async()=>false,
   dispatchOne:async()=>{dispatches++;return false;},
 },{now:()=>0,today:()=> '2026-11-07'});
 await assert.rejects(cycle(),/REMINDER_SCAN_INCOMPLETE/);
 assert.equal(dispatches,1);
 await cycle();
 assert.equal(scans,2);
 assert.equal(dispatches,2);
});

async function reminderFixture(t) {
 const db=new PGlite();
 t.after(()=>db.close());
 await db.exec(`CREATE TABLE sites(id integer PRIMARY KEY,name text,code text);
 CREATE TABLE members(id integer PRIMARY KEY,site_id integer,full_name text,phone text,aadhar_no text,member_type text,member_types text[],is_active boolean DEFAULT true,email text,pan_no text);
 CREATE TABLE kyc_cases(id integer PRIMARY KEY,client_member_id integer,site_id integer,status text);
 CREATE TABLE booking_client_accounts(id integer PRIMARY KEY,phone text,identity_key text,password_hash text,password_changed boolean,token_version integer DEFAULT 0,is_active boolean DEFAULT true);
 CREATE TABLE booking_client_members(account_id integer,member_id integer);
 CREATE TABLE plots(id integer PRIMARY KEY,site_id integer,plot_no text,plot_size numeric,sale_price numeric,booking_date date,status text,buyer_member_id integer);
 CREATE TABLE bookings(id integer PRIMARY KEY,site_id integer,plot_id integer,client_member_id integer,status text);
 CREATE TABLE plot_installments(id integer PRIMARY KEY,plot_id integer,installment_name text,amount numeric,due_date date,sort_order integer,status text DEFAULT 'pending');
 CREATE TABLE plot_payments(id integer PRIMARY KEY,site_id integer,plot_id integer,amount numeric,date date,payment_type text,status text,cheque_status text,reference text);
 CREATE TABLE plot_installment_payments(id integer PRIMARY KEY,plot_id integer,installment_id integer,amount numeric,payment_date date,payment_mode text,status text,cheque_status text,reference text);
 INSERT INTO sites VALUES(1,'Private Site','S');
 INSERT INTO members(id,site_id,full_name,phone,aadhar_no,member_type) VALUES(1,1,'Owner','9876500001','234567890123','CLIENT'),(2,1,'Other','9876500002','345678901234','CLIENT');
 INSERT INTO kyc_cases VALUES(1,1,1,'VERIFIED'),(2,2,1,'VERIFIED');
 INSERT INTO booking_client_members VALUES(1,1),(2,2);
 INSERT INTO plots VALUES(1,1,'PRIVATE-A1',100,1000,'2026-01-01','BOOKED',1);
 INSERT INTO plot_installments VALUES(1,1,'Private final plan',1000,'2026-11-10',1,'pending');`);
 await db.query("INSERT INTO booking_client_accounts VALUES(1,'9876500001',$1,'x',true,0,true),(2,'9876500002',$2,'x',true,0,true)",[clientIdentityKey('234567890123'),clientIdentityKey('345678901234')]);
 await db.exec(postingPolicySql);
 const adapter={query:(...args)=>db.query(...args),connect:async()=>({query:(...args)=>db.query(...args),release(){}})};
 await migrateMobilePush(adapter);
 return {db,adapter};
}

test('reminders reach late devices once at three days, one day and due day without a live app session',async t=>{
 const {db,adapter}=await reminderFixture(t);
 const devices=createMobilePushDevices(adapter), sent=[];
 let date='2026-11-07';
 const worker=createMobilePushWorker(adapter,{send:async message=>sent.push(message),today:()=>date});
 const drain=async()=>{while(await worker.expandOne());while(await worker.dispatchOne());};
 await worker.enqueueReminders();
 assert.equal((await db.query('SELECT count(*)::int AS n FROM booking_mobile_push_events')).rows[0].n,0);
 await devices.register({accountId:1,version:0},{token,platform:'android'});
 await worker.enqueueReminders();await drain();
 assert.equal(sent.length,1,'registration after the first scan still gets the current reminder');
 assert.equal(sent[0].android.notification.channelId,'installment_reminders');
 assert.ok(!JSON.stringify(sent[0]).includes('PRIVATE-A1'));
 await worker.enqueueReminders();await drain();
 assert.equal(sent.length,1,'repeated scans do not resend an accepted device delivery');
 const lateToken='test_firebase_late_token_1234567890';
 await devices.register({accountId:1,version:0},{token:lateToken,platform:'android'});
 await worker.enqueueReminders();await drain();
 assert.equal(sent.length,2);
 assert.equal(sent[1].token,lateToken,'a new token can receive an already-expanded current-day reminder');
 for(const next of ['2026-11-08','2026-11-09','2026-11-10','2026-11-11']){
   date=next;
   await worker.enqueueReminders();await worker.enqueueReminders();await drain();
 }
 assert.equal(sent.length,6,'only three reminder days, one delivery on each device per day');
 assert.deepEqual((await db.query("SELECT reminder_offset FROM booking_mobile_push_events WHERE kind='installment' ORDER BY id")).rows.map(row=>row.reminder_offset),[3,1,0]);
 assert.equal(sent.filter(message=>/due today/.test(message.notification.body)).length,2);
 assert.equal(sent.filter(message=>/due tomorrow/.test(message.notification.body)).length,2);
});

test('reminders recheck payment, due date, current ownership and token account before delivery',async t=>{
 const {db,adapter}=await reminderFixture(t);
 const devices=createMobilePushDevices(adapter),sent=[];
 await devices.register({accountId:1,version:0},{token,platform:'android'});
 const worker=createMobilePushWorker(adapter,{send:async message=>sent.push(message),today:()=> '2026-11-07'});
 const drain=async()=>{while(await worker.expandOne());while(await worker.dispatchOne());};
 await worker.enqueueReminders();
 await db.exec("UPDATE plot_installments SET due_date='2026-11-20' WHERE id=1");
 await drain();
 assert.equal(sent.length,0,'due-date edits invalidate an already queued reminder');
 await db.exec("UPDATE plot_installments SET due_date='2026-11-08' WHERE id=1");
 await worker.enqueueReminders();
 await worker.expandOne();
 await devices.register({accountId:2,version:0},{token,platform:'android'});
 await drain();
 assert.equal(sent.length,0,'a token moved to another account cannot receive the previous account reminder');
 await devices.register({accountId:1,version:0},{token,platform:'android'});
 await db.exec("UPDATE plot_installments SET due_date='2026-11-07' WHERE id=1");
 await worker.enqueueReminders();await worker.expandOne();
 await db.exec("INSERT INTO plot_payments VALUES(1,1,1,1000,current_date,'BANK','approved',NULL,'PAID')");
 await drain();
 assert.equal(sent.filter(message=>message.data.type==='installment').length,0,'fully paid installments do not remind');
});
test('transactional shared-ledger push queue respects identity, posting and reminder balance', async t => {
 const db = new PGlite();
 t.after(() => db.close());
 await db.exec(`CREATE TABLE sites(id integer PRIMARY KEY,name text,code text);
 CREATE TABLE members(id integer PRIMARY KEY,site_id integer,full_name text,phone text,aadhar_no text,member_type text,member_types text[],is_active boolean DEFAULT true,email text,pan_no text);
 CREATE TABLE kyc_cases(id integer PRIMARY KEY,client_member_id integer,site_id integer,status text);
 CREATE TABLE booking_client_accounts(id integer PRIMARY KEY,phone text,identity_key text,password_hash text,password_changed boolean,token_version integer DEFAULT 0,is_active boolean DEFAULT true);
 CREATE TABLE booking_client_members(account_id integer,member_id integer);
 CREATE TABLE plots(id integer PRIMARY KEY,site_id integer,plot_no text,plot_size numeric,sale_price numeric,booking_date date,status text,buyer_member_id integer);
 CREATE TABLE bookings(id integer PRIMARY KEY,site_id integer,plot_id integer,client_member_id integer,status text);
 CREATE TABLE plot_installments(id integer PRIMARY KEY,plot_id integer,installment_name text,amount numeric,due_date date,sort_order integer,status text DEFAULT 'pending');
 CREATE TABLE plot_payments(id integer PRIMARY KEY,site_id integer,plot_id integer,amount numeric,date date,payment_type text,status text,cheque_status text,reference text);
 CREATE TABLE plot_installment_payments(id integer PRIMARY KEY,plot_id integer,installment_id integer,amount numeric,payment_date date,payment_mode text,status text,cheque_status text,reference text);
 INSERT INTO sites VALUES(1,'Site','S');
 INSERT INTO members(id,site_id,full_name,phone,aadhar_no,member_type) VALUES(1,1,'Owner','9876500001','234567890123','CLIENT'),(2,1,'Other','9876500002','345678901234','CLIENT');
 INSERT INTO kyc_cases VALUES(1,1,1,'VERIFIED'),(2,2,1,'VERIFIED');
 INSERT INTO booking_client_members VALUES(1,1),(2,2);
 INSERT INTO plots VALUES(1,1,'A1',100,1000,'2026-01-01','BOOKED',1);
 INSERT INTO plot_installments VALUES(1,1,'Final',1000,'2026-11-01',1,'pending');`);
 await db.query("INSERT INTO booking_client_accounts VALUES(1,'9876500001',$1,'x',true,0,true),(2,'9876500002',$2,'x',true,0,true)",[clientIdentityKey('234567890123'),clientIdentityKey('345678901234')]);
 await db.exec(postingPolicySql);
 const adapter={query:(...args)=>db.query(...args),connect:async()=>({query:(...args)=>db.query(...args),release(){}})};
 await migrateMobilePush(adapter); await migrateMobilePush(adapter);
 // A broken notification outbox must not block the shared financial ledger.
 // The always-false check simulates a permissions/storage/constraint failure.
 await db.exec(`ALTER TABLE booking_mobile_push_events ADD CONSTRAINT simulate_outbox_failure CHECK (false);
   INSERT INTO plot_payments VALUES(98,1,1,1,current_date,'CASH','approved',NULL,'synthetic');
   UPDATE plot_payments SET amount=2 WHERE id=98;`);
 assert.equal((await db.query('SELECT amount::int AS n FROM plot_payments WHERE id=98')).rows[0].n,2);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM booking_mobile_push_events')).rows[0].n,0);
 await db.exec(`DELETE FROM plot_payments WHERE id=98;
   ALTER TABLE booking_mobile_push_events DROP CONSTRAINT simulate_outbox_failure`);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM plot_payments WHERE id=98')).rows[0].n,0);
 const devices=createMobilePushDevices(adapter);
 await devices.register({accountId:1,version:0},{token,platform:'android'});
 await devices.register({accountId:2,version:0},{token:'other_firebase_token_1234567890',platform:'android'});
 await assert.rejects(devices.register({accountId:1,version:0},{token:'invalid',platform:'android'}),{statusCode:400});
 await devices.unregister({accountId:2,version:0},{token});
 assert.equal((await db.query('SELECT count(*)::int AS n FROM booking_mobile_push_devices')).rows[0].n,2);
 await db.exec(`BEGIN; INSERT INTO plot_payments VALUES(99,1,1,1,current_date,'CASH','approved',NULL,'rollback'); ROLLBACK`);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM booking_mobile_push_events')).rows[0].n,0);
 await db.exec(`INSERT INTO plot_payments VALUES(1,1,1,100,current_date,'CASH','pending',NULL,'cash');
 INSERT INTO plot_payments VALUES(2,1,1,-10,current_date,'CASH','pending',NULL,'refund');
 INSERT INTO plot_installment_payments VALUES(1,1,1,50,current_date,'CHEQUE','pending','PENDING','cheque');`);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM booking_mobile_push_events')).rows[0].n,1);
 const sent=[]; const worker=createMobilePushWorker(adapter,{send:async msg=>sent.push(msg),today:()=> '2026-10-29'});
 await worker.expandOne(); await worker.dispatchOne();
 assert.equal(sent.length,1); assert.equal(sent[0].token,token); assert.equal(sent[0].data.type,'payment');
 assert.ok(!JSON.stringify(sent[0]).includes('100')); assert.ok(!JSON.stringify(sent[0]).includes('A1'));
 await db.exec("UPDATE plot_payments SET status='approved' WHERE id=2; UPDATE plot_installment_payments SET status='approved',cheque_status='CLEARED' WHERE id=1");
 while(await worker.expandOne()); while(await worker.dispatchOne());
 assert.deepEqual(sent.map(x=>x.data.type),['payment','refund','payment']);
 await worker.enqueueReminders(); await worker.enqueueReminders();
 assert.equal((await db.query("SELECT count(*)::int AS n FROM booking_mobile_push_events WHERE kind='installment'")).rows[0].n,1);
 while(await worker.expandOne()); while(await worker.dispatchOne());
 assert.equal(sent.at(-1).data.type,'installment');
 await db.exec(`UPDATE plot_payments SET amount=-100,status='approved' WHERE id=1`);
 while(await worker.expandOne()); while(await worker.dispatchOne());
 assert.equal(sent.at(-1).data.type,'refund', 'a posted payment changed to a refund sends the refund notice');
 await db.exec(`UPDATE plot_payments SET amount=100,status='approved' WHERE id=1`);
 while(await worker.expandOne()); while(await worker.dispatchOne());
 assert.equal(sent.at(-1).data.type,'payment', 'a posted refund changed to a payment sends the payment notice');
 await db.exec(`UPDATE plot_payments SET status='rejected' WHERE id=1; DELETE FROM plot_installment_payments WHERE id=1`);
 while(await worker.expandOne()); while(await worker.dispatchOne());
 assert.equal(sent.length,8);
 assert.equal(sent.at(-1).data.type,'payment');
 assert.match(sent.at(-1).notification.body,/activity has changed/);
 await db.exec(`INSERT INTO plot_payments VALUES(3,1,1,25,current_date,'CASH','approved',NULL,'later')`);
 await worker.expandOne();
 await db.exec('UPDATE plots SET buyer_member_id=2 WHERE id=1');
 await worker.dispatchOne();
 assert.equal(sent.length,8, 'ownership is rechecked after queue expansion');
 for (const [index,status] of ['CANCELLED','RESALE'].entries()) {
   await db.query('UPDATE plots SET buyer_member_id=1,status=$1 WHERE id=1',[status]);
   await db.query("INSERT INTO plot_payments VALUES($1,1,1,25,current_date,'CASH','approved',NULL,'withheld')",[10+index]);
   while(await worker.expandOne()); while(await worker.dispatchOne());
   assert.equal(sent.length,8, `${status} never sends activity to the previous client`);
 }
 await db.exec("UPDATE plots SET status='BOOKED' WHERE id=1");
 await db.exec(`UPDATE plots SET buyer_member_id=1 WHERE id=1; UPDATE booking_client_accounts SET token_version=1 WHERE id=1; INSERT INTO plot_payments VALUES(4,1,1,25,current_date,'CASH','approved',NULL,'later')`);
 while(await worker.expandOne()); while(await worker.dispatchOne());
 assert.equal(sent.length,8);
 assert.deepEqual(Object.keys(pushMessage('payment').data),['type']);
});

test('device routes require an authenticated, fully set-up client and scope operations to its session', async () => {
  const {createMobilePortalRouter}=await import('../routes/mobilePortal.routes.js');
  const calls=[];
  const router=createMobilePortalRouter({getSession:async token => {
    if(token==='setup') return {accountId:1,version:2,setupRequired:true};
    if(token==='valid') return {accountId:1,version:2};
    throw Object.assign(new Error('Please sign in again.'),{statusCode:401});
  }},{isEnabled:()=>true,pushDevices:{register:async(s,b)=>calls.push(['register',s,b]),unregister:async(s,b)=>calls.push(['unregister',s,b])}});
  const invoke=(method,auth,body)=>new Promise((resolve,reject)=>{
    const req={method,url:'/device-tokens',path:'/device-tokens',body,ip:'127.0.0.1',headers:auth?{authorization:`Bearer ${auth}`}:{},get(n){return this.headers[n.toLowerCase()];}};
    const res={statusCode:200,headers:{},set(k,v){this.headers[k]=v;return this;},status(n){this.statusCode=n;return this;},json(value){resolve({status:this.statusCode,body:value,headers:this.headers});}};
    router.handle(req,res,e=>reject(e||new Error('unmatched')));
  });
  assert.equal((await invoke('POST',null,{token,platform:'android'})).status,401);
  assert.equal((await invoke('POST','setup',{token,platform:'android'})).status,403);
  const result=await invoke('POST','valid',{token,platform:'android'});
  assert.deepEqual(result.body,{ok:true}); assert.equal(result.headers['Cache-Control'],'private, no-store');
  assert.deepEqual((await invoke('DELETE','valid',{token})).body,{ok:true});
  assert.deepEqual(calls.map(x=>x[0]),['register','unregister']);
  assert.equal(calls[0][1].accountId,1);
});

test('global notification status is super-admin-only and does not expose token material', async () => {
 const {createMobileNotificationsRouter}=await import('../routes/mobileNotifications.routes.js');
 let role='admin'; let queryCount=0;
 const router=createMobileNotificationsRouter({
   authenticate:(req,_res,next)=>{req.user={role};next();},
   db:{query:async()=>{queryCount++;return {rows:[{devices:2,pending:1,failed:0}]};}},
   enabled:()=>true,messaging:()=>({}),
 });
 const invoke=()=>new Promise((resolve,reject)=>{
   const req={method:'GET',url:'/status',headers:{}};
   const res={statusCode:200,set(){return this;},status(n){this.statusCode=n;return this;},json(body){resolve({status:this.statusCode,body});}};
   router.handle(req,res,e=>reject(e||new Error('unmatched')));
 });
 assert.equal((await invoke()).status,403); assert.equal(queryCount,0);
 role='sub_admin'; assert.equal((await invoke()).status,403); assert.equal(queryCount,0);
 role='super_admin'; const response=await invoke();
 assert.deepEqual(response.body,{enabled:true,firebaseConfigured:true,schemaReady:true,pendingEvents:1,registeredDevices:2,failedDeliveries:0,workerMode:'in-process'});
 assert.ok(!JSON.stringify(response).includes(token));
});
