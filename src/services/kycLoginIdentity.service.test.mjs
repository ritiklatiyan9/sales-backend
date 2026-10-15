import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import { PGlite } from '@electric-sql/pglite';
import pool from '../config/db.js';
import userModel from '../models/User.model.js';
import { migrateStaffIdentity } from '../migrations/029_staff_identity.js';
import { migrateKycLoginIdentity } from '../migrations/032_kyc_login_identity.js';
import { createStaffIdentityService, matchesStaffPassword } from './staffIdentity.service.js';

process.env.JWT_ACCESS_SECRET = 'isolated-kyc-login-access-secret';
process.env.JWT_REFRESH_SECRET = 'isolated-kyc-login-refresh-secret';
process.env.LOGIN_OTP_ENABLED = 'false';
const { login, linkStaffKyc } = await import('../controllers/auth.controller.js');
const { verifyToken } = await import('../config/jwt.js');
const call = (handler, { body = {}, user, params = {} }) => new Promise(resolve => {
  const res = { code: 200, status(code) { this.code = code; return this; }, json(data) { resolve({ status: this.code, data }); } };
  handler({ body, user, params }, res, error => resolve({ status: error.status || 500, data: { message: error.message } }));
});

const password = 'Account-password-1';
const aadhaar = '234567890123';

