import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { PGlite } from '@electric-sql/pglite';
import { migrateBrokerMobileAuth } from '../migrations/044_broker_mobile_auth.js';
import { migrateBrokerMobilePush } from '../migrations/048_broker_mobile_push.js';
import { createBrokerMobileService } from './brokerMobile.service.js';
import { createBrokerMobileRouter } from '../routes/brokerMobile.routes.js';
import { postingPolicySql } from '../test/mobilePostingPolicy.fixture.mjs';
import { brokerInstallmentPushMessage, createBrokerMobilePushDevices, createBrokerMobilePushWorker, createBrokerMobilePushCycle } from './brokerMobilePush.service.js';
import { REMINDER_SCAN_INTERVAL_MS } from './mobilePush.service.js';

process.env.MOBILE_PORTAL_SECRET='synthetic-broker-push-test-secret-at-least-32-characters';
const token='synthetic_partner_fcm_token_1234567890';
const credentials={mobile:'9876500001',password:'234567890123'};

async function fixture(t) {
  const raw=new PGlite(); t.after(()=>raw.close());
  await raw.exec(`CREATE TABLE organizations(id integer PRIMARY KEY,name text);
    CREATE TABLE sites(id integer PRIMARY KEY,name text,organization_id integer);
    CREATE TABLE members(id integer PRIMARY KEY,site_id integer,full_name text,phone text,email text,address text,city text,state text,pincode text,aadhar_no text,
      member_type text,member_types text[],status text DEFAULT 'ACTIVE',is_active boolean DEFAULT true,referred_by_member_id integer,referred_by_user_id integer);
    CREATE TABLE users(id integer PRIMARY KEY,name text,email text,phone text,password text,role text,is_active boolean DEFAULT true,
      can_login_booking boolean DEFAULT true,organization_id integer,token_version integer DEFAULT 0,agent_status text DEFAULT 'ACTIVE');
    CREATE TABLE user_sites(user_id integer,site_id integer);
    CREATE TABLE booking_user_kyc_links(user_id integer PRIMARY KEY,member_id integer,kyc_case_id integer,phone text,aadhaar_last4 text);
    CREATE TABLE booking_staff_identities(user_id integer,aadhaar_password_hash text,password_fingerprint text,aadhaar_last4 text);
    CREATE TABLE kyc_cases(id integer PRIMARY KEY,client_member_id integer,site_id integer,status text);
    CREATE TABLE plots(id integer PRIMARY KEY,site_id integer,plot_no text,plot_size numeric,sale_price numeric,booking_date date,status text,buyer_member_id integer,buyer_name text);
    CREATE TABLE bookings(id integer PRIMARY KEY,site_id integer,plot_id integer,client_member_id integer,status text,booking_agent_id integer,agent_user_id integer);
    CREATE TABLE plot_commissions_v2(id integer PRIMARY KEY,site_id integer,plot_id integer,agent_id integer,status text);
    CREATE TABLE plot_installments(id integer PRIMARY KEY,plot_id integer,installment_name text,amount numeric,due_date date,sort_order integer,status text DEFAULT 'pending');
    CREATE TABLE plot_payments(id integer PRIMARY KEY,site_id integer,plot_id integer,amount numeric,date date,payment_type text,status text,cheque_status text,reference text);
    CREATE TABLE plot_installment_payments(id integer PRIMARY KEY,plot_id integer,installment_id integer,amount numeric,payment_date date,payment_mode text,status text,cheque_status text,reference text);
    CREATE TABLE booking_mobile_push_devices(token_hash text PRIMARY KEY,account_id integer,token text);
    INSERT INTO organizations VALUES(1,'PRIVATE ORGANIZATION');
    INSERT INTO sites VALUES(1,'PRIVATE SITE',1);
    INSERT INTO members(id,site_id,full_name,phone,email,aadhar_no,member_type) VALUES
      (101,1,'Partner One','9876500001','one@example.test','234567890123','BROKER'),
      (102,1,'Partner Two','9876500002','two@example.test','345678901234','BROKER'),
      (10,1,'PRIVATE CLIENT ONE','9876510001','client@example.test','456789012345','CLIENT'),
      (11,1,'PRIVATE CLIENT TWO','9876510002','next@example.test','567890123456','CLIENT');
    INSERT INTO plots VALUES(1,1,'PRIVATE-A1',100,1000,'2026-01-01','BOOKED',10,'PRIVATE CLIENT ONE');
    INSERT INTO bookings VALUES(1,1,1,10,'CONFIRMED',101,NULL);
    INSERT INTO plot_installments VALUES(1,1,'PRIVATE PLAN',1000,'2026-11-10',1,'pending');`);
  await raw.exec(postingPolicySql);
  let tail=Promise.resolve();
  const db={query:(...args)=>raw.query(...args),async connect(){
    const before=tail;let release;tail=new Promise(resolve=>{release=resolve;});await before;
    return {query:(...args)=>raw.query(...args),release};
  }};
  await migrateBrokerMobileAuth(db); await migrateBrokerMobilePush(db); await migrateBrokerMobilePush(db);
  let clock=Date.now();
  const service=createBrokerMobileService(db,{bcryptRounds:4,now:()=>clock,financeCacheMs:5000});
  const login=await service.login(credentials);
  const session=await service.getSession(login.token);
  const devices=createBrokerMobilePushDevices(db,{brokerService:service});
  const sent=[];let date='2026-11-07';
  const worker=createBrokerMobilePushWorker(db,{brokerService:service,today:()=>date,send:async message=>sent.push(message)});
  const drain=async()=>{while(await worker.expandOne());while(await worker.dispatchOne());};
  return {raw,db,service,login,session,devices,sent,worker,drain,setDate:value=>{date=value;},advance:milliseconds=>{clock+=milliseconds;}};
}

