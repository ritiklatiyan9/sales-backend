import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { createHash } from 'node:crypto';
import { migrateBrokerMobileAuth } from '../migrations/044_broker_mobile_auth.js';
import { PGlite } from '@electric-sql/pglite';
import { createBrokerMobileService } from './brokerMobile.service.js';
import { createBrokerPresentation } from './brokerPresentation.service.js';
import { createBrokerMobileRouter, createBrokerMobileLoginLimiter } from '../routes/brokerMobile.routes.js';
import { postingPolicySql } from '../test/mobilePostingPolicy.fixture.mjs';

const credentials={mobile:'9876500001',password:'234567890123'};
async function fixture() {
  const db=new PGlite();
  await db.exec(`
    CREATE TABLE organizations(id integer PRIMARY KEY,name text);
    INSERT INTO organizations VALUES(1,'Private Organization Brand'),(2,'Other Organization Brand');
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
  const pid=id=>createBrokerPresentation(session).propertyId(id);
  const cid=id=>createBrokerPresentation(session).clientId(id);
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
    assert.deepEqual(portfolio.clients.flatMap(c=>c.plots.map(p=>p.id)).sort(),['1','13','7'].map(pid).sort());
    assert.deepEqual(portfolio.clients.map(c=>c.id).sort(),['10','11','13','20'].map(cid).sort());
    assert.equal(portfolio.clients.find(c=>c.id===cid('11')).plots.length,0);
    assert.equal(portfolio.summary.clientCount,4);assert.equal(portfolio.summary.plotCount,3);
    for(const id of ['2','3','4','5','6','8','9','10','11','12','14','999','2147483648','1 OR 1=1'])await assert.rejects(service.plot(session,pid(id)),{statusCode:404});
  });
  await t.test('cash and direct receipts, approved refunds and the same posting math are preserved',async()=>{
    const {plot}=await service.plot(session,pid('1'));
    assert.equal(plot.paidAmount,225);assert.equal(plot.balanceAmount,775);
    assert.deepEqual(plot.installments.map(i=>i.paidAmount),[175,50]);
    assert.equal(plot.payments.length,4);assert.ok(plot.payments.some(p=>p.mode==='CASH'));
    assert.ok(plot.payments.some(p=>p.status==='refund'));assert.ok(!plot.payments.some(p=>p.reference==='UNCLEARED'||p.reference==='WRONG-SITE'));
  });
  await t.test('whitelisted DTOs exclude identity, bank, document and company data; histories are lazy',async()=>{
    const portfolio=await service.portfolio(session);const {plot}=await service.plot(session,pid('1'));
    for(const value of [portfolio,plot]){
      const json=JSON.stringify(value);
      assert.ok(!/aadhaar|aadhar|pan_no|passport|account_no|document|BANK-PRIVATE|PASSPORT-PRIVATE|567890123456|5678 9012 3456|ABCDE1234F|Private Company Branding|Other Site Name/i.test(json));
    }
    assert.ok(portfolio.clients.every(c=>c.plots.every(p=>!Object.hasOwn(p,'payments'))));
    assert.deepEqual(Object.keys(portfolio.clients[0]).sort(),['id','name','phone','email','address','city','state','pincode','plots'].sort());
    assert.equal(plot.projectName,'Your Property');
    assert.ok(plot.payments.every(p=>/^Receipt RX-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/.test(p.reference)));
  });
  await t.test('opaque references work on cold readers, reject numeric ids and stay broker-specific',async()=>{
    const cold=createBrokerMobileService(db,{bcryptRounds:4});
    assert.equal((await cold.plot(session,pid('1'))).plot.id,pid('1'));
    for(const id of ['1','117','1 OR 1=1','pr_invalid'])await assert.rejects(cold.plot(session,id),{statusCode:404});
    const other=await service.getSession((await service.login({mobile:'9876500002',password:'345678901234'})).token);
    const otherId=createBrokerPresentation(other).propertyId('2');
    assert.equal((await cold.plot(other,otherId)).plot.number,'A2');
    await assert.rejects(cold.plot(other,pid('1')),{statusCode:404});
    await assert.rejects(cold.plot(session,otherId),{statusCode:404});
  });
  await t.test('matching plot numbers in different sites retain distinct private collections and property references',async()=>{
    await db.exec("UPDATE plots SET plot_no='A1' WHERE id=7");
    const portfolio=await service.portfolio(session);
    const plots=portfolio.clients.flatMap(client=>client.plots).filter(plot=>plot.number==='A1');
    assert.equal(plots.length,2);
    assert.equal(new Set(plots.map(plot=>plot.propertyRef)).size,2);
    assert.equal(new Set(plots.map(plot=>plot.collectionId)).size,2);
    assert.equal(new Set(plots.map(plot=>plot.collectionLabel)).size,2);
    assert.equal(portfolio.collections.length,2);
    assert.equal(portfolio.collections.reduce((sum,collection)=>sum+collection.plotCount,0),portfolio.summary.plotCount);
    for(const plot of plots){
      assert.match(plot.collectionId,/^col_[a-f0-9]{32}$/);
      assert.match(plot.propertyRef,/^RA-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/);
      assert.ok(!Object.hasOwn(plot,'siteId'));assert.ok(!Object.hasOwn(plot,'projectId'));
    }
    await db.exec("UPDATE plots SET plot_no='B1' WHERE id=7");
  });
  await t.test('authoritative site and organization brands are redacted from contacts and signed-in broker names',async()=>{
    await db.exec(`UPDATE members SET full_name='Partner A | PrivateCompanyBranding' WHERE id=101;
      UPDATE members SET address='Private Organization Brand, 42 Example Street',email='contact@privatecompanybranding.example' WHERE id=10`);
    const refreshed=await service.getSession(login.token);
    assert.equal(refreshed.user.name,'Partner A');
    const portfolio=await service.portfolio(refreshed);
    assert.equal(portfolio.presentationVersion,3,'the profile confidentiality contract is explicit in each portfolio response');
    assert.deepEqual(portfolio.broker,{id:login.user.id,name:'Partner A',role:'broker'},'portfolio refreshes the sanitized broker profile without replacing session identity');
    const client=portfolio.clients.find(row=>row.id===cid('10'));
    assert.equal(client.address,'[Private], 42 Example Street');
    assert.equal(client.email,'');
    assert.ok(!/Private.?Company.?Branding|Private.?Organization.?Brand/i.test(JSON.stringify(portfolio)));
    await db.exec(`UPDATE members SET full_name='Partner A' WHERE id=101;
      UPDATE members SET address='42 Example Street',email='client@test.example' WHERE id=10`);
  });
  await t.test('scope changes take effect immediately while financial cache is warm',async()=>{
    await service.portfolio(session);
    await db.exec('UPDATE bookings SET booking_agent_id=102 WHERE id=1');
    await assert.rejects(service.plot(session,pid('1')),{statusCode:404});
    assert.ok(!(await service.portfolio(session)).clients.flatMap(c=>c.plots).some(p=>p.id===pid('1')));
    await db.exec('UPDATE bookings SET booking_agent_id=101 WHERE id=1; UPDATE plots SET buyer_member_id=11 WHERE id=1');
    await assert.rejects(service.plot(session,pid('1')),{statusCode:404});
    await db.exec('UPDATE plots SET buyer_member_id=10 WHERE id=1; DELETE FROM user_sites WHERE user_id=1 AND site_id=2');
    await assert.rejects(service.getSession(login.token),{statusCode:401});session=await service.getSession((await service.login(credentials)).token);await assert.rejects(service.plot(session,pid('7')),{statusCode:404});
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
    assert.ok(!portfolio.clients.some(c=>c.id===cid('10')||c.id===cid('20')));
    for(const id of ['1','7'])await assert.rejects(service.plot(fresh,pid(id)),{statusCode:404});
    await db.exec("UPDATE members SET status='ACTIVE' WHERE id IN (10,201)");
  });
  await t.test('financial reads batch, cache and refresh without per-client queries',async()=>{
    const first=queries.length;await service.portfolio(session);
    assert.equal(queries.length-first,5,'warm finance cache retains batched scope/client SQL and the post-read reminder-authority guard');
    const second=queries.length;await service.portfolio(session,{forceFresh:true});assert.equal(queries.length-second,7);
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
  const pid=id=>createBrokerPresentation(session).propertyId(id);
  const cid=id=>createBrokerPresentation(session).clientId(id);
  const permitted=['21','22','23','24','25','36','37','40'];
  await t.test('explicit commission membership grants Accounts-only and other-primary plots once each',async()=>{
    const portfolio=await service.portfolio(session);
    const ids=portfolio.clients.flatMap(client=>client.plots.map(plot=>plot.id));
    for(const id of permitted)assert.equal(ids.filter(value=>value===pid(id)).length,1,`commission-linked plot ${id}`);
    for(const id of ['26','27','28','29','30','31','32','33','34','35','38','39','41','42','43']){
      assert.ok(!ids.includes(pid(id)));await assert.rejects(service.plot(session,pid(id)),{statusCode:404});
    }
    assert.equal(portfolio.clients.find(client=>client.id===cid('40')).name,'Accounts Only Buyer','explicit buyer ID beats the recorded label');
    assert.equal(portfolio.clients.find(client=>client.id===cid('46')).phone,'9876590046','unique current ledger name resolves its same-site contact');
    assert.equal(portfolio.clients.find(client=>client.id===cid('44')).phone,'9876590044','a current explicit buyer can have another member role');
    assert.ok(!JSON.stringify(portfolio).match(/912345678901|ZZZZZ1234Z|PRIVATE-ACCOUNTS-BANK/));
    const disabled=createBrokerMobileService(db,{includeCommissionPlots:false,bcryptRounds:4});
    const without=await disabled.portfolio(session);
    assert.ok(without.clients.flatMap(client=>client.plots).every(plot=>!permitted.map(pid).includes(plot.id)));
  });
  await t.test('ambiguous, cross-site and inactive buyer identities keep only recorded names and blank contacts',async()=>{
    const portfolio=await service.portfolio(session);
    for(const [id,name]of[['23','Duplicate Ledger Buyer'],['24','Fallback Name Contact'],['36','Inactive Ledger Buyer']]){
      const client=portfolio.clients.find(row=>row.id===cid(`plot-owner:${id}`));
      assert.ok(client,`safe recorded owner for plot ${id}`);assert.equal(client.name,name);
      for(const key of['phone','email','address','city','state','pincode'])assert.equal(client[key],'');
      assert.deepEqual(client.plots.map(plot=>plot.id),[pid(id)]);
    }
    assert.ok(!portfolio.clients.some(client=>['41','42','43','45','47'].map(cid).includes(client.id)));
    assert.ok(!/PRIVATE-DUPLICATE-ADDRESS|PRIVATE-CROSSSITE-ADDRESS|PRIVATE-FALLBACK-ADDRESS|PRIVATE-INACTIVE-ADDRESS/.test(JSON.stringify(portfolio)));
  });
  await t.test('commission access shares cash, bank, refunds, installment allocation and lazy financial histories',async()=>{
    const{plot}=await service.plot(session,pid('21'));
    assert.equal(plot.number,'LEGACY-1');assert.equal(plot.area,150);
    assert.equal(plot.totalAmount,1000);assert.equal(plot.paidAmount,450);assert.equal(plot.balanceAmount,550);
    assert.deepEqual(plot.installments.map(row=>row.paidAmount),[200,250]);
    assert.equal(plot.payments.length,3);assert.ok(plot.payments.some(row=>row.mode==='CASH'));
    assert.ok(plot.payments.some(row=>row.status==='refund'));
    assert.ok((await service.portfolio(session)).clients.every(client=>client.plots.every(row=>!Object.hasOwn(row,'payments'))));
  });
  await t.test('changing or removing commission entitlement revokes access even with warm financial caches',async()=>{
    await service.plot(session,pid('21'));await service.portfolio(session);
    await db.exec('UPDATE plot_commissions_v2 SET agent_id=102 WHERE plot_id=21');
    await assert.rejects(service.plot(session,pid('21')),{statusCode:404});
    assert.ok(!(await service.portfolio(session)).clients.flatMap(client=>client.plots).some(plot=>plot.id===pid('21')));
    await db.exec('UPDATE plot_commissions_v2 SET agent_id=101 WHERE id=501');
    assert.equal((await service.plot(session,pid('21'))).plot.id,pid('21'));
    await db.exec('DELETE FROM plot_commissions_v2 WHERE id=501');
    await assert.rejects(service.plot(session,pid('21')),{statusCode:404});
    await db.exec("UPDATE plot_commissions_v2 SET agent_id=101,status='Cancelled' WHERE id=520");
    await assert.rejects(service.plot(session,pid('21')),{statusCode:404});
  });
});

test('broker detail timeline uses current scope and rejects changes during slow reads',async t=>{
  const previous=process.env.MOBILE_PORTAL_SECRET;
  process.env.MOBILE_PORTAL_SECRET='synthetic-test-only-broker-timeline-secret-long-enough';
  const db=await fixture();
  let duringFinance;
  const service=createBrokerMobileService({...db,query:async(sql,args)=>{
    const result=await db.query(sql,args);
    if(duringFinance && /FROM plot_installments pi WHERE/.test(sql)){
      const change=duringFinance;duringFinance=null;await change();
    }
    return result;
  }},{bcryptRounds:4});
  t.after(async()=>{await db.close();if(previous===undefined)delete process.env.MOBILE_PORTAL_SECRET;else process.env.MOBILE_PORTAL_SECRET=previous;});
  const session=await service.getSession((await service.login(credentials)).token);
  const id=createBrokerPresentation(session).propertyId(1);
  await t.test('additive timeline stays lazy, contains only safe milestones and follows current status',async()=>{
    const portfolio=await service.portfolio(session);
    assert.ok(portfolio.clients.every(c=>c.plots.every(p=>!Object.hasOwn(p,'bookingProgress'))));
    const {plot}=await service.plot(session,id,{forceFresh:true});
    assert.equal(plot.buyerName,'Client Alpha');
    assert.equal(plot.bookingProgress.currentStage,'booked');
    assert.ok(Array.isArray(plot.bookingProgress.milestones));
    assert.ok(!JSON.stringify(plot.bookingProgress).includes('567890123456'));
    await db.exec("UPDATE plots SET status='UNDER CANCELLATION' WHERE id=1");
    assert.equal((await service.plot(session,id,{forceFresh:true})).plot.bookingProgress.currentStage,'cancellation_pending');
    await db.exec("UPDATE plots SET status='BOOKED' WHERE id=1");
  });
  await t.test('buyer reassignment during finance cannot return old details or timeline',async()=>{
    duringFinance=()=>db.exec('UPDATE plots SET buyer_member_id=13 WHERE id=1; UPDATE bookings SET client_member_id=13 WHERE id=1');
    await assert.rejects(service.plot(session,id,{forceFresh:true}),{statusCode:404});
    assert.equal((await service.plot(session,id,{forceFresh:true})).plot.buyerName,'Explicit Booking Client');
    await db.exec('UPDATE plots SET buyer_member_id=10 WHERE id=1; UPDATE bookings SET client_member_id=10 WHERE id=1');
  });
  await t.test('cancellation removing current broker authority blocks an in-flight detail',async()=>{
    duringFinance=()=>db.exec("UPDATE bookings SET status='CANCELLED' WHERE id=1");
    await assert.rejects(service.plot(session,id,{forceFresh:true}),{statusCode:404});
    await db.exec("UPDATE bookings SET status='CONFIRMED' WHERE id=1");
  });
  await t.test('account revocation during finance is checked before returning a timeline',async()=>{
    duringFinance=()=>db.query('UPDATE booking_broker_mobile_accounts SET is_active=false WHERE id=$1',[session.account.id]);
    await assert.rejects(service.plot(session,id,{forceFresh:true}),{statusCode:401});
    await db.query('UPDATE booking_broker_mobile_accounts SET is_active=true WHERE id=$1',[session.account.id]);
  });
});

test('broker commissions use exact Accounts member amounts, posted settlements and current authority',async t=>{
  const previous=process.env.MOBILE_PORTAL_SECRET;
  process.env.MOBILE_PORTAL_SECRET='synthetic-test-only-broker-commission-secret-long-enough';
  const db=await fixture();
  t.after(async()=>{await db.close();if(previous===undefined)delete process.env.MOBILE_PORTAL_SECRET;else process.env.MOBILE_PORTAL_SECRET=previous;});
  await db.exec(`
    ALTER TABLE plots ADD COLUMN plot_commission numeric DEFAULT 999999;
    CREATE TABLE plot_commission_payments(id integer PRIMARY KEY,site_id integer,plot_commission_id integer,date date,
      amount numeric,tds_amount numeric DEFAULT 0,payment_mode text,status text,cheque_status text,remarks text);
    INSERT INTO plot_commissions_v2 VALUES
      (1,1,1,101,100000,'Partial'),(2,2,7,201,50000,'Completed'),(3,1,2,101,20000,'Pending'),(4,1,13,101,1000,'Pending'),
      (5,1,1,102,800000,'Completed'),(6,2,14,202,777777,'Pending'),(7,3,8,301,888888,'Pending'),
      (8,1,7,101,123456,'Pending'),(9,1,1,101,200000,'Cancelled'),(10,1,NULL,101,999999,'Pending');
    INSERT INTO plot_commission_payments VALUES
      (1,1,1,'2026-01-01',40000,5000,'BANK','approved',NULL,'Private Organization Brand BANK-PRIVATE'),
      (2,1,1,'2026-01-02',5000,0,'CHEQUE','approved','CLEARED',NULL),
      (3,1,1,'2026-01-03',9999,0,'BANK','pending',NULL,NULL),
      (4,1,1,'2026-01-03',9999,0,'CASH','rejected',NULL,NULL),
      (5,1,1,'2026-01-03',9999,0,'CHEQUE','approved','UNCLEARED',NULL),
      (6,1,1,'22022-01-03',9999,0,'BANK','approved',NULL,NULL),
      (7,2,1,'2026-01-03',9999,0,'BANK','approved',NULL,NULL),
      (8,2,2,'2026-01-03',60000,0,'CASH','approved',NULL,NULL),
      (9,1,4,'2026-01-03',-500,0,'BANK','pending',NULL,NULL),
      (10,1,5,'2026-01-03',800000,0,'CASH','approved',NULL,NULL);
  `);
  let duringCommission;
  const service=createBrokerMobileService({...db,query:async(sql,args)=>{
    const result=await db.query(sql,args);
    if(duringCommission && /AS received_amount|AS payment_records/.test(sql)){
      const change=duringCommission;duringCommission=null;await change();
    }
    return result;
  }},{bcryptRounds:4});
  const session=await service.getSession((await service.login(credentials)).token);
  const pid=id=>createBrokerPresentation(session).propertyId(id);
  await t.test('totals exclude co-brokers, shared phones, mismatched sites, land and cancelled commission records',async()=>{
    const response=await service.commissions(session);
    assert.equal(response.commissionVersion,1);
    assert.deepEqual(response.commissions.map(row=>row.plotId).sort(),[1,2,7,13].map(pid).sort());
    assert.deepEqual(response.summary,{plotCount:4,totalAmount:171000,paidAmount:109500,remainingAmount:71500,receivedAmount:104500,tdsAmount:5000,extraPaidAmount:10000,originalCommission:171000,paidOutAmount:110000,recoveredAmount:500,recoverableAmount:10000,tdsAdjustmentAmount:0});
    const first=response.commissions.find(row=>row.plotId===pid(1));
    assert.equal(first.totalAmount,100000,'whole-plot commission must not replace this broker\'s record');
    assert.equal(first.paidAmount,50000);assert.equal(first.receivedAmount,45000);assert.equal(first.tdsAmount,5000);
    assert.equal(first.remainingAmount,50000);assert.equal(first.status,'part_paid');
    assert.equal(first.plotSize,120);assert.equal(first.plotSizeUnit,'sq yd');assert.equal(first.buyerName,'Client Alpha');
    const extra=response.commissions.find(row=>row.plotId===pid(7));
    assert.equal(extra.status,'overpaid');assert.equal(extra.remainingAmount,0);assert.equal(extra.extraPaidAmount,10000);
    const correction=response.commissions.find(row=>row.plotId===pid(13));
    assert.equal(correction.paidAmount,-500);assert.equal(correction.remainingAmount,1500);
    assert.ok(!/Private Organization Brand|Private Company Branding|BANK-PRIVATE|agent_id|site_id|remarks/.test(JSON.stringify(response)));
  });
  await t.test('plot transaction detail reconciles exact posted cash and tax while showing unposted entries separately',async()=>{
    const response=await service.commission(session,pid(1));
    assert.equal(response.transactionVersion,1);assert.equal(response.commissionVersion,1);
    assert.deepEqual(response.commission,(await service.commissions(session)).commissions.find(row=>row.plotId===pid(1)));
    assert.equal(response.transactions.length,5,'invalid dates, wrong sites and co-broker payments must be absent');
    assert.deepEqual(response.transactions.map(row=>row.date),['2026-01-03','2026-01-03','2026-01-03','2026-01-02','2026-01-01']);
    assert.deepEqual(response.transactions.map(row=>row.status),['pending','rejected','pending','posted','posted']);
    assert.equal(response.transactions.filter(row=>row.contributesToPaid).reduce((sum,row)=>sum+row.amount,0),45000);
    assert.equal(response.transactions.filter(row=>row.contributesToPaid).reduce((sum,row)=>sum+row.tdsAmount,0),5000);
    assert.equal(response.transactions.filter(row=>row.contributesToPaid).reduce((sum,row)=>sum+row.totalAmount,0),response.commission.paidAmount);
    for(const row of response.transactions){assert.match(row.id,/^ct_[a-f0-9]{32}$/);assert.equal(row.kind,'payment');}
    assert.equal(new Set(response.transactions.map(row=>row.id)).size,5);
    assert.deepEqual((await service.commission(session,pid(1))).transactions,response.transactions,'opaque IDs remain stable');
    assert.ok(!/Private Organization Brand|Private Company Branding|BANK-PRIVATE|agent_id|site_id|remarks|bank_name|transaction_id|cheque_no|voucher|tds_pan|aadhaar/.test(JSON.stringify(response)));
  });
  await t.test('detail rejects invalid, cross-broker, unknown and booked-without-commission property ids',async()=>{
    const other=await service.getSession((await service.login({mobile:'9876500002',password:'345678901234'})).token);
    for(const id of ['1','pr_bad',`pr_${'f'.repeat(32)}`,createBrokerPresentation(other).propertyId(1),pid(3)]){
      await assert.rejects(service.commission(session,id),{statusCode:404});
    }
    const refund=await service.commission(session,pid(13));
    assert.equal(refund.transactions[0].kind,'refund');assert.equal(refund.transactions[0].amount,-500);
    assert.equal(refund.transactions[0].status,'posted');assert.equal(refund.transactions[0].contributesToPaid,true);
    assert.equal(refund.commission.paidAmount,-500);assert.equal(refund.commission.remainingAmount,1500);
  });
  await t.test('bounced, cancelled and private payment labels are normalized without changing posted totals',async()=>{
    await db.exec(`INSERT INTO plot_commission_payments VALUES
      (11,1,1,'2026-01-04',8000,0,'CHEQUE','approved','BOUNCED','PRIVATE FREEFORM'),
      (12,1,1,'2026-01-04',9000,0,'BANK','voided',NULL,NULL),
      (13,1,1,'2026-01-04',10000,500,'Private Company Branding BANK-PRIVATE','pending',NULL,NULL)`);
    const detail=await service.commission(session,pid(1));
    assert.deepEqual(detail.transactions.slice(0,3).map(row=>row.status),['pending','cancelled','bounced']);
    assert.equal(detail.transactions[0].paymentMode,'OTHER');
    assert.ok(detail.transactions.slice(0,3).every(row=>!row.contributesToPaid));
    assert.equal(detail.commission.paidAmount,50000);
    assert.ok(!/PRIVATE FREEFORM|Private Company Branding|BANK-PRIVATE/.test(JSON.stringify(detail)));
    await db.exec('DELETE FROM plot_commission_payments WHERE id IN (11,12,13)');
  });
  await t.test('multiple owned commission masters for a plot retain exact payment snapshot and separate entries',async()=>{
    await db.exec(`INSERT INTO plot_commissions_v2 VALUES(11,1,1,101,10000,'Partial');
      INSERT INTO plot_commission_payments VALUES(11,1,11,'2026-01-05',4950.15,49.85,'UPI','approved',NULL,NULL)`);
    const detail=await service.commission(session,pid(1));
    assert.equal(detail.commission.totalAmount,110000);assert.equal(detail.commission.paidAmount,55000);
    assert.equal(detail.transactions[0].totalAmount,5000);assert.equal(detail.transactions[0].paymentMode,'UPI');
    assert.equal(detail.commission.receivedAmount,49950.15);assert.equal(detail.commission.tdsAmount,5049.85);
    assert.deepEqual(detail.commission,(await service.commissions(session)).commissions.find(row=>row.plotId===pid(1)));
    await db.exec('DELETE FROM plot_commission_payments WHERE id=11; DELETE FROM plot_commissions_v2 WHERE id=11');
  });
  await t.test('30/50/20 shop split exposes only each broker allocation and own settlement history',async()=>{
    await db.exec(`ALTER TABLE plot_commissions_v2 ADD COLUMN allocation_type text,
        ADD COLUMN allocation_value numeric,ADD COLUMN allocation_base numeric;
      ALTER TABLE plots ADD COLUMN unit_type text DEFAULT 'plot';
      UPDATE plots SET unit_type='shop',status='REGISTERED' WHERE id=2;
      UPDATE plot_commissions_v2 SET total_commission=30000,allocation_type='percentage',
        allocation_value=30,allocation_base=100000 WHERE id=3;
      INSERT INTO members(id,site_id,full_name,phone,aadhar_no,member_type)
        VALUES(103,1,'Third Partner','9876500099','456789012345','BROKER');
      INSERT INTO plot_commissions_v2(id,site_id,plot_id,agent_id,total_commission,status,allocation_type,allocation_value,allocation_base)
        VALUES(11,1,2,102,50000,'Partial','percentage',50,100000),(12,1,2,103,20000,'Partial','percentage',20,100000);
      INSERT INTO plot_commission_payments VALUES
        (11,1,3,'2026-01-05',3000,0,'UPI','approved',NULL,NULL),
        (12,1,11,'2026-01-05',5000,0,'CASH','approved',NULL,NULL),
        (13,1,12,'2026-01-05',2000,0,'BANK','approved',NULL,NULL)`);
    const own=await service.commission(session,pid(2));
    assert.equal(own.commission.propertyType,'SHOP');
    assert.equal(own.commission.plotSizeUnit,'sq ft');
    assert.equal(own.commission.totalAmount,30000);
    assert.equal(own.commission.paidAmount,3000);
    assert.deepEqual(own.commission.allocations,[{type:'percentage',value:30,amount:30000,originalAmount:30000}]);
    assert.equal(own.transactions.length,1);
    assert.equal(own.transactions[0].amount,3000);
    assert.ok(!/allocation_base|allocation_value|agent_id|Third Partner|50000|20000/.test(JSON.stringify(own)));
    assert.deepEqual(own.commission,(await service.commissions(session)).commissions.find(row=>row.plotId===pid(2)));
    const other=await service.getSession((await service.login({mobile:'9876500002',password:'345678901234'})).token);
    const otherDetail=await service.commission(other,createBrokerPresentation(other).propertyId(2));
    assert.deepEqual(otherDetail.commission.allocations,[{type:'percentage',value:50,amount:50000,originalAmount:50000}]);
    assert.equal(otherDetail.transactions.length,1);
    assert.equal(otherDetail.transactions[0].amount,5000);
    assert.notEqual(otherDetail.transactions[0].id,own.transactions[0].id);
    await db.exec("UPDATE plot_commissions_v2 SET allocation_type='amount',allocation_value=30000 WHERE id=3");
    assert.deepEqual((await service.commission(session,pid(2))).commission.allocations,[{type:'amount',value:30000,amount:30000,originalAmount:30000}]);
    // The commission amount can remain the same while its agreed percentage
    // changes; it still must not escape the current-authority recheck.
    duringCommission=()=>db.exec("UPDATE plot_commissions_v2 SET allocation_type='percentage',allocation_value=30 WHERE id=3");
    await assert.rejects(service.commission(session,pid(2)),{statusCode:503});
    await db.exec(`DELETE FROM plot_commission_payments WHERE id IN(11,12,13);
      DELETE FROM plot_commissions_v2 WHERE id IN(11,12);DELETE FROM members WHERE id=103;
      UPDATE plots SET unit_type='plot',status='BOOKED' WHERE id=2;
      UPDATE plot_commissions_v2 SET total_commission=20000,allocation_type=NULL,
        allocation_value=NULL,allocation_base=NULL WHERE id=3`);
    assert.deepEqual((await service.commission(session,pid(2))).commission.allocations,[{type:'amount',value:20000,amount:20000,originalAmount:20000}]);
  });
  await t.test('explicit cross-site commission grants only the assigned same-organization property',async()=>{
    await db.exec(`INSERT INTO sites VALUES(4,'Unassigned Site Same Organization',1);
      INSERT INTO members(id,site_id,full_name,phone,member_type) VALUES(50,4,'Cross Site Client','9876590050','CLIENT');
      INSERT INTO plots(id,site_id,plot_no,plot_size,sale_price,status,buyer_member_id,buyer_name) VALUES
        (50,4,'CROSS-SITE-OWN',120,1000,'SOLD',50,'Cross Site Client'),
        (51,4,'CROSS-SITE-UNASSIGNED',120,1000,'SOLD',50,'Cross Site Client'),
        (52,3,'CROSS-ORG-DENIED',120,1000,'SOLD',30,'Other Org Client'),
        (53,4,'CROSS-SITE-OTHER',120,1000,'SOLD',50,'Cross Site Client');
      INSERT INTO plot_commissions_v2(id,site_id,plot_id,agent_id,total_commission,status,allocation_type,allocation_value,allocation_base) VALUES
        (50,4,50,101,30000,'Partial','percentage',30,100000),
        (51,3,52,101,90000,'Partial','percentage',90,100000),
        (52,4,53,102,50000,'Partial','percentage',50,100000),
        (53,4,50,301,20000,'Partial','percentage',20,100000);
      INSERT INTO plot_commission_payments VALUES
        (50,4,50,'2026-01-05',3000,0,'UPI','approved',NULL,NULL),
        (51,1,50,'2026-01-05',9999,0,'CASH','approved',NULL,NULL),
        (52,4,52,'2026-01-05',5000,0,'BANK','approved',NULL,NULL)`);
    assert.deepEqual(session.siteIds,[1,2], 'target site is never added to authenticated site grants');
    const portfolio=await service.portfolio(session);
    const properties=portfolio.clients.flatMap(client=>client.plots);
    assert.equal(properties.filter(plot=>plot.id===pid(50)).length,1);
    assert.equal((await service.plot(session,pid(50))).plot.id,pid(50));
    for(const id of [51,52,53]) {
      assert.ok(!properties.some(plot=>plot.id===pid(id)));
      await assert.rejects(service.plot(session,pid(id)),{statusCode:404});
      await assert.rejects(service.commission(session,pid(id)),{statusCode:404});
    }
    const own=await service.commission(session,pid(50));
    assert.equal(own.commission.totalAmount,30000);
    assert.deepEqual(own.commission.allocations,[{type:'percentage',value:30,amount:30000,originalAmount:30000}]);
    assert.equal(own.transactions.length,1);
    assert.equal(own.transactions[0].amount,3000);
    assert.deepEqual((await service.getDeviceSession({accountId:session.account.id,version:session.account.token_version,identity:session.identity})).siteIds,[1,2]);
    await db.exec('DELETE FROM plot_commission_payments WHERE id IN(50,51,52);DELETE FROM plot_commissions_v2 WHERE id IN(50,51,52,53)');
    await assert.rejects(service.plot(session,pid(50)),{statusCode:404});
    await assert.rejects(service.commission(session,pid(50)),{statusCode:404});
    await db.exec('DELETE FROM plots WHERE id IN(50,51,52,53);DELETE FROM members WHERE id=50;DELETE FROM sites WHERE id=4');
  });
  await t.test('detail fails closed after reassignment, buyer change or session revocation during transaction read',async()=>{
    duringCommission=()=>db.exec('UPDATE plot_commissions_v2 SET agent_id=102 WHERE id=1');
    await assert.rejects(service.commission(session,pid(1)),{statusCode:503});
    await assert.rejects(service.commission(session,pid(1)),{statusCode:404});
    await db.exec('UPDATE plot_commissions_v2 SET agent_id=101 WHERE id=1');
    duringCommission=()=>db.exec('UPDATE plots SET buyer_member_id=13 WHERE id=1; UPDATE bookings SET client_member_id=13 WHERE id=1');
    await assert.rejects(service.commission(session,pid(1)),{statusCode:503});
    await db.exec('UPDATE plots SET buyer_member_id=10 WHERE id=1; UPDATE bookings SET client_member_id=10 WHERE id=1');
    duringCommission=()=>db.query('UPDATE booking_broker_mobile_accounts SET is_active=false WHERE id=$1',[session.account.id]);
    await assert.rejects(service.commission(session,pid(1)),{statusCode:401});
    await db.query('UPDATE booking_broker_mobile_accounts SET is_active=true WHERE id=$1',[session.account.id]);
  });
  await t.test('detail refuses to truncate oversized transaction history',async()=>{
    await db.exec(`INSERT INTO plot_commission_payments(id,site_id,plot_commission_id,date,amount,tds_amount,payment_mode,status)
      SELECT x,1,3,'2026-01-01',0,0,'BANK','pending' FROM generate_series(100,10100) x`);
    await assert.rejects(service.commission(session,pid(2)),{statusCode:503});
    await db.exec('DELETE FROM plot_commission_payments WHERE id>=100');
  });
  await t.test('reassigning commission during its payment read fails even when booking access remains',async()=>{
    duringCommission=()=>db.exec('UPDATE plot_commissions_v2 SET agent_id=102 WHERE id=1');
    await assert.rejects(service.commissions(session),{statusCode:503});
    assert.ok(!(await service.commissions(session)).commissions.some(row=>row.plotId===pid(1)));
    await db.exec('UPDATE plot_commissions_v2 SET agent_id=101 WHERE id=1');
  });
  await t.test('buyer changes and broker session revocation during payment reads fail closed',async()=>{
    duringCommission=()=>db.exec('UPDATE plots SET buyer_member_id=13 WHERE id=1; UPDATE bookings SET client_member_id=13 WHERE id=1');
    await assert.rejects(service.commissions(session),{statusCode:503});
    await db.exec('UPDATE plots SET buyer_member_id=10 WHERE id=1; UPDATE bookings SET client_member_id=10 WHERE id=1');
    duringCommission=()=>db.query('UPDATE booking_broker_mobile_accounts SET is_active=false WHERE id=$1',[session.account.id]);
    await assert.rejects(service.commissions(session),{statusCode:401});
    await db.query('UPDATE booking_broker_mobile_accounts SET is_active=true WHERE id=$1',[session.account.id]);
  });
  await t.test('fresh payment and commission updates are visible with no financial cache',async()=>{
    await db.exec("UPDATE plot_commission_payments SET amount=45000 WHERE id=1; UPDATE plot_commissions_v2 SET total_commission=110000 WHERE id=1");
    const first=(await service.commissions(session)).commissions.find(row=>row.plotId===pid(1));
    assert.equal(first.totalAmount,110000);assert.equal(first.paidAmount,55000);assert.equal(first.remainingAmount,55000);
    await db.exec('DELETE FROM plot_commissions_v2');
    const empty=await service.commissions(session);
    assert.deepEqual(empty.commissions,[]);assert.equal(empty.summary.plotCount,0);assert.equal(empty.summary.totalAmount,0);
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
  assert.equal(status.body.bookingProgressVersion,1);
  assert.equal((await invoke(off,'GET','/portfolio')).status,503);assert.equal(touched,false);
  const on=createBrokerMobileRouter(service,{isEnabled:()=>true});
  const anon=await invoke(on,'GET','/portfolio');assert.equal(anon.status,401);assert.match(anon.headers['Cache-Control'],/no-store/);
  assert.equal((await invoke(on,'GET','/commissions')).status,401);
  assert.equal((await invoke(on,'GET',`/commissions/pr_${'f'.repeat(32)}`)).status,401);
  const bad=await invoke(on,'GET','/portfolio',{'authorization':'Bearer test.token.value'});assert.equal(bad.status,503);assert.ok(!JSON.stringify(bad).includes('secret'));
});

test('broker limiter separates identifiers, bounds repeated guesses and expires',()=>{
  let time=0;const limiter=createBrokerMobileLoginLimiter({now:()=>time,windowMs:1000});
  const invoke=id=>{let status=200;limiter({ip:'one-ip',body:{identifier:id}},{set(){},status(n){status=n;return this;},json(){}},()=>{});return status;};
  for(let i=0;i<10;i++)assert.equal(invoke('broker@test.example'),200);
  assert.equal(invoke('broker@test.example'),429);assert.equal(invoke('other@test.example'),200);
  time=1001;assert.equal(invoke('broker@test.example'),200);
});

test('cancelled booking commissions keep three old brokers separate from the two new brokers', async t => {
  const previous = process.env.MOBILE_PORTAL_SECRET;
  process.env.MOBILE_PORTAL_SECRET = 'synthetic-only-five-broker-history-secret-long-enough';
  const db = await fixture();
  t.after(async () => { await db.close(); if (previous === undefined) delete process.env.MOBILE_PORTAL_SECRET; else process.env.MOBILE_PORTAL_SECRET = previous; });
  await db.exec(`ALTER TABLE plots ADD COLUMN unit_type text DEFAULT 'plot',
      ADD COLUMN booking_cancelled_at timestamptz,ADD COLUMN previous_booking_plot_id int,ADD COLUMN approval_status text DEFAULT 'approved';
    ALTER TABLE plot_commissions_v2 ADD COLUMN allocation_type text,ADD COLUMN allocation_value numeric,
      ADD COLUMN allocation_base numeric,ADD COLUMN settlement_commission numeric,
      ADD COLUMN settlement_percent numeric,ADD COLUMN settled_at timestamptz;
    CREATE TABLE plot_commission_payments(id int PRIMARY KEY,site_id int,plot_commission_id int,date date,
      amount numeric,tds_amount numeric DEFAULT 0,payment_mode text,status text,cheque_status text,remarks text);
    INSERT INTO members(id,site_id,full_name,phone,aadhar_no,member_type) VALUES
      (103,1,'Old Broker C','9876500103','567890123456','BROKER'),
      (104,1,'New Broker D','9876500104','678901234567','BROKER'),
      (105,1,'New Broker E','9876500105','789012345678','BROKER'),
      (400,1,'Historical member profile renamed','9876500400','812345678901','CLIENT'),
      (401,1,'New buyer private contact','9876500401','923456789012','CLIENT');
    INSERT INTO plots(id,site_id,plot_no,plot_size,sale_price,booking_date,status,buyer_member_id,buyer_name,booking_cancelled_at,previous_booking_plot_id) VALUES
      (200,1,'HISTORY-A2',100,10000,'2026-09-01','CANCELLED',400,'Old booking buyer snapshot','2026-10-01',NULL),
      (201,1,'HISTORY-A2',100,12000,'2026-11-01','BOOKED',401,'New buyer recorded label',NULL,200);
    INSERT INTO plot_commissions_v2(id,site_id,plot_id,agent_id,total_commission,status,allocation_type,allocation_value,allocation_base,settlement_commission,settled_at) VALUES
      (200,1,200,101,300,'Partial','percentage',30,1000,75,'2026-10-01'),
      (201,1,200,102,500,'Partial','percentage',50,1000,0,'2026-10-01'),
      (202,1,200,103,200,'Partial','amount',200,1000,80,'2026-10-01'),
      (203,1,201,104,600,'Partial','percentage',60,1000,NULL,NULL),
      (204,1,201,105,400,'Pending','amount',400,1000,NULL,NULL);
    INSERT INTO plot_commission_payments VALUES
      (200,1,200,'2026-09-05',200,20,'BANK','approved',NULL,'Private old payment'),
      (201,1,200,'2026-10-05',-50,0,'CASH','approved',NULL,'Recovery of excess commission'),
      (202,1,200,'2026-10-06',-100,0,'CHEQUE','pending','UNCLEARED','Not received yet'),
      (203,1,201,'2026-09-05',0,100,'BANK','approved',NULL,'Tax only; not cash recoverable'),
      (204,1,202,'2026-09-05',20,0,'CASH','approved',NULL,NULL),
      (205,1,203,'2026-11-05',60,0,'BANK','approved',NULL,'New booking payment');`);
  let duringCommission;
  const service = createBrokerMobileService({ ...db, query: async (sql,args) => {
    const result = await db.query(sql,args);
    if (duringCommission && /AS received_amount|AS payment_records/.test(sql)) { const mutate=duringCommission;duringCommission=null;await mutate(); }
    return result;
  } }, { bcryptRounds: 4 });
  const logins = [credentials,{mobile:'9876500002',password:'345678901234'},
    {mobile:'9876500103',password:'567890123456'},{mobile:'9876500104',password:'678901234567'},
    {mobile:'9876500105',password:'789012345678'}];
  const sessions=[];
  for (const login of logins) sessions.push(await service.getSession((await service.login(login)).token));
  const id = (session,raw) => createBrokerPresentation(session).propertyId(raw);
  const oldCards=[];
  for (let i=0;i<3;i++) {
    const session=sessions[i];
    const response=await service.commissions(session);
    assert.equal(response.commissions.length,1);
    const card=response.commissions[0]; oldCards.push(card);
    assert.equal(card.plotId,id(session,200));
    assert.equal(card.historicalBooking,true);assert.equal(card.bookingStatus,'CANCELLED');
    assert.equal(card.bookingDate,'2026-09-01');
    assert.equal(card.buyerName,'Old booking buyer snapshot','Historical name is an immutable old booking label');
    assert.equal(card.settlementKind,'manual');assert.equal(card.settlementPercentage,null);assert.equal(card.settlementApprovalStatus,'approved');
    assert.equal(card.settlementAmount,card.totalAmount);
    assert.ok(!/New buyer|9876500401|Historical member profile renamed|agent_id|settlement_reason/.test(JSON.stringify(response)));
    const details=await service.commission(session,id(session,200));
    assert.deepEqual(details.commission,card);
    assert.equal(details.transactions.filter(row=>row.contributesToPaid).reduce((sum,row)=>sum+row.totalAmount,0),card.paidAmount);
    await assert.rejects(service.commission(session,id(session,201)),{statusCode:404});
    await assert.rejects(service.plot(session,id(session,200)),{statusCode:404});
    await assert.rejects(service.plot(session,id(session,201)),{statusCode:404});
    const portfolio=await service.portfolio(session);
    assert.ok(!portfolio.clients.some(client=>client.plots.some(plot=>[id(session,200),id(session,201)].includes(plot.id))));
    assert.ok(!JSON.stringify(portfolio).includes('New buyer private contact'));
  }
  assert.deepEqual(oldCards.map(row=>[row.originalCommission,row.totalAmount]),[[300,75],[500,0],[200,80]],'Manual decisions are not a fixed25% calculation');
  assert.deepEqual(oldCards[0].allocations,[{type:'percentage',value:30,originalAmount:300,amount:75}]);
  assert.deepEqual([oldCards[0].paidOutAmount,oldCards[0].recoveredAmount,oldCards[0].paidAmount,oldCards[0].recoverableAmount],[220,50,170,95]);
  assert.equal(oldCards[1].extraPaidAmount,100);assert.equal(oldCards[1].recoverableAmount,0);assert.equal(oldCards[1].tdsAdjustmentAmount,100);
  assert.equal(oldCards[2].remainingAmount,60);
  for (let i=3;i<5;i++) {
    const response=await service.commissions(sessions[i]);
    assert.equal(response.commissions.length,1);const card=response.commissions[0];
    assert.equal(card.plotId,id(sessions[i],201));assert.equal(card.historicalBooking,false);
    assert.equal(card.bookingStatus,'BOOKED');assert.equal(card.buyerName,'New buyer private contact');
    assert.equal(card.originalCommission,i===3?600:400);assert.equal(card.totalAmount,card.originalCommission);
    assert.equal(card.settlementAmount,null);assert.equal(card.recoveredAmount,0);
    await assert.rejects(service.commission(sessions[i],id(sessions[i],200)),{statusCode:404});
    assert.ok(!JSON.stringify(response).includes('Old booking buyer snapshot'));
  }
  await t.test('pending and rejected cancellation proposals retain original entitlement and have no actionable recovery',async()=>{
    for(const approval of ['pending','rejected','awaiting',null]) {
      await db.query('UPDATE plots SET approval_status=$1 WHERE id=200',[approval]);
      for(let i=0;i<3;i++) {
        const response=await service.commission(sessions[i],id(sessions[i],200));
        const card=response.commission;
        assert.equal(card.settlementApprovalStatus,approval==='rejected'?'rejected':'pending');
        assert.equal(card.totalAmount,[300,500,200][i]);
        assert.equal(card.originalCommission,card.totalAmount);
        assert.equal(card.settlementAmount,[75,0,80][i],'A proposal is separate from effective original entitlement');
        assert.equal(card.allocations[0].amount,card.allocations[0].originalAmount);
        assert.equal(card.recoverableAmount,0);assert.equal(card.tdsAdjustmentAmount,0);
      }
    }
    await db.exec("UPDATE plots SET approval_status='approved' WHERE id=200");
    const approved=await service.commission(sessions[1],id(sessions[1],200));
    assert.equal(approved.commission.totalAmount,0,'An approved explicitzero is effective');
    assert.equal(approved.commission.tdsAdjustmentAmount,100);
  });
  await t.test('approval changes during a commission read invalidate the pending financial proposal',async()=>{
    duringCommission=()=>db.exec("UPDATE plots SET approval_status='pending' WHERE id=200");
    await assert.rejects(service.commission(sessions[0],id(sessions[0],200)),{statusCode:503});
    const pending=await service.commission(sessions[0],id(sessions[0],200));
    assert.equal(pending.commission.totalAmount,300);assert.equal(pending.commission.recoverableAmount,0);
    await db.exec("UPDATE plots SET approval_status='approved' WHERE id=200");
  });
  await t.test('one broker on both bookings gets distinct cards and ledgers, then loses only the reassigned card',async()=>{
    await db.exec('UPDATE plot_commissions_v2 SET agent_id=101 WHERE id=204');
    const both=await service.commissions(sessions[0]);
    assert.equal(both.commissions.length,2);
    assert.notEqual(both.commissions[0].plotId,both.commissions[1].plotId);
    assert.equal((await service.commission(sessions[0],id(sessions[0],200))).transactions.length,3);
    assert.equal((await service.commission(sessions[0],id(sessions[0],201))).transactions.length,0);
    await db.exec('UPDATE plot_commissions_v2 SET agent_id=105 WHERE id=204');
    await assert.rejects(service.commission(sessions[0],id(sessions[0],201)),{statusCode:404});
    assert.equal((await service.commissions(sessions[0])).commissions.length,1);
  });
  await t.test('settlement edits during a slow history read fail closed',async()=>{
    duringCommission=()=>db.exec('UPDATE plot_commissions_v2 SET settlement_commission=76 WHERE id=200');
    await assert.rejects(service.commission(sessions[0],id(sessions[0],200)),{statusCode:503});
    assert.equal((await service.commission(sessions[0],id(sessions[0],200))).commission.totalAmount,76);
  });
});
