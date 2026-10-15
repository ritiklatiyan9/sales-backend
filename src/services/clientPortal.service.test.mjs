import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { PGlite } from '@electric-sql/pglite';
import pool from '../config/db.js';
import { migrateStaffIdentity } from '../migrations/029_staff_identity.js';
import { migrateKycLoginIdentity } from '../migrations/032_kyc_login_identity.js';
import { migrateClientPortal } from '../migrations/033_client_portal.js';
import { createClientPortalService, verifyClientToken, clientPortalSession } from './clientPortal.service.js';

process.env.JWT_ACCESS_SECRET = 'isolated-shared-access-secret';
process.env.JWT_REFRESH_SECRET = 'isolated-shared-refresh-secret';
process.env.CLIENT_PORTAL_SECRET = 'isolated-client-signing-secret';
process.env.CLIENT_PORTAL_IDENTITY_SECRET = 'isolated-stable-client-identity-secret';
process.env.CLIENT_PORTAL_ENABLED = 'true';
const { login } = await import('../controllers/auth.controller.js');
const { default: staffAuth } = await import('../middlewares/auth.middleware.js');
const { clientAuthMiddleware } = await import('../controllers/clientPortal.controller.js');
const call = (handler, { body = {}, headers = {}, query = {}, params = {} } = {}) => new Promise(resolve => {
  const res = { code: 200, status(code) { this.code=code; return this; }, json(data) { resolve({ status:this.code,data }); } };
  const req = { body,query,params,header: name => headers[name] };
  handler(req,res,error => resolve(error ? { status:error.status||500,data:{message:error.message} } : { status:200,req }));
});