test('partner FCM messages contain only a generic alert and target the separate Android package',()=>{
  const now=Date.parse('2026-11-07T04:00:00Z');
  const message=brokerInstallmentPushMessage({now});
  assert.deepEqual(message.data,{type:'installment'});
  assert.equal(message.android.restrictedPackageName,'app.myrealassets.broker');
  assert.equal(message.android.notification.channelId,'partner_installment_reminders');
  assert.equal(message.android.notification.priority,'high');
  assert.equal(message.android.priority,'high');
  assert.equal(now+message.android.ttl,Date.parse('2026-11-07T23:59:59+05:30'));
  assert.equal(message.apns.headers['apns-push-type'],'alert');
  assert.match(message.notification.body,/A client installment is approaching or due/);
  assert.ok(!/PRIVATE|amount|clientId|plotId|installmentId/.test(JSON.stringify(message)));
});

test('broker reminders are deduplicated per device/day, include late devices, and survive JWT expiry only with unchanged authority',async t=>{
  const f=await fixture(t);
  await f.worker.enqueueReminders();
  assert.equal((await f.raw.query('SELECT count(*)::int AS n FROM booking_broker_push_events')).rows[0].n,0);
  await f.devices.register(f.session,{token,platform:'android'});
  await f.worker.enqueueReminders();await f.worker.enqueueReminders();await f.drain();
  assert.equal(f.sent.length,1);
  assert.ok(!/PRIVATE|9876510001|1000|pr_|cl_|ins_/.test(JSON.stringify(f.sent)));
  const late='synthetic_partner_late_token_1234567890';
  await f.devices.register(f.session,{token:late,platform:'android'});
  await f.worker.enqueueReminders();await f.drain();
  assert.equal(f.sent.length,2);
  assert.equal(f.sent.at(-1).token,late);
  await f.raw.exec("UPDATE plot_installments SET due_date='2026-11-08' WHERE id=1");
  await f.worker.enqueueReminders();await f.drain();
  assert.equal(f.sent.length,2,'a due-date correction cannot send twice to one device that day');
  await f.raw.exec("UPDATE plot_installments SET due_date='2026-11-10' WHERE id=1");
  f.advance(31*86400000);
  await assert.rejects(f.service.getSession(f.login.token),{statusCode:401});
  for (const date of ['2026-11-08','2026-11-09','2026-11-10','2026-11-11']) {
    f.setDate(date);await f.worker.enqueueReminders();await f.worker.enqueueReminders();await f.drain();
  }
  assert.equal(f.sent.length,6,'background devices remain current on the three reminder days even when JWT expires');
  assert.deepEqual((await f.raw.query('SELECT reminder_day::text AS day FROM booking_broker_push_events ORDER BY id')).rows.map(r=>r.day),['2026-11-07','2026-11-09','2026-11-10']);
});

