import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { createHash } from 'node:crypto';
import { migrateBrokerMobileAuth } from '../migrations/044_broker_mobile_auth.js';
import { PGlite } from '@electric-sql/pglite';
import { createBrokerMobileService } from './brokerMobile.service.js';
import { createBrokerMobileRouter, createBrokerMobileLoginLimiter } from '../routes/brokerMobile.routes.js';
import { postingPolicySql } from '../test/mobilePostingPolicy.fixture.mjs';

const credentials={mobile:'9876500001',password:'234567890123'};
async function fixture() {
  const db=new PGlite();
  await db.exec(`
    CREATE TABLE sites(id integer PRIMARY KEY,name text,organization_id integer);
    CREATE TABLE users(id integer PRIMARY KEY,name text,email text,phone text,password text,role text,is_active boolean DEFAULT true,can_login_booking boolean DEFAULT true,organization_id integer,token_version integer DEFAULT 0,agent_status text DEFAULT 'ACTIVE');
    CREATE TABLE user_sites(user_id integer,site_id integer);
    CREATE TABLE booking_staff_identities(user_id integer,aadhaar_password_hash text,password_fingerprint text,aadhaar_last4 text);
    CREATE TABLE booking_user_kyc_links(user_id integer,member_id integer,kyc_case_id integer,phone text,aadhaar_last4 text);
    CREATE TABLE kyc_cases(id integer PRIMARY KEY,client_member_id integer,site_id integer,status text);
    CREATE TABLE members(id integer PRIMARY KEY,site_id integer,full_name text,phone text,email text,address text,city text,state text,pincode text,aadhar_no text,pan_no text,account_no text,passport_no text,member_type text,member_types text[],is_active boolean DEFAULT true,status text DEFAULT 'ACTIVE',referred_by_member_id integer,referred_by_user_id integer);
    CREATE TABLE plots(id integer PRIMARY KEY,site_id integer,plot_no text,plot_size numeric,sale_price numeric,booking_date date,status text,buyer_member_id integer,booking_by text,buyer_name text,full_payment_due boolean DEFAULT false,full_payment_due_date date);
    CREATE TABLE plot_commissions_v2(id integer PRIMARY KEY,site_id integer,plot_id integer,agent_id integer,total_commission numeric DEFAULT 0,status text DEFAULT 'Pending');
    CREATE TABLE bookings(id integer PRIMARY KEY,site_id integer,plot_id integer,client_member_id integer,status text,booking_agent_id integer,agent_user_id integer,created_by integer);
    CREATE TABLE plot_installments(id integer PRIMARY KEY,plot_id integer,installment_name text,amount numeric,due_date date,sort_order integer,status text DEFAULT 'pending');
    CREATE TABLE plot_payments(id integer PRIMARY KEY,site_id integer,plot_id integer,amount numeric,date date,payment_type text,status text,cheque_status text,reference text);
    CREATE TABLE plot_installment_payments(id integer PRIMARY KEY,plot_id integer,installment_id integer,amount numeric,payment_date date,payment_mode text,status text,cheque_status text,reference text);
    INSERT INTO sites VALUES(1,'Private Company Branding',1),(2,'Other Site Name',1),(3,'Other Organization',2);
    INSERT INTO users(id,name,email,phone,role,organization_id) VALUES
      (1,'Partner A','a@test.example','+91 9876500001','agent',1),(2,'Partner B','b@test.example','9876500002','agent',1),
      (3,'Staff','staff@test.example','9876500003','admin',1),(4,'Email Partner','email@test.example','9876500004','agent',1);
    INSERT INTO user_sites VALUES(1,1),(1,2),(1,3),(2,1),(4,1);
    INSERT INTO members(id,site_id,full_name,phone,aadhar_no,member_type) VALUES
      (101,1,'Partner A','9876500001','234567890123','BROKER'),(102,1,'Partner B','9876500002','345678901234','BROKER'),
      (201,2,'Partner A Other Registration','+91 9876500001','2345 6789 0123','BROKER'),
      (202,2,'Shared Phone Different Broker','9876500001','456789012345','BROKER'),
      (301,3,'Other Org Same Identity','9876500001','234567890123','BROKER');
    INSERT INTO members(id,site_id,full_name,phone,email,address,city,state,pincode,aadhar_no,pan_no,account_no,passport_no,member_type,referred_by_member_id,referred_by_user_id) VALUES
      (10,1,'Client Alpha','9876510001','client@test.example','42 Example Street','Example City','Example State','123456','567890123456','ABCDE1234F','BANK-PRIVATE-SENTINEL','PASSPORT-PRIVATE-SENTINEL','CLIENT',101,1),
      (11,1,'Referral Only','9876510002',NULL,NULL,NULL,NULL,NULL,'678901234567','BCDEF2345G',NULL,NULL,'CLIENT',NULL,1),
      (12,1,'Override Referral','9876510003',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'CLIENT',102,1),
      (13,1,'Explicit Booking Client','9876510004',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'CLIENT',NULL,NULL),
      (20,2,'Client At Site Two','9876510005',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'CLIENT',201,NULL),
      (21,2,'Other Broker Shared Phone Client','9876510006',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'CLIENT',202,NULL),
      (30,3,'Other Org Client','9876510007',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'CLIENT',301,1);
    INSERT INTO kyc_cases VALUES(1,101,1,'VERIFIED'),(2,102,1,'VERIFIED');
    INSERT INTO booking_user_kyc_links VALUES(1,101,1,'9876500001','0123'),(2,102,2,'9876500002','1234');
    INSERT INTO plots(id,site_id,plot_no,plot_size,sale_price,booking_date,status,buyer_member_id,booking_by) VALUES
      (1,1,'A1',120,1000,'2026-01-01','BOOKED',10,'Partner A'),
      (2,1,'A2',120,1000,'2026-01-01','BOOKED',10,'Partner B'),
      (3,1,'A3',120,1000,'2026-01-01','BOOKED',11,'Partner A'),
      (4,1,'A4',120,1000,'2026-01-01','BOOKED',11,'Partner A'),
      (5,1,'A5',120,1000,'2026-01-01','BOOKED',11,'Partner A'),
      (6,1,'A6',120,1000,'2026-01-01','BOOKED',10,'Partner A'),
      (7,2,'B1',180,2000,'2026-01-01','BOOKED',20,'Partner A'),
      (8,3,'C1',180,2000,'2026-01-01','BOOKED',30,'Partner A'),
      (9,1,'A9',120,1000,'2026-01-01','BOOKED',11,'Partner A'),
      (10,1,'A10',120,1000,'2026-01-01','BOOKED',11,'Partner A'),
      (11,1,'A11',120,1000,'2026-01-01','AVAILABLE',11,'Partner A'),
      (12,1,'A12',120,1000,'2026-01-01','BOOKED',13,'Email Partner'),
      (13,1,'A13',120,1000,'2026-01-01','BOOKED',13,'Partner A'),
      (14,2,'B2',120,1000,'2026-01-01','BOOKED',21,'Shared Phone Broker');
    INSERT INTO bookings VALUES
      (1,1,1,10,'CONFIRMED',101,2,2),(2,1,2,10,'CONFIRMED',102,1,1),
      (3,1,3,11,'CONFIRMED',102,1,1),(4,1,4,11,'CONFIRMED',NULL,2,1),
      (5,1,5,11,'CONFIRMED',101,1,1),(50,1,5,11,'CANCELLED',101,1,1),
      (6,1,6,11,'CONFIRMED',101,1,1),(7,2,7,20,'CONFIRMED',201,2,2),
      (8,3,8,30,'CONFIRMED',301,1,1),(9,1,9,11,'CONFIRMED',201,1,1),
      (11,1,11,11,'CONFIRMED',101,1,1),(12,1,12,13,'CONFIRMED',NULL,4,1),
      (13,1,13,13,'CONFIRMED',NULL,1,2),(14,2,14,21,'CONFIRMED',202,1,1);
    INSERT INTO plot_installments(id,plot_id,installment_name,amount,due_date,sort_order) VALUES
      (1,1,'Booking amount',200,'2026-01-01',1),(2,1,'Final - 5678 9012 3456 ABCDE1234F',800,'2027-01-01',2);
    INSERT INTO plot_payments VALUES(1,1,1,100,'2026-01-01','BANK','approved',NULL,'PAY-1'),
      (2,1,1,100,'2026-02-01','CASH','approved',NULL,'PAY-2'),
      (3,1,1,-25,'2026-03-01','BANK','approved',NULL,'567890123456 ABCDE1234F'),
      (4,1,1,100,'2026-03-01','CHEQUE','approved','UNCLEARED','UNCLEARED'),
      (5,2,1,999,'2026-03-01','BANK','approved',NULL,'WRONG-SITE');
    INSERT INTO plot_installment_payments VALUES(1,1,2,50,'2026-02-01','CASH','approved',NULL,'DIRECT');
  `);
  await db.exec(postingPolicySql);
  const hash=await bcrypt.hash(credentials.password,4);
  await db.query('UPDATE users SET password=$1',[hash]);
  await db.query('INSERT INTO booking_staff_identities VALUES(1,$1,$2,\'0123\')',[
    await bcrypt.hash('234567890123',4),createHash('sha256').update(hash).digest('hex'),
  ]);
  let tail=Promise.resolve();
  const adapter={query:(sql,args)=>db.query(sql,args),exec:sql=>db.exec(sql),close:()=>db.close(),async connect(){const before=tail;let unlock;tail=new Promise(resolve=>{unlock=resolve;});await before;return {query:(sql,args)=>db.query(sql,args),release:unlock};}};
  await migrateBrokerMobileAuth(adapter);
  return adapter;
}