test('client portal credentials and records remain isolated from every staff and other-client identity', async t => {
  const db = new PGlite();
  const query = (sql, values) => db.query(sql, values);
  const original = { query:pool.query,connect:pool.connect };
  pool.query=query;
  pool.connect=async () => ({ query,release() {} });
  try {
    await db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT,email TEXT,phone TEXT,password TEXT,role TEXT,
      organization_id INTEGER,is_active BOOLEAN DEFAULT true,token_version INTEGER DEFAULT 0,refresh_token TEXT,updated_at TIMESTAMPTZ DEFAULT now());
      CREATE TABLE sites(id INTEGER PRIMARY KEY,name TEXT,code TEXT,organization_id INTEGER);
      CREATE TABLE user_sites(user_id INTEGER,site_id INTEGER);
      CREATE TABLE members(id INTEGER PRIMARY KEY,site_id INTEGER,full_name TEXT,phone TEXT,email TEXT,aadhar_no TEXT,pan_no TEXT,
        member_type TEXT,member_types TEXT[],created_by INTEGER,referred_by_user_id INTEGER);
      CREATE TABLE kyc_cases(id INTEGER PRIMARY KEY,client_member_id INTEGER,site_id INTEGER,status TEXT,created_by INTEGER);
      CREATE TABLE plots(id INTEGER PRIMARY KEY,site_id INTEGER,plot_no TEXT,block TEXT);
      CREATE TABLE bookings(id INTEGER PRIMARY KEY,client_member_id INTEGER,site_id INTEGER,plot_id INTEGER,booking_no TEXT,
        booking_date DATE,status TEXT,kyc_status TEXT,sale_price NUMERIC,token_payment_id INTEGER);
      CREATE TABLE draw_registrations(id INTEGER PRIMARY KEY,client_member_id INTEGER,site_id INTEGER,registration_no TEXT,scheme_name TEXT,
        draw_opening_date DATE,status TEXT,is_winner BOOLEAN,required_amount NUMERIC,booking_id INTEGER);
      CREATE TABLE draw_payments(id INTEGER PRIMARY KEY,draw_registration_id INTEGER,amount NUMERIC,payment_date DATE,receipt_no TEXT,payment_from TEXT,plot_payment_id INTEGER);
      CREATE TABLE plot_payments(id INTEGER PRIMARY KEY,site_id INTEGER,plot_id INTEGER,amount NUMERIC,date DATE,payment_from TEXT,payment_type TEXT,status TEXT,cheque_status TEXT);
      CREATE TABLE documents(id INTEGER PRIMARY KEY,kyc_case_id INTEGER,client_member_id INTEGER,site_id INTEGER,type TEXT,mime_type TEXT,file_path TEXT,created_at TIMESTAMPTZ DEFAULT now());`);
    const staffPassword = await bcrypt.hash('Admin-password-1',4);
    await query(`INSERT INTO users(id,name,email,phone,password,role,organization_id) VALUES
      (1,'Staff','staff@example.test','9876500000',$1,'admin',1)`,[staffPassword]);
    await db.exec(`INSERT INTO sites VALUES(1,'Site One','ONE',1),(2,'Site Two','TWO',1),(3,'Private Site','PRIVATE',2);
      INSERT INTO plots VALUES(1,1,'A1','A');
      INSERT INTO members(id,site_id,full_name,phone,email,aadhar_no,pan_no,member_type) VALUES
      (4591,1,'Client One','+91 98765 11111','one@example.test','2345 6789 0123','ABCDE1234F','CLIENT'),
      (4592,2,'Client One','9876511111','one@example.test','234567890123','ABCDE1234F','CLIENT'),
      (4593,1,'Other Client','9876511111','other@example.test','345678901234','BCDEF2345G','CLIENT'),
      (4594,3,'Unverified Client','9876522222',NULL,'456789012345',NULL,'CLIENT'),
      (4595,3,'Broker','9876533333',NULL,'567890123456',NULL,'BROKER'),
      (4596,1,'Another Buyer','9876544444',NULL,'678901234567',NULL,'CLIENT'),
      (4597,1,'Staff Collision','9876500000',NULL,'789012345678',NULL,'CLIENT');
      INSERT INTO kyc_cases VALUES(4227,4591,1,'VERIFIED',1),(4228,4592,2,'VERIFIED',1),
        (4229,4593,1,'VERIFIED',1),(4230,4594,3,'OPEN',1),(4231,4595,3,'VERIFIED',1),(4232,4596,1,'VERIFIED',1),(4233,4597,1,'VERIFIED',1);
      INSERT INTO bookings VALUES(10,4591,1,1,'BK-OWN','2026-10-01','CONFIRMED','VERIFIED',1000,100),
        (11,4596,1,1,'BK-OTHER','2026-10-01','CONFIRMED','VERIFIED',999999,101),
        (12,4592,2,NULL,'BK-SECOND-SITE','2026-10-02','DRAFT','VERIFIED',2000,NULL);
      INSERT INTO draw_registrations VALUES(20,4591,1,'DR-OWN-A','A1','2026-12-01','REGISTERED',false,100,10),
        (21,4591,1,'DR-OWN-B','B5','2026-12-02','REGISTERED',false,100,NULL),
        (22,4593,1,'DR-PRIVATE','PRIVATE','2026-12-03','REGISTERED',false,999999,NULL);
      INSERT INTO plot_payments VALUES(100,1,1,50,'2026-10-01','CASH','CASH','approved',NULL),
        (101,1,1,999999,'2026-10-01','CASH','CASH','approved',NULL),
        (102,1,1,100,'2026-10-01','BANK','BANK','approved',NULL),
        (103,1,1,888888,'2026-10-01','CASH','CASH','approved',NULL);
      INSERT INTO draw_payments VALUES(30,20,100,'2026-10-01','RECEIPT-OWN','BANK',102),
        (31,21,75,'2026-10-02','RECEIPT-OWN-B','CASH',NULL),(32,22,999999,'2026-10-01','PRIVATE','CASH',NULL);
      INSERT INTO documents(id,kyc_case_id,client_member_id,site_id,type,mime_type,file_path) VALUES
        (40,4227,4591,1,'AADHAAR','application/pdf','local::own.pdf'),
        (41,4229,4593,1,'PAN','application/pdf','local::private.pdf'),
        (42,4227,4593,1,'PAN','application/pdf','local::inconsistent.pdf'),
        (43,4227,NULL,NULL,'PHOTO','image/jpeg','local::legacy.jpg');`);
    await migrateStaffIdentity(pool);
    await migrateKycLoginIdentity(pool);
    await migrateClientPortal(pool);
    await migrateClientPortal(pool);
    const service=createClientPortalService(pool);
    let clientLogin;
    await t.test('paused client login cannot create an account while staff email and phone remain available', async () => {
      process.env.CLIENT_PORTAL_ENABLED='false';
      try {
        const paused=await call(login,{body:{identifier:'9876511111',password:'234567890123'}});
        assert.equal(paused.status,401);
        assert.equal((await query('SELECT count(*)::int AS n FROM booking_client_accounts')).rows[0].n,0);
        for (const identifier of ['staff@example.test','9876500000']) assert.equal((await call(login,{body:{identifier,password:'Admin-password-1'}})).status,200);
      } finally { process.env.CLIENT_PORTAL_ENABLED='true'; }
    });
    await t.test('first phone+Aadhaar sign-in provisions only separate private account and exact same-person sites',async () => {
      const staffBefore=(await query('SELECT count(*)::int AS n FROM users')).rows[0].n;
      clientLogin=await call(login,{body:{identifier:'+91 98765 11111',password:'2345-6789-0123'}});
      assert.equal(clientLogin.status,200,JSON.stringify(clientLogin.data));
      assert.equal(clientLogin.data.realm,'client');
      assert.equal(clientLogin.data.user.role,'client');
      assert.equal(clientLogin.data.user.id,'client:1');
      assert.equal(clientLogin.data.user.phone,'9876511111');
      assert.deepEqual(clientLogin.data.sites.map(site=>site.id),[1,2]);
      assert.ok(!JSON.stringify(clientLogin.data).includes('234567890123'));
      assert.ok(!JSON.stringify(clientLogin.data).includes('password_hash'));
      assert.equal((await query('SELECT count(*)::int AS n FROM users')).rows[0].n,staffBefore);
      assert.equal((await query('SELECT count(*)::int AS n FROM booking_client_members')).rows[0].n,2);
    });
    await t.test('client tokens cannot impersonate overlapping staff IDs or use staff refresh paths',async () => {
      assert.throws(()=>jwt.verify(clientLogin.data.accessToken,process.env.JWT_ACCESS_SECRET));
      assert.throws(()=>jwt.verify(clientLogin.data.refreshToken,process.env.JWT_REFRESH_SECRET));
      assert.throws(()=>verifyClientToken(clientLogin.data.refreshToken));
      assert.throws(()=>verifyClientToken(clientLogin.data.accessToken,'refresh'));
      assert.equal((await call(staffAuth,{headers:{Authorization:`Bearer ${clientLogin.data.accessToken}`}})).status,401);
      const staffToken=jwt.sign({id:1,version:0},process.env.JWT_ACCESS_SECRET);
      assert.equal((await call(clientAuthMiddleware,{headers:{Authorization:`Bearer ${staffToken}`}})).status,401);
      const own=await call(clientAuthMiddleware,{headers:{Authorization:`Bearer ${clientLogin.data.accessToken}`}});
      assert.equal(own.status,200);
      assert.deepEqual(own.req.client.members.map(member=>member.member_id),[4591,4592]);
    });
    await t.test('every record, document and payment belongs to the authenticated person, including plot reuse',async () => {
      const session=await service.getSession(verifyClientToken(clientLogin.data.accessToken));
      const records=await service.records(session);
      assert.deepEqual(records.bookings.items.map(item=>item.id),[12,10]);
      assert.deepEqual(records.draws.items.map(item=>item.draw_code),['B5','A1']);
      assert.equal(records.bookings.items.find(item=>item.id===10).paid_amount,'150');
      assert.equal(records.summary.total_paid,225);
      assert.deepEqual(records.payments.items.map(item=>item.id).sort(),['booking:100','draw:30','draw:31']);
      assert.ok(!JSON.stringify(records).includes('PRIVATE'));
      assert.ok(!JSON.stringify(records).includes('999999'));
      assert.ok(!JSON.stringify(records).includes('234567890123'));
      assert.deepEqual(records.kyc.items.find(item=>item.id===4227).documents.map(item=>item.id),[43,40]);
      assert.equal((await service.document(session,40)).file_path,'local::own.pdf');
      await assert.rejects(service.document(session,41),/Document not found/);
      await assert.rejects(service.document(session,42),/Document not found/);
      await assert.rejects(service.records(session,{site_id:3}),/unavailable/);
      await assert.rejects(service.records(session,{limit:1000}),/pagination/);
      const later=await service.records(session,{page:2,limit:2});
      assert.equal(later.bookings.total,2);
      assert.equal(later.bookings.items.length,0);
    });
    await t.test('shared mobile resolves exact Aadhaar; unverified, non-client and wrong identities cannot sign in',async () => {
      const other=await service.authenticate('9876511111','345678901234');
      assert.equal(other.user.name,'Other Client');
      assert.notEqual(other.user.id,clientLogin.data.user.id);
      assert.equal(await service.authenticate('9876511111','999999999999'),null);
      assert.equal(await service.authenticate('9876522222','456789012345'),null);
      assert.equal(await service.authenticate('9876533333','567890123456'),null);
      assert.equal(await service.authenticate('one@example.test','234567890123'),null);
    });
    await t.test('staff/client credential collisions cannot choose a privileged or arbitrary realm',async () => {
      const collisionHash=await bcrypt.hash('789012345678',4);
      await query('UPDATE users SET password=$1 WHERE id=1',[collisionHash]);
      const result=await call(login,{body:{identifier:'9876500000',password:'789012345678'}});
      assert.equal(result.status,401);
      assert.equal((await query("SELECT count(*)::int AS n FROM booking_client_accounts WHERE phone='9876500000'")).rows[0].n,0);
      assert.equal((await call(login,{body:{identifier:'staff@example.test',password:'789012345678'}})).status,200);
    });
    await t.test('password changes revoke old access, refresh and Aadhaar; profile cannot change member/site/role',async () => {
      const session=await service.getSession(verifyClientToken(clientLogin.data.accessToken));
      await assert.rejects(service.updateProfile(session,{role:'admin'}),/Only your password/);
      await assert.rejects(service.updateProfile(session,{current_password:'wrong',new_password:'New-password-2'}),/current password/);
      const changed=await service.updateProfile(session,{current_password:'234567890123',new_password:'New-password-2'});
      assert.equal(changed.user.phone_aadhaar_enabled,false);
      await assert.rejects(service.getSession(verifyClientToken(clientLogin.data.accessToken)),/Session expired/);
      await assert.rejects(service.refresh(clientLogin.data.refreshToken),/Session expired/);
      assert.equal(await service.authenticate('9876511111','234567890123'),null);
      const current=await service.authenticate('9876511111','New-password-2');
      assert.equal(current.user.id,'client:1');
      const refreshed=await service.refresh(current.refreshToken);
      assert.equal(refreshed.realm,'client');
      assert.equal(clientPortalSession(await service.getSession(verifyClientToken(refreshed.accessToken))).user.name,'Client One');
      await service.logout(await service.getSession(verifyClientToken(refreshed.accessToken)));
      await assert.rejects(service.refresh(refreshed.refreshToken),/Session expired/);
    });
    await t.test('live KYC revocation and identity edits remove ownership without resetting any password',async () => {
      const current=await service.authenticate('9876511111','New-password-2');
      await query("UPDATE kyc_cases SET status='REJECTED' WHERE client_member_id=4592");
      const scoped=await service.getSession(verifyClientToken(current.accessToken));
      assert.deepEqual(scoped.members.map(member=>member.member_id),[4591]);
      await query("UPDATE members SET aadhar_no='345678901234' WHERE id=4591");
      await assert.rejects(service.getSession(verifyClientToken(current.accessToken)),/Session expired/);
      assert.equal(await service.authenticate('9876511111','New-password-2'),null);
      const countBefore=(await query('SELECT count(*)::int AS n FROM booking_client_accounts')).rows[0].n;
      const other=await service.authenticate('9876511111','345678901234');
      assert.equal(other.user.name,'Other Client');
      assert.deepEqual((await service.getSession(verifyClientToken(other.accessToken))).members.map(member=>member.member_id),[4593]);
      assert.equal((await query('SELECT count(*)::int AS n FROM booking_client_accounts')).rows[0].n,countBefore);
    });
  } finally { pool.query=original.query;pool.connect=original.connect;await db.close(); }
});