test('queued broker reminders revalidate payment, status, current client, current plan and broker assignment',async t=>{
  const f=await fixture(t);
  await f.devices.register(f.session,{token,platform:'android'});
  let installmentId=1;
  const withheld=async(change,restore)=>{
    await f.raw.query('UPDATE plot_installments SET id=$1',[++installmentId]);
    await f.worker.enqueueReminders();await f.worker.expandOne();
    await f.raw.exec(change);await f.drain();
    assert.equal(f.sent.length,0,change);
    if(restore)await f.raw.exec(restore);
  };
  for(const status of ['CANCELLED','CANCELED','RESALE','AVAILABLE','COMPANY']) {
    await withheld(`UPDATE plots SET status='${status}'`,"UPDATE plots SET status='BOOKED'");
  }
  await withheld("UPDATE plots SET buyer_member_id=NULL; UPDATE bookings SET client_member_id=NULL",'UPDATE plots SET buyer_member_id=10; UPDATE bookings SET client_member_id=10');
  await withheld('UPDATE plots SET buyer_member_id=11; UPDATE bookings SET client_member_id=11','UPDATE plots SET buyer_member_id=10; UPDATE bookings SET client_member_id=10');
  await withheld('UPDATE bookings SET booking_agent_id=102','UPDATE bookings SET booking_agent_id=101');
  await withheld("UPDATE bookings SET status='CANCELLED'","UPDATE bookings SET status='CONFIRMED'");
  await withheld("UPDATE members SET is_active=false WHERE id=10",'UPDATE members SET is_active=true WHERE id=10');
  await withheld("UPDATE plot_installments SET due_date='2026-12-10'","UPDATE plot_installments SET due_date='2026-11-10'");
  await withheld("INSERT INTO plot_payments VALUES(1,1,1,1000,current_date,'BANK','approved',NULL,'PAID')",'DELETE FROM plot_payments');
  await withheld('DELETE FROM plot_installments',"INSERT INTO plot_installments VALUES(50,1,'NEW PLAN',1000,'2026-11-10',1,'pending')");
  // A new client association gets a new event even when raw plot/plan IDs stay.
  await f.worker.enqueueReminders();await f.worker.expandOne();
  await f.raw.exec('UPDATE plots SET buyer_member_id=11; UPDATE bookings SET client_member_id=11');
  await f.drain();assert.equal(f.sent.length,0);
  await f.worker.enqueueReminders();await f.drain();assert.equal(f.sent.length,1);
  assert.equal((await f.raw.query("SELECT count(DISTINCT client_ref)::int AS n FROM booking_broker_push_events WHERE installment_ref=(SELECT installment_ref FROM booking_broker_push_events ORDER BY id DESC LIMIT 1)")).rows[0].n,2);
});