test('broker mobile SQL enforces per-plot scope, privacy and current access',async t=>{
  const previous=process.env.MOBILE_PORTAL_SECRET;
  process.env.MOBILE_PORTAL_SECRET='synthetic-test-only-broker-secret-long-enough';
  const db=await fixture();const queries=[];
  const service=createBrokerMobileService({...db,query:(sql,args)=>{queries.push(sql);return db.query(sql,args);}},{financeCacheMs:5000,bcryptRounds:4});
  t.after(async()=>{await db.close();if(previous===undefined)delete process.env.MOBILE_PORTAL_SECRET;else process.env.MOBILE_PORTAL_SECRET=previous;});
  const login=await service.login(credentials);let session=await service.getSession(login.token);
  await t.test('login uses enrolled Bookings credentials and a separate scoped 30-day realm',async()=>{
    const claims=jwt.decode(login.token);
    assert.equal(claims.realm,'mobile-broker-member');assert.equal(claims.exp-claims.iat,30*86400);
    assert.deepEqual(login.user,{id:'broker:1',name:'Partner A',role:'broker'});
    assert.equal(login.sessionDurationDays,30);assert.equal(Date.parse(login.expiresAt),claims.exp*1000);
    const sensitive=/9876500001|234567890123|password|aadhaar|aadhar|pan_no/i;
    assert.ok(!sensitive.test(JSON.stringify(claims)));assert.ok(!sensitive.test(JSON.stringify(login)));
    await assert.rejects(service.login({...credentials,password:'wrong'}),{statusCode:401});
    await assert.rejects(service.login({...credentials,mobile:'9876500003'}),{statusCode:401});
    await assert.rejects(service.login({...credentials,role:'client'}),{statusCode:401});
    await assert.rejects(service.getSession(jwt.sign({id:1,role:'agent'},'staff-secret')),{statusCode:401});
    assert.ok((await service.login({mobile:credentials.mobile,aadhaar:'2345 6789 0123'})).token);
  });
  await t.test('same customer may have different brokers; overrides, latest cancellations and current buyers win',async()=>{
    const portfolio=await service.portfolio(session);
    assert.deepEqual(portfolio.clients.flatMap(c=>c.plots.map(p=>p.id)).sort(),['1','13','7']);
    assert.deepEqual(portfolio.clients.map(c=>c.id).sort(),['10','11','13','20']);
    assert.equal(portfolio.clients.find(c=>c.id==='11').plots.length,0);
    assert.equal(portfolio.summary.clientCount,4);assert.equal(portfolio.summary.plotCount,3);
    for(const id of ['2','3','4','5','6','8','9','10','11','12','14','999','2147483648','1 OR 1=1'])await assert.rejects(service.plot(session,id),{statusCode:404});
  });
  await t.test('cash and direct receipts, approved refunds and the same posting math are preserved',async()=>{
    const {plot}=await service.plot(session,'1');
    assert.equal(plot.paidAmount,225);assert.equal(plot.balanceAmount,775);
    assert.deepEqual(plot.installments.map(i=>i.paidAmount),[175,50]);
    assert.equal(plot.payments.length,4);assert.ok(plot.payments.some(p=>p.mode==='CASH'));
    assert.ok(plot.payments.some(p=>p.status==='refund'));assert.ok(!plot.payments.some(p=>p.reference==='UNCLEARED'||p.reference==='WRONG-SITE'));
  });
  await t.test('whitelisted DTOs exclude identity, bank, document and company data; histories are lazy',async()=>{
    const portfolio=await service.portfolio(session);const {plot}=await service.plot(session,'1');
    for(const value of [portfolio,plot]){
      const json=JSON.stringify(value);
      assert.ok(!/aadhaar|aadhar|pan_no|passport|account_no|document|BANK-PRIVATE|PASSPORT-PRIVATE|567890123456|5678 9012 3456|ABCDE1234F|Private Company Branding|Other Site Name/i.test(json));
    }
    assert.ok(portfolio.clients.every(c=>c.plots.every(p=>!Object.hasOwn(p,'payments'))));
    assert.deepEqual(Object.keys(portfolio.clients[0]).sort(),['id','name','phone','email','address','city','state','pincode','plots'].sort());
    assert.equal(plot.projectName,'Your Property');
    assert.ok(plot.payments.some(p=>p.reference.includes('[private ID]')));
  });
  await t.test('scope changes take effect immediately while financial cache is warm',async()=>{
    await service.portfolio(session);
    await db.exec('UPDATE bookings SET booking_agent_id=102 WHERE id=1');
    await assert.rejects(service.plot(session,'1'),{statusCode:404});
    assert.ok(!(await service.portfolio(session)).clients.flatMap(c=>c.plots).some(p=>p.id==='1'));
    await db.exec('UPDATE bookings SET booking_agent_id=101 WHERE id=1; UPDATE plots SET buyer_member_id=11 WHERE id=1');
    await assert.rejects(service.plot(session,'1'),{statusCode:404});
    await db.exec('UPDATE plots SET buyer_member_id=10 WHERE id=1; DELETE FROM user_sites WHERE user_id=1 AND site_id=2');
    await assert.rejects(service.getSession(login.token),{statusCode:401});session=await service.getSession((await service.login(credentials)).token);await assert.rejects(service.plot(session,'7'),{statusCode:404});
    await db.exec('INSERT INTO user_sites VALUES(1,2)');session=await service.getSession((await service.login(credentials)).token);
  });
  await t.test('password/version, disabled account, revoked verified link and broker role revoke tokens',async()=>{
    for(const [change,restore] of [
      ['UPDATE users SET token_version=1 WHERE id=1','UPDATE users SET token_version=0 WHERE id=1'],
      ["UPDATE users SET password='changed-password' WHERE id=1",''],
      ['UPDATE users SET is_active=false WHERE id=1','UPDATE users SET is_active=true WHERE id=1'],
      ['UPDATE users SET can_login_booking=false WHERE id=1','UPDATE users SET can_login_booking=true WHERE id=1'],
      ["UPDATE users SET agent_status='PENDING' WHERE id=1","UPDATE users SET agent_status='ACTIVE' WHERE id=1"],
      ["UPDATE kyc_cases SET status='PENDING' WHERE id=1","UPDATE kyc_cases SET status='VERIFIED' WHERE id=1"],
      ['UPDATE members SET is_active=false WHERE id=101','UPDATE members SET is_active=true WHERE id=101'],
      ["UPDATE members SET status='INACTIVE' WHERE id=101","UPDATE members SET status='ACTIVE' WHERE id=101"],
      ["UPDATE members SET phone='9876500099' WHERE id=101","UPDATE members SET phone='9876500001' WHERE id=101"],
      ["UPDATE members SET aadhar_no='789012345678' WHERE id=101","UPDATE members SET aadhar_no='234567890123' WHERE id=101"],
      ["UPDATE members SET member_type='CLIENT' WHERE id=101","UPDATE members SET member_type='BROKER' WHERE id=101"],
    ]){
      const old=(await db.query('SELECT password FROM users WHERE id=1')).rows[0].password;
      await db.exec(change);await assert.rejects(service.getSession(login.token),{statusCode:401});
      if(restore)await db.exec(restore);else await db.query('UPDATE users SET password=$1 WHERE id=1',[old]);
    }
    await db.exec('UPDATE booking_user_kyc_links SET member_id=102 WHERE user_id=1');
    await assert.rejects(service.getSession(login.token),{statusCode:401});
    await db.exec('UPDATE booking_user_kyc_links SET member_id=101 WHERE user_id=1');
    assert.ok(await service.getSession(login.token));
  });
  await t.test('inactive clients and cross-site brokers are removed despite a warm financial cache',async()=>{
    await service.portfolio(session);
    await db.exec("UPDATE members SET status='BLOCKED' WHERE id=10; UPDATE members SET status='INACTIVE' WHERE id=201");
    const fresh=await service.getSession((await service.login(credentials)).token);
    const portfolio=await service.portfolio(fresh);
    assert.ok(!portfolio.clients.some(c=>c.id==='10'||c.id==='20'));
    for(const id of ['1','7'])await assert.rejects(service.plot(fresh,id),{statusCode:404});
    await db.exec("UPDATE members SET status='ACTIVE' WHERE id IN (10,201)");
  });
  await t.test('financial reads batch, cache and refresh without per-client queries',async()=>{
    const first=queries.length;await service.portfolio(session);
    assert.equal(queries.length-first,3,'warm finance cache leaves Bookings/commission scope and client-scope SQL only');
    const second=queries.length;await service.portfolio(session,{forceFresh:true});assert.equal(queries.length-second,5);
    assert.ok(!queries.some(q=>/^(?:UPDATE|DELETE FROM|INSERT INTO) (?:plots|members|bookings|plot_payments|plot_installments)\b/.test(q)));
  });
});