test('KYC identity linking confirms the subject, authorizes staff and preserves credential revocation', async t => {
  const db = new PGlite();
  const query = (sql, values) => db.query(sql, values);
  const original = { query: pool.query, connect: pool.connect };
  pool.query = query;
  pool.connect = async () => ({ query, release() {} });
  try {
    await db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT, phone TEXT,
      password TEXT, role TEXT, organization_id INTEGER, is_active BOOLEAN DEFAULT true,
      token_version INTEGER DEFAULT 0, refresh_token TEXT, updated_at TIMESTAMPTZ DEFAULT now());
      CREATE TABLE sites (id INTEGER PRIMARY KEY,name TEXT,organization_id INTEGER);
      CREATE TABLE user_sites (user_id INTEGER,site_id INTEGER);
      CREATE TABLE members (id INTEGER PRIMARY KEY,site_id INTEGER,full_name TEXT,phone TEXT,email TEXT,
        aadhar_no TEXT,member_type TEXT,member_types TEXT[],created_by INTEGER,referred_by_user_id INTEGER);
      CREATE TABLE kyc_cases (id INTEGER PRIMARY KEY,client_member_id INTEGER,site_id INTEGER,status TEXT,created_by INTEGER);
      CREATE TABLE login_otps (id SERIAL PRIMARY KEY,user_id INTEGER,pending_token TEXT);`);
    const hash = await bcrypt.hash(password, 4);
    await query(`INSERT INTO users(id,name,email,phone,password,role,organization_id) VALUES
      (1,'Super','super@test.example','9876500001',$1,'super_admin',1),
      (2,'Admin','admin@test.example','9876500002',$1,'admin',1),
      (3,'Sub Admin','sub@test.example','9876500003',$1,'sub_admin',1),
      (4,'Broker Person','broker@test.example','9876500004',$1,'agent',1),
      (5,'Agent Target','agent@test.example','9876500005',$1,'agent',1),
      (6,'Other Admin','other@test.example','9876500006',$1,'admin',1),
      (7,'Other Organization','org@test.example','9876500007',$1,'sub_admin',2),
      (8,'No Site','nosite@test.example','9876500008',$1,'sub_admin',1),
      (9,'Client Person','client@test.example','9876500009',$1,'agent',1),
      (10,'Inactive','inactive@test.example','9876500010',$1,'agent',1)`, [hash]);
    await query('UPDATE users SET is_active=false WHERE id=10');
    await db.exec(`INSERT INTO sites VALUES (1,'One',1),(2,'Two',2);
      INSERT INTO user_sites VALUES (3,1),(4,1),(5,1),(7,2),(9,1),(10,1);
      INSERT INTO members(id,site_id,full_name,phone,email,aadhar_no,member_type,member_types,created_by,referred_by_user_id) VALUES
      (100,1,'Different Client','9876510000','different@test.example','234567890123','CLIENT',NULL,3,3),
      (101,1,'Broker Person','9876500004','broker@test.example','234567890123','BROKER',NULL,2,2),
      (102,1,'Second Broker','9876510002','second@test.example','234567890123','CLIENT',ARRAY['CLIENT','BROKER'],2,2),
      (103,1,'Unverified','9876510003',NULL,'234567890123','BROKER',NULL,2,2),
      (104,2,'Other Organization','9876500007','org@test.example','234567890123','BROKER',NULL,1,1),
      (105,1,'  sub   admin ','9876500003','sub@test.example','234567890123','CLIENT',NULL,2,2),
      (106,1,'Client Person','9876500009','client@test.example','234567890123','CLIENT',NULL,9,9),
      (107,1,'Colliding Broker','9876500006',NULL,'234567890123','BROKER',NULL,2,2);
      INSERT INTO kyc_cases VALUES (4227,100,1,'VERIFIED',3),(4228,101,1,'VERIFIED',2),
      (4229,102,1,'VERIFIED',2),(4230,103,1,'OPEN',2),(4231,104,2,'VERIFIED',1),
      (4232,105,1,'VERIFIED',2),(4233,106,1,'VERIFIED',9),(4234,107,1,'VERIFIED',2);`);
    await migrateStaffIdentity(pool);
    await migrateKycLoginIdentity(pool);
    await migrateKycLoginIdentity(pool);
    const service = createStaffIdentityService(pool);
    const session = async id => ({ id, version: (await query('SELECT token_version FROM users WHERE id=$1', [id])).rows[0].token_version });
    const body = id => ({ kyc_case_id: id, current_password: password });
    const link = async (actor, target, id) => service.linkKyc(await session(actor), target, body(id));

    await t.test('operator and referrer are never treated as the KYC subject; case IDs are resolved explicitly', async () => {
      await assert.rejects(service.updateProfile(await session(3), body(4227)), /confirm this KYC link/);
      await assert.rejects(service.updateProfile(await session(3), body(100)), /not found/);
      assert.equal((await query('SELECT count(*)::int AS n FROM booking_user_kyc_links')).rows[0].n, 0);
    });
    await t.test('ordinary agents cannot use phone login or self-promote a CLIENT KYC', async () => {
      assert.equal(await userModel.findByLoginIdentifier('9876500009'), undefined);
      assert.ok(await userModel.findByLoginIdentifier('client@test.example'));
      await assert.rejects(service.updateProfile(await session(9), body(4233)), /verified Brokers/);
      // An agent still verifies their existing password to update their own profile.
      await service.updateProfile(await session(9), { phone: '9876520009', current_password: password });
    });
    await t.test('an administrator confirms initial subordinate identity before profile self import', async () => {
      await assert.rejects(service.updateProfile(await session(3), body(4232)), /confirm this KYC link/);
      await link(2, 3, 4232);
      const imported = await service.updateProfile(await session(3), body(4232));
      const safe = userModel.sanitize(imported.user);
      assert.equal(safe.kyc_case_id, 4232);
      assert.equal(safe.kyc_member_id, 105);
      assert.equal(safe.kyc_mobile, '9876500003');
      assert.equal(safe.aadhaar_masked, 'XXXX XXXX 0123');
      assert.equal(safe.phone_aadhaar_enabled, true);
      assert.ok(!JSON.stringify(safe).includes(aadhaar));
      assert.ok(Object.keys(safe).every(key => !/^booking_|password|token/.test(key)));
      assert.equal(await matchesStaffPassword(imported.user, aadhaar, { phoneLogin: true }), true);
      assert.equal(await matchesStaffPassword(imported.user, aadhaar), false);
    });
    await t.test('only verified broker subjects enable agent accounts, including multi-role members', async () => {
      await assert.rejects(link(2, 5, 4227), /verified Brokers/);
      await assert.rejects(link(2, 4, 4230), /Verify this KYC/);
      await query("UPDATE users SET name='Second Broker',phone='9876510002' WHERE id=5");
      await assert.rejects(service.updateProfile(await session(5), body(4229)), /confirm this KYC link/);
      const imported = await link(2, 5, 4229);
      assert.equal(imported.isSelf, false);
      assert.equal(imported.user.role, 'agent');
      assert.equal(imported.user.phone, '9876510002');
      assert.equal(imported.user.booking_linked_broker, true);
      assert.equal(await matchesStaffPassword(imported.user, aadhaar, { phoneLogin: true }), true);
      assert.equal((await userModel.findByLoginIdentifier('9876510002')).id, 5);
      assert.equal((await query('SELECT actor_user_id,target_user_id,member_id,kyc_case_id FROM booking_kyc_login_events WHERE target_user_id=5')).rows[0].member_id, 102);
      await query("UPDATE members SET member_types=ARRAY['CLIENT'] WHERE id=102");
      assert.equal(await userModel.findByLoginIdentifier('9876510002'), undefined);
      await query("UPDATE members SET member_types=ARRAY['CLIENT','BROKER'] WHERE id=102");
    });
    await t.test('admin hierarchy, site, organization, active status and current password are enforced', async () => {
      await assert.rejects(link(2, 1, 4227), /authorized Admin/);
      await assert.rejects(link(2, 6, 4227), /authorized Admin/);
      await assert.rejects(link(3, 4, 4228), /authorized Admin/);
      await assert.rejects(link(1, 7, 4227), /different organizations/);
      await assert.rejects(link(2, 8, 4227), /access to this site/);
      await assert.rejects(link(2, 10, 4228), /Active login account/);
      await assert.rejects(service.linkKyc(await session(2), 4, { kyc_case_id: 4228, current_password: 'wrong' }), /current password/);
      const options = await service.getKycLoginOptions(await session(2), 4227);
      assert.deepEqual(options.candidates.map(u => u.id).sort(), [2, 3]);
      assert.equal(options.is_broker, false);
      assert.equal(options.member_id, 100);
      assert.ok(options.candidates.every(user => !('phone' in user)));
      await assert.rejects(service.getKycLoginOptions(await session(3), 4227), /Only Admin/);
      await assert.rejects(service.getKycLoginOptions(await session(2), 4231), /different organizations/);
    });
    await t.test('phone collisions and already linked source identities cannot select another person', async () => {
      await assert.rejects(link(2, 4, 4234), /mobile number is already assigned/);
      await assert.rejects(link(2, 4, 4229), /mobile number is already assigned|already linked/);
      await query('INSERT INTO users(id,name,email,phone,password,role,organization_id) VALUES (11,$1,$2,$3,$4,$5,1)', ['Duplicate','dupe@test.example','9876510002',hash,'admin']);
      assert.equal(await userModel.findByLoginIdentifier('9876510002'), undefined);
      await query('DELETE FROM users WHERE id=11');
    });
    await t.test('KYC edits do not reset credentials, and a new password revokes Aadhaar without losing profile source', async () => {
      const imported = await link(2, 4, 4228);
      await query("UPDATE members SET phone='9876599999',aadhar_no='345678901234' WHERE id=101");
      const unchanged = await userModel.findById(4);
      assert.equal(unchanged.phone, '9876500004');
      assert.equal(await matchesStaffPassword(unchanged, aadhaar, { phoneLogin: true }), true);
      assert.equal(await matchesStaffPassword(unchanged, '345678901234', { phoneLogin: true }), false);
      await query("INSERT INTO login_otps(user_id,pending_token) VALUES (4,'stale-otp')");
      const changed = await service.updateProfile(await session(4), { current_password: aadhaar, new_password: 'Updated-password-2' });
      assert.equal(userModel.sanitize(changed.user).phone_aadhaar_enabled, false);
      assert.equal(userModel.sanitize(changed.user).kyc_case_id, 4228);
      assert.equal(await matchesStaffPassword(changed.user, aadhaar, { phoneLogin: true }), false);
      assert.equal(await matchesStaffPassword(changed.user, 'Updated-password-2', { phoneLogin: true }), true);
      assert.ok(changed.user.token_version > imported.user.token_version);
      assert.equal((await query('SELECT count(*)::int AS n FROM login_otps WHERE user_id=4')).rows[0].n, 0);
    });
    await t.test('a CLIENT KYC may explicitly link an eligible admin account without creating a login or changing roles', async () => {
      const before = (await query('SELECT count(*)::int AS n FROM users')).rows[0].n;
      const imported = await link(1, 6, 4227);
      assert.equal(imported.user.role, 'admin');
      assert.equal(imported.user.booking_kyc_case_id, 4227);
      assert.equal(imported.user.booking_kyc_member_id, 100);
      assert.equal((await query('SELECT count(*)::int AS n FROM users')).rows[0].n, before);
      assert.equal((await query('SELECT member_type FROM members WHERE id=100')).rows[0].member_type, 'CLIENT');
    });
    await t.test('API links return replacement tokens only for the account performing its own update', async () => {
      const response = await call(linkStaffKyc, { user: await session(1), params: { userId: '6' }, body: body(4227) });
      assert.equal(response.status, 200, JSON.stringify(response.data));
      assert.equal(response.data.is_self, false);
      assert.equal(response.data.session_changed, true);
      assert.equal(response.data.accessToken, undefined);
      assert.equal(response.data.refreshToken, undefined);
      assert.ok(!JSON.stringify(response.data).includes(aadhaar));
      const self = await call(linkStaffKyc, { user: await session(6), params: { userId: '6' }, body: body(4227) });
      assert.equal(self.status, 200, JSON.stringify(self.data));
      assert.equal(self.data.is_self, true);
      assert.equal(verifyToken(self.data.accessToken).id, 6);
      assert.equal(verifyToken(self.data.accessToken).version, self.data.user.token_version ?? (await session(6)).version);
      assert.ok(self.data.refreshToken);
    });
    await t.test('login API accepts only enrolled broker phone credentials and keeps email behavior', async () => {
      const broker = await call(login, { body: { identifier: '+91 98765 10002', password: aadhaar } });
      assert.equal(broker.status, 200, JSON.stringify(broker.data));
      assert.equal(broker.data.user.id, 5);
      assert.ok(broker.data.accessToken);
      assert.equal((await call(login, { body: { identifier: 'agent@test.example', password: aadhaar } })).status, 401);
      assert.equal((await call(login, { body: { identifier: '9876520009', password } })).status, 401);
      assert.equal((await call(login, { body: { identifier: 'client@test.example', password } })).status, 200);
    });
  } finally {
    pool.query = original.query;
    pool.connect = original.connect;
    await db.close();
  }
});