test('current booking fallback, co-broker relationships and eligibility flags use exact active client authority',async t=>{
  const f=await fixture(t);
  await f.devices.register(f.session,{token,platform:'android'});
  await f.raw.exec("UPDATE plots SET buyer_member_id=NULL,buyer_name='PRIVATE CLIENT TWO'; INSERT INTO plot_commissions_v2 VALUES(1,1,1,101,'Pending')");
  let portfolio=await f.service.portfolio(f.session,{forceFresh:true});
  assert.equal(portfolio.clients.flatMap(c=>c.plots)[0].installmentRemindersEligible,true);
  assert.equal(portfolio.clients.find(c=>c.plots.length).name,'PRIVATE CLIENT ONE','current booking wins over a stale overlapping commission buyer label');
  await f.worker.enqueueReminders();await f.drain();assert.equal(f.sent.length,1,'latest explicit booking client is a current association');
  await f.raw.exec("UPDATE plot_installments SET id=2; UPDATE plots SET buyer_member_id=10; UPDATE bookings SET booking_agent_id=102");
  await f.worker.enqueueReminders();await f.drain();assert.equal(f.sent.length,2,'an explicitly entitled current co-broker can receive reminders');
  await f.raw.exec("UPDATE plot_installments SET id=3; UPDATE plots SET buyer_member_id=NULL; DELETE FROM bookings");
  portfolio=await f.service.portfolio(f.session,{forceFresh:true});
  assert.equal(portfolio.clients.flatMap(c=>c.plots)[0].installmentRemindersEligible,false,'a guessed ledger-name owner is not reminder authority');
  await f.worker.enqueueReminders();await f.drain();assert.equal(f.sent.length,2);
  await f.raw.exec("UPDATE plots SET buyer_member_id=10,status='RESALE'");
  assert.equal((await f.service.portfolio(f.session,{forceFresh:true,remindersOnly:true})).summary.plotCount,0);
});

test('broker devices stay separate from clients and reject stale identity, password, disabled and disassociated accounts',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.devices.register({accountId:f.session.account.id,version:0},{token,platform:'android'}),{statusCode:401});
  await assert.rejects(f.devices.register(f.session,{token:'invalid',platform:'android'}),{statusCode:400});
  await f.raw.query('INSERT INTO booking_mobile_push_devices VALUES($1,1,$2)',['client-realm-only',token]);
  await f.devices.register(f.session,{token,platform:'android'});
  await f.devices.unregister(f.session,{token});
  assert.equal((await f.raw.query('SELECT count(*)::int AS n FROM booking_mobile_push_devices')).rows[0].n,1);
  await f.devices.register(f.session,{token,platform:'android'});
  await f.worker.enqueueReminders();await f.worker.expandOne();
  const otherLogin=await f.service.login({mobile:'9876500002',password:'345678901234'});
  const otherSession=await f.service.getSession(otherLogin.token);
  await f.devices.unregister(otherSession,{token});
  assert.equal((await f.raw.query('SELECT count(*)::int AS n FROM booking_broker_push_devices')).rows[0].n,1);
  await f.devices.register(otherSession,{token,platform:'android'});
  await f.drain();assert.equal(f.sent.length,0,'the newest broker registration owns this physical app token');
  await f.devices.register(f.session,{token,platform:'android'});
  for(const [change,restore] of [
    ['UPDATE booking_broker_mobile_accounts SET is_active=false WHERE id=1','UPDATE booking_broker_mobile_accounts SET is_active=true WHERE id=1'],
    ["UPDATE members SET email='changed@example.test' WHERE id=101","UPDATE members SET email='one@example.test' WHERE id=101"],
    ['UPDATE members SET is_active=false WHERE id=101','UPDATE members SET is_active=true WHERE id=101'],
    ["UPDATE members SET aadhar_no='678901234567' WHERE id=101","UPDATE members SET aadhar_no='234567890123' WHERE id=101"],
  ]) {
    await f.raw.exec(change);
    await assert.rejects(f.devices.register(f.session,{token,platform:'android'}),{statusCode:401});
    await f.worker.enqueueReminders();await f.drain();assert.equal(f.sent.length,0);
    await f.raw.exec(restore);
  }
  await f.service.changePassword(f.session,{currentPassword:credentials.password,newPassword:'Independent-partner-password!'});
  await assert.rejects(f.service.getDeviceSession({accountId:1,version:0,identity:f.session.identity}),{statusCode:401});
  await f.worker.enqueueReminders();await f.drain();assert.equal(f.sent.length,0);
  const freshLogin=await f.service.login({mobile:credentials.mobile,password:'Independent-partner-password!'});
  const fresh=await f.service.getSession(freshLogin.token);
  await f.devices.register(fresh,{token,platform:'android'});
  await f.service.logout(fresh);
  await assert.rejects(f.service.getSession(freshLogin.token),{statusCode:401});
  await f.worker.enqueueReminders();await f.drain();assert.equal(f.sent.length,0);
  await f.worker.enqueueReminders();await f.drain();assert.equal(f.sent.length,0);
});