test('commission-linked Accounts plots include approved related owners without leaking ambiguous contacts',async t=>{
  const previous=process.env.MOBILE_PORTAL_SECRET;
  process.env.MOBILE_PORTAL_SECRET='synthetic-commission-entitlement-secret-long-enough';
  const db=await fixture();
  t.after(async()=>{await db.close();if(previous===undefined)delete process.env.MOBILE_PORTAL_SECRET;else process.env.MOBILE_PORTAL_SECRET=previous;});
  await db.exec(`
    INSERT INTO members(id,site_id,full_name,phone,email,address,aadhar_no,pan_no,account_no,member_type) VALUES
      (40,1,'Accounts Only Buyer','9876590040','accounts-owner@example.test','40 Synthetic Street','912345678901','ZZZZZ1234Z','PRIVATE-ACCOUNTS-BANK','CLIENT'),
      (41,1,'Duplicate Ledger Buyer','9876590041','duplicate-active@example.test','PRIVATE-DUPLICATE-ADDRESS',NULL,NULL,NULL,'CLIENT'),
      (42,1,'Duplicate Ledger Buyer','9876590042','duplicate-inactive@example.test',NULL,NULL,NULL,NULL,'CLIENT'),
      (43,2,'Cross Site Buyer','9876590043','crosssite@example.test','PRIVATE-CROSSSITE-ADDRESS',NULL,NULL,NULL,'CLIENT'),
      (44,1,'Broker As Buyer','9876590044','broker-owner@example.test','44 Synthetic Street',NULL,NULL,NULL,'BROKER'),
      (45,1,'Inactive Ledger Buyer','9876590045','inactive-owner@example.test','PRIVATE-INACTIVE-ADDRESS',NULL,NULL,NULL,'CLIENT'),
      (46,1,'Unique Name Buyer','9876590046','unique-owner@example.test','46 Synthetic Street',NULL,NULL,NULL,'CLIENT'),
      (47,1,'Fallback Name Contact','9876590047','do-not-fallback@example.test','PRIVATE-FALLBACK-ADDRESS',NULL,NULL,NULL,'CLIENT');
    UPDATE members SET status='INACTIVE' WHERE id=42;
    UPDATE members SET status='BLOCKED' WHERE id=45;
    INSERT INTO plots(id,site_id,plot_no,plot_size,sale_price,booking_date,status,buyer_member_id,booking_by,buyer_name) VALUES
      (21,1,'LEGACY-1',150,1000,'2026-01-01','REGISTRY',40,'Partner A Typo','Old Recorded Buyer Label'),
      (22,1,'LEGACY-2',150,1000,'2026-01-01','REGISTRY',NULL,'Partner B',' unique name buyer '),
      (23,1,'LEGACY-3',150,1000,'2026-01-01','REGISTRY',NULL,'Partner B','Duplicate Ledger Buyer'),
      (24,1,'LEGACY-4',150,1000,'2026-01-01','REGISTRY',43,'Partner B','Fallback Name Contact'),
      (25,1,'LEGACY-5',150,1000,'2026-01-01','SOLD',44,'Partner B','Broker As Buyer'),
      (26,1,'DENIED-COMMISSION-CANCELLED',150,1000,'2026-01-01','REGISTRY',40,'Partner B','Accounts Only Buyer'),
      (27,1,'DENIED-COMMISSION-REJECTED',150,1000,'2026-01-01','REGISTRY',40,'Partner B','Accounts Only Buyer'),
      (28,1,'DENIED-COMMISSION-DELETED',150,1000,'2026-01-01','REGISTRY',40,'Partner B','Accounts Only Buyer'),
      (29,1,'DENIED-COMMISSION-WRONG-SITE',150,1000,'2026-01-01','REGISTRY',40,'Partner B','Accounts Only Buyer'),
      (30,1,'DENIED-COMMISSION-OTHER-BROKER',150,1000,'2026-01-01','REGISTRY',40,'Partner A','Accounts Only Buyer'),
      (31,1,'DENIED-CANCELLED-PLOT',150,1000,'2026-01-01','CANCELLED',40,'Partner B','Accounts Only Buyer'),
      (32,1,'DENIED-DELETED-PLOT',150,1000,'2026-01-01','DELETED',40,'Partner B','Accounts Only Buyer'),
      (33,1,'DENIED-COMPANY-PLOT',150,1000,'2026-01-01','COMPANY',40,'Partner B','Accounts Only Buyer'),
      (34,1,'DENIED-AVAILABLE-PLOT',150,1000,'2026-01-01','AVAILABLE',40,'Partner B','Accounts Only Buyer'),
      (35,3,'DENIED-OTHER-ORGANIZATION',150,1000,'2026-01-01','REGISTRY',30,'Partner A','Other Org Client'),
      (36,1,'LEGACY-6',150,1000,'2026-01-01','REGISTRY',45,'Partner B','Inactive Ledger Buyer'),
      (37,1,'LEGACY-7',150,1000,'2026-01-01','REGISTRY',40,'Partner B','Accounts Only Buyer'),
      (38,1,'DENIED-COMMISSION-UNKNOWN',150,1000,'2026-01-01','REGISTRY',40,'Partner B','Accounts Only Buyer'),
      (39,1,'DENIED-COMMISSION-NULL',150,1000,'2026-01-01','REGISTRY',40,'Partner B','Accounts Only Buyer'),
      (40,2,'LEGACY-SECOND-SITE',180,2000,'2026-01-01','REGISTRY',20,'Other Primary Broker','Client At Site Two'),
      (41,1,'DENIED-TRANSFERRED-PLOT',150,1000,'2026-01-01','TRANSFERRED',40,'Partner B','Accounts Only Buyer'),
      (42,1,'DENIED-UNDER-CANCELLATION-PLOT',150,1000,'2026-01-01','UNDER CANCELLATION',40,'Partner B','Accounts Only Buyer'),
      (43,1,'DENIED-UNKNOWN-PLOT-STATUS',150,1000,'2026-01-01','UNKNOWN',40,'Partner B','Accounts Only Buyer');
    INSERT INTO plot_commissions_v2(id,site_id,plot_id,agent_id,total_commission,status) VALUES
      (501,1,21,101,100,'Completed'),(502,1,22,101,100,'Partial'),(503,1,23,101,100,'Pending'),
      (504,1,24,101,100,'Pending'),(505,1,25,101,100,'Completed'),(506,1,26,101,100,'cancelled'),
      (507,1,27,101,100,'REJECTED'),(508,1,28,101,100,'deleted'),(509,2,29,201,100,'Pending'),
      (510,1,30,102,100,'Pending'),(511,1,31,101,100,'Pending'),(512,1,32,101,100,'Pending'),
      (513,1,33,101,100,'Completed'),(514,1,34,101,100,'Pending'),(515,3,35,301,100,'Pending'),
      (516,1,36,101,100,'Partial'),(517,1,37,101,100,'Pending'),(518,1,38,101,100,'UNKNOWN'),
      (519,1,39,101,100,NULL),(520,1,21,101,50,'Pending'),(521,1,21,102,50,'Completed'),
      (540,2,40,201,200,'Partial'),(541,1,41,101,100,'Pending'),
      (542,1,42,101,100,'Partial'),(543,1,43,101,100,'Completed');
    INSERT INTO bookings VALUES(137,1,37,40,'CANCELLED',102,2,2);
    INSERT INTO plot_installments(id,plot_id,installment_name,amount,due_date,sort_order) VALUES
      (21,21,'Booking amount',200,'2026-01-01',1),(22,21,'Final installment',800,'2027-01-01',2);
    INSERT INTO plot_payments VALUES
      (21,1,21,300,'2026-01-01','CASH','approved',NULL,'LEGACY-CASH'),
      (22,1,21,200,'2026-02-01','BANK','approved',NULL,'LEGACY-BANK'),
      (23,1,21,-50,'2026-03-01','BANK','approved',NULL,'LEGACY-REFUND');
  `);
  const service=createBrokerMobileService(db,{financeCacheMs:5000,bcryptRounds:4});
  const session=await service.getSession((await service.login(credentials)).token);
  const permitted=['21','22','23','24','25','36','37','40'];
  await t.test('explicit commission membership grants Accounts-only and other-primary plots once each',async()=>{
    const portfolio=await service.portfolio(session);
    const ids=portfolio.clients.flatMap(client=>client.plots.map(plot=>plot.id));
    for(const id of permitted)assert.equal(ids.filter(value=>value===id).length,1,`commission-linked plot ${id}`);
    for(const id of ['26','27','28','29','30','31','32','33','34','35','38','39','41','42','43']){
      assert.ok(!ids.includes(id));await assert.rejects(service.plot(session,id),{statusCode:404});
    }
    assert.equal(portfolio.clients.find(client=>client.id==='40').name,'Accounts Only Buyer','explicit buyer ID beats the recorded label');
    assert.equal(portfolio.clients.find(client=>client.id==='46').phone,'9876590046','unique current ledger name resolves its same-site contact');
    assert.equal(portfolio.clients.find(client=>client.id==='44').phone,'9876590044','a current explicit buyer can have another member role');
    assert.ok(!JSON.stringify(portfolio).match(/912345678901|ZZZZZ1234Z|PRIVATE-ACCOUNTS-BANK/));
    const disabled=createBrokerMobileService(db,{includeCommissionPlots:false,bcryptRounds:4});
    const without=await disabled.portfolio(session);
    assert.ok(without.clients.flatMap(client=>client.plots).every(plot=>!permitted.includes(plot.id)));
  });
  await t.test('ambiguous, cross-site and inactive buyer identities keep only recorded names and blank contacts',async()=>{
    const portfolio=await service.portfolio(session);
    for(const [id,name]of[['23','Duplicate Ledger Buyer'],['24','Fallback Name Contact'],['36','Inactive Ledger Buyer']]){
      const client=portfolio.clients.find(row=>row.id===`plot-owner:${id}`);
      assert.ok(client,`safe recorded owner for plot ${id}`);assert.equal(client.name,name);
      for(const key of['phone','email','address','city','state','pincode'])assert.equal(client[key],'');
      assert.deepEqual(client.plots.map(plot=>plot.id),[id]);
    }
    assert.ok(!portfolio.clients.some(client=>['41','42','43','45','47'].includes(client.id)));
    assert.ok(!/PRIVATE-DUPLICATE-ADDRESS|PRIVATE-CROSSSITE-ADDRESS|PRIVATE-FALLBACK-ADDRESS|PRIVATE-INACTIVE-ADDRESS/.test(JSON.stringify(portfolio)));
  });
  await t.test('commission access shares cash, bank, refunds, installment allocation and lazy financial histories',async()=>{
    const{plot}=await service.plot(session,'21');
    assert.equal(plot.number,'LEGACY-1');assert.equal(plot.area,150);
    assert.equal(plot.totalAmount,1000);assert.equal(plot.paidAmount,450);assert.equal(plot.balanceAmount,550);
    assert.deepEqual(plot.installments.map(row=>row.paidAmount),[200,250]);
    assert.equal(plot.payments.length,3);assert.ok(plot.payments.some(row=>row.mode==='CASH'));
    assert.ok(plot.payments.some(row=>row.status==='refund'));
    assert.ok((await service.portfolio(session)).clients.every(client=>client.plots.every(row=>!Object.hasOwn(row,'payments'))));
  });
  await t.test('changing or removing commission entitlement revokes access even with warm financial caches',async()=>{
    await service.plot(session,'21');await service.portfolio(session);
    await db.exec('UPDATE plot_commissions_v2 SET agent_id=102 WHERE plot_id=21');
    await assert.rejects(service.plot(session,'21'),{statusCode:404});
    assert.ok(!(await service.portfolio(session)).clients.flatMap(client=>client.plots).some(plot=>plot.id==='21'));
    await db.exec('UPDATE plot_commissions_v2 SET agent_id=101 WHERE id=501');
    assert.equal((await service.plot(session,'21')).plot.id,'21');
    await db.exec('DELETE FROM plot_commissions_v2 WHERE id=501');
    await assert.rejects(service.plot(session,'21'),{statusCode:404});
    await db.exec("UPDATE plot_commissions_v2 SET agent_id=101,status='Cancelled' WHERE id=520");
    await assert.rejects(service.plot(session,'21'),{statusCode:404});
  });
});