test('broker token endpoints require the broker JWT realm and scope operations to that session',async t=>{
  const f=await fixture(t),calls=[];
  const router=createBrokerMobileRouter(f.service,{isEnabled:()=>true,pushDevices:{register:async(...args)=>calls.push(['register',...args]),unregister:async(...args)=>calls.push(['unregister',...args])}});
  const invoke=(method,auth,body)=>new Promise((resolve,reject)=>{
    const req={method,url:'/device-tokens',body,ip:'127.0.0.1',headers:auth?{authorization:`Bearer ${auth}`}:{},get(name){return this.headers[name.toLowerCase()];}};
    const res={statusCode:200,headers:{},set(k,v){this.headers[k]=v;return this;},status(code){this.statusCode=code;return this;},json(body){resolve({status:this.statusCode,body,headers:this.headers});}};
    router.handle(req,res,error=>reject(error||new Error('unmatched')));
  });
  assert.equal((await invoke('POST',null,{token,platform:'android'})).status,401);
  const clientToken=jwt.sign({realm:'mobile-client',accountId:1,version:0},process.env.MOBILE_PORTAL_SECRET);
  assert.equal((await invoke('POST',clientToken,{token,platform:'android'})).status,401);
  const result=await invoke('POST',f.login.token,{token,platform:'android'});
  assert.deepEqual(result.body,{ok:true});assert.equal(result.headers['Cache-Control'],'private, no-store');
  assert.deepEqual((await invoke('DELETE',f.login.token,{token})).body,{ok:true});
  assert.deepEqual(calls.map(c=>c[0]),['register','unregister']);
  assert.equal(calls[0][1].identity,f.session.identity);assert.equal(calls[0][1].account.id,f.session.account.id);
});

test('finance-read races remove mobile popup eligibility and recheck the broker fingerprint before sending',async t=>{
  for(const change of ["UPDATE plots SET status='RESALE'",'UPDATE plots SET buyer_member_id=11; UPDATE bookings SET client_member_id=11']) {
    await t.test(change,async t=>{
      const f=await fixture(t);let mutated=false;
      const service=createBrokerMobileService({...f.db,query:async(sql,args)=>{
        const result=await f.db.query(sql,args);
        if(!mutated&&sql.includes('FROM plot_installments pi WHERE')) {mutated=true;await f.raw.exec(change);}
        return result;
      }},{financeCacheMs:0,bcryptRounds:4});
      const portfolio=await service.portfolio(f.session,{forceFresh:true});
      assert.equal(portfolio.clients.flatMap(c=>c.plots)[0].installmentRemindersEligible,false);
    });
  }
  await t.test('broker fingerprint changes during finance read',async t=>{
    const f=await fixture(t);await f.devices.register(f.session,{token,platform:'android'});
    await f.worker.enqueueReminders();await f.worker.expandOne();let mutated=false;
    const service=createBrokerMobileService({...f.db,query:async(sql,args)=>{
      const result=await f.db.query(sql,args);
      if(!mutated&&sql.includes('FROM plot_installments pi WHERE')) {mutated=true;await f.raw.exec("UPDATE members SET email='revoked@example.test' WHERE id=101");}
      return result;
    }},{financeCacheMs:0,bcryptRounds:4});
    const worker=createBrokerMobilePushWorker(f.db,{brokerService:service,today:()=> '2026-11-07',send:async message=>f.sent.push(message)});
    await worker.dispatchOne();assert.equal(f.sent.length,0);
    assert.equal((await f.raw.query('SELECT state FROM booking_broker_push_deliveries')).rows[0].state,'skipped');
  });
});

test('registered devices revalidate linked staff password, grants, KYC and removal with current broker identity',async t=>{
  const f=await fixture(t);
  await f.raw.exec(`INSERT INTO users(id,name,email,phone,password,role,organization_id) VALUES(1,'Linked Partner','one@example.test','9876500001','old-web-password','agent',1);
    INSERT INTO user_sites VALUES(1,1); INSERT INTO kyc_cases VALUES(1,101,1,'VERIFIED');
    INSERT INTO booking_user_kyc_links VALUES(1,101,1,'9876500001','0123');`);
  const linked=await f.service.getSession((await f.service.login(credentials)).token);
  await f.devices.register(linked,{token,platform:'android'});
  let plan=1;
  for(const [change,restore] of [
    ["UPDATE users SET password='changed-web-password' WHERE id=1","UPDATE users SET password='old-web-password' WHERE id=1"],
    ['UPDATE users SET token_version=1 WHERE id=1','UPDATE users SET token_version=0 WHERE id=1'],
    ['DELETE FROM user_sites','INSERT INTO user_sites VALUES(1,1)'],
    ["UPDATE kyc_cases SET status='PENDING'","UPDATE kyc_cases SET status='VERIFIED'"],
    ['DELETE FROM booking_user_kyc_links',"INSERT INTO booking_user_kyc_links VALUES(1,101,1,'9876500001','0123')"],
  ]) {
    await f.raw.query('UPDATE plot_installments SET id=$1',[++plan]);
    await f.worker.enqueueReminders();await f.worker.expandOne();
    await f.raw.exec(change);await f.drain();assert.equal(f.sent.length,0,change);
    await assert.rejects(f.devices.register(linked,{token,platform:'android'}),{statusCode:401});
    await f.raw.exec(restore);
  }
});

test('invalid partner-package tokens are removed without changing the client app registry',async t=>{
  const f=await fixture(t);await f.devices.register(f.session,{token,platform:'android'});
  await f.raw.query('INSERT INTO booking_mobile_push_devices VALUES($1,1,$2)',['client-realm-only',token]);
  await f.worker.enqueueReminders();await f.worker.expandOne();
  const worker=createBrokerMobilePushWorker(f.db,{brokerService:f.service,today:()=> '2026-11-07',send:async()=>{throw Object.assign(new Error('fictional wrong package'),{code:'messaging/invalid-package-name'});}});
  await worker.dispatchOne();
  assert.equal((await f.raw.query('SELECT count(*)::int AS n FROM booking_broker_push_devices')).rows[0].n,0);
  assert.equal((await f.raw.query('SELECT count(*)::int AS n FROM booking_mobile_push_devices')).rows[0].n,1);
});

test('broker worker rescans every five minutes, drains queue after a failed scan, and cleans daily',async()=>{
  let clock=0,date='2026-11-07',scans=0,drains=0;const queries=[];
  const cycle=createBrokerMobilePushCycle({query:async sql=>queries.push(sql)},{
    enqueueReminders:async()=>{scans++;if(scans===1)throw new Error('BROKER_REMINDER_SCAN_INCOMPLETE');},
    expandOne:async()=>false,dispatchOne:async()=>{drains++;return false;},
  },{now:()=>clock,today:()=>date});
  await assert.rejects(cycle(),/BROKER_REMINDER_SCAN_INCOMPLETE/);assert.equal(drains,1);
  await cycle();assert.equal(scans,2);assert.equal(queries.length,2);
  clock=60_000;await cycle();assert.equal(scans,2);
  clock=REMINDER_SCAN_INTERVAL_MS;await cycle();assert.equal(scans,3);
  date='2026-11-08';await cycle();assert.equal(scans,4);assert.equal(queries.length,4);
});