test('broker router is opt-in, scoped and returns only safe service errors',async()=>{
  const invoke=(router,method,url,headers={})=>new Promise((resolve,reject)=>{
    const req={method,url,headers,query:{},get(name){return this.headers[name.toLowerCase()];},ip:'test-ip'};
    const res={statusCode:200,headers:{},set(k,v){this.headers[k]=v;return this;},status(v){this.statusCode=v;return this;},json(body){resolve({status:this.statusCode,headers:this.headers,body});}};
    router.handle(req,res,e=>reject(e||new Error('No route matched')));
  });
  let touched=false;
  const service={async getSession(){touched=true;throw new Error('SQL password=secret');}};
  const off=createBrokerMobileRouter(service,{isEnabled:()=>false});
  const status=await invoke(off,'GET','/status');assert.equal(status.body.service,'my-real-assets-broker');assert.equal(status.body.authVersion,2);assert.equal(status.body.enabled,false);assert.equal(status.body.passwordReset,'registered-email-otp');
  assert.equal((await invoke(off,'GET','/portfolio')).status,503);assert.equal(touched,false);
  const on=createBrokerMobileRouter(service,{isEnabled:()=>true});
  const anon=await invoke(on,'GET','/portfolio');assert.equal(anon.status,401);assert.match(anon.headers['Cache-Control'],/no-store/);
  const bad=await invoke(on,'GET','/portfolio',{'authorization':'Bearer test.token.value'});assert.equal(bad.status,503);assert.ok(!JSON.stringify(bad).includes('secret'));
});

test('broker limiter separates identifiers, bounds repeated guesses and expires',()=>{
  let time=0;const limiter=createBrokerMobileLoginLimiter({now:()=>time,windowMs:1000});
  const invoke=id=>{let status=200;limiter({ip:'one-ip',body:{identifier:id}},{set(){},status(n){status=n;return this;},json(){}},()=>{});return status;};
  for(let i=0;i<10;i++)assert.equal(invoke('broker@test.example'),200);
  assert.equal(invoke('broker@test.example'),429);assert.equal(invoke('other@test.example'),200);
  time=1001;assert.equal(invoke('broker@test.example'),200);
});
