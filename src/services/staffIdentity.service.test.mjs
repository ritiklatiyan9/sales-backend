import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import { PGlite } from '@electric-sql/pglite';
import pool from '../config/db.js';
import { migrateStaffIdentity } from '../migrations/029_staff_identity.js';
import { migrateKycLoginIdentity } from '../migrations/032_kyc_login_identity.js';
import { createStaffIdentityService, matchesStaffPassword, normalizeStaffPhone, validateProfileUpdate } from './staffIdentity.service.js';
import userModel from '../models/User.model.js';

// Tokens and accounts in this test exist only in the isolated PostgreSQL engine.
process.env.JWT_ACCESS_SECRET = 'isolated-staff-access-test-secret';
process.env.JWT_REFRESH_SECRET = 'isolated-staff-refresh-test-secret';
process.env.LOGIN_OTP_ENABLED = 'false';
const { login, updateProfile, refresh } = await import('../controllers/auth.controller.js');
const { default: authMiddleware } = await import('../middlewares/auth.middleware.js');
const { verifyToken } = await import('../config/jwt.js');

const call = (handler, { body = {}, user = { id: 1, role: 'admin', version: 0 } } = {}) => new Promise(resolve => {
  const res = { code: 200, status(code) { this.code = code; return this; }, json(data) { resolve({ status: this.code, data }); } };
  handler({ body, user }, res, error => resolve({ status: error.status || 500, data: { message: error.message } }));
});
const checkAccess = token => new Promise(resolve => {
  const req = { header: () => `Bearer ${token}` };
  const res = { status(code) { this.code = code; return this; }, json(data) { resolve({ status: this.code, data }); } };
  authMiddleware(req, res, () => resolve({ status: 200, user: req.user }));
});

test('staff profile validates identifiers and rejects privilege changes', () => {
  for (const phone of ['9876543210', '+91 98765 43210', '09876543210']) assert.equal(normalizeStaffPhone(phone), '9876543210');
  for (const phone of ['123', '19876543210', '1234567890', 'random9876543210']) assert.equal(normalizeStaffPhone(phone), null);
  for (const body of [{ role: 'super_admin' }, { token_version: 0 }, { phone: 'abc' }, { email: 'invalid' }, { name: '' }, { new_password: 'short' }, { new_password: '💬'.repeat(19) }, { aadhaar_number: '123456789012' }]) assert.throws(() => validateProfileUpdate(body));
});

test('phone login, Aadhaar enrollment and password revocation preserve shared identities', async t => {
  const db = new PGlite();
  const query = (sql, values) => db.query(sql, values);
  const original = { query: pool.query, connect: pool.connect };
  pool.query = query;
  pool.connect = async () => ({ query, release() {} });
  try {
    await db.exec(`CREATE TABLE users (
      id SERIAL PRIMARY KEY, name TEXT, email TEXT, phone TEXT, password TEXT, role TEXT,
      is_active BOOLEAN NOT NULL DEFAULT true, token_version INTEGER NOT NULL DEFAULT 0,
      refresh_token TEXT, organization_id INTEGER, updated_at TIMESTAMPTZ DEFAULT now()
    ); CREATE TABLE sites (id INTEGER PRIMARY KEY, name TEXT, organization_id INTEGER);
    CREATE TABLE members (id INTEGER PRIMARY KEY, site_id INTEGER, member_type TEXT, member_types TEXT[]);
    CREATE TABLE kyc_cases (id INTEGER PRIMARY KEY, client_member_id INTEGER, site_id INTEGER, status TEXT);
    CREATE TABLE login_otps (id SERIAL PRIMARY KEY, user_id INTEGER, pending_token TEXT);`);
    const password = await bcrypt.hash('Existing-password-1', 4);
    await query(`INSERT INTO users(name,email,phone,password,role) VALUES
      ('Test Admin',' Admin@Example.test ','+91 98765 43210',$1,'admin'),
      ('Test Subadmin','subadmin@example.test','9876543211',$1,'sub_admin'),
      ('Test Superadmin','super@example.test','9876543212',$1,'super_admin'),
      ('Test Agent','agent@example.test','9876543213',$1,'agent')`, [password]);
    await migrateStaffIdentity(pool);
    await migrateStaffIdentity(pool);
    await migrateKycLoginIdentity(pool);
    const service = createStaffIdentityService(pool);
    const signIn = (identifier, supplied = 'Existing-password-1') => call(login, { body: { identifier, password: supplied } });

    await t.test('normalized email and staff phone share sessions; agent email remains supported', async () => {
      for (const identifier of ['ADMIN@example.test', '+91 98765 43210', '9876543211', '9876543212', 'agent@example.test']) {
        const response = await signIn(identifier);
        assert.equal(response.status, 200, JSON.stringify(response.data));
        assert.ok(response.data.accessToken);
        for (const key of Object.keys(response.data.user).filter(key => !['phone_aadhaar_enabled', 'aadhaar_masked'].includes(key))) assert.doesNotMatch(key, /password|token|aadhaar|aadhar/);
      }
      assert.equal((await signIn('9876543213')).status, 401);
      assert.equal((await signIn('9876543210', 'bad-password')).status, 401);
      await query("UPDATE users SET is_active=false WHERE id=2");
      assert.equal((await signIn('9876543211')).status, 403);
      await query("UPDATE users SET is_active=true WHERE id=2");
    });

    let enrolled;
    await t.test('enrollment hashes Aadhaar outside shared users and requires current credentials', async () => {
      await assert.rejects(service.updateProfile({ id: 1, version: 0 }, { aadhaar_number: '234567890123' }), /current password/i);
      enrolled = await call(updateProfile, { body: { aadhaar_number: '234567890123', current_password: 'Existing-password-1' } });
      assert.equal(enrolled.status, 200, JSON.stringify(enrolled.data));
      assert.equal(enrolled.data.user.phone_aadhaar_enabled, true);
      const identity = (await query('SELECT * FROM booking_staff_identities WHERE user_id=1')).rows[0];
      assert.notEqual(identity.aadhaar_password_hash, '234567890123');
      assert.ok(await bcrypt.compare('234567890123', identity.aadhaar_password_hash));
      assert.ok(!JSON.stringify(enrolled.data).includes('234567890123'));
      assert.ok(!('booking_aadhaar_password_hash' in (await query('SELECT * FROM users WHERE id=1')).rows[0]));
      assert.equal((await signIn('9876543210', '2345 6789 0123')).status, 200);
      assert.equal((await signIn('admin@example.test', '234567890123')).status, 401);
      await assert.rejects(service.updateProfile({ id: 4, version: 0 }, { aadhaar_number: '234567890123', current_password: 'Existing-password-1' }), /Super Admin/);
    });

    await t.test('password change revokes old access, refresh and OTP while current browser keeps working', async () => {
      const before = await signIn('9876543210');
      await query("INSERT INTO login_otps(user_id,pending_token) VALUES (1,'before-password-change')");
      const session = verifyToken(enrolled.data.accessToken);
      const changed = await call(updateProfile, { user: session, body: { new_password: 'Changed-password-2', current_password: '234567890123' } });
      assert.equal(changed.status, 200, JSON.stringify(changed.data));
      assert.equal(changed.data.user.phone_aadhaar_enabled, false);
      assert.equal((await query('SELECT count(*)::integer AS n FROM login_otps WHERE user_id=1')).rows[0].n, 0);
      assert.equal((await checkAccess(before.data.accessToken)).status, 401);
      assert.equal((await call(refresh, { body: { refreshToken: before.data.refreshToken } })).status, 401);
      assert.equal((await checkAccess(changed.data.accessToken)).status, 200);
      assert.equal((await call(refresh, { body: { refreshToken: changed.data.refreshToken } })).status, 200);
      for (const identifier of ['9876543210', 'admin@example.test']) {
        assert.equal((await signIn(identifier, 'Changed-password-2')).status, 200);
        assert.equal((await signIn(identifier, 'Existing-password-1')).status, 401);
        assert.equal((await signIn(identifier, '234567890123')).status, 401);
      }
      await assert.rejects(service.updateProfile(session, { name: 'Stale request' }), /Session expired/);
      await query("UPDATE users SET role='sub_admin' WHERE id=1");
      assert.equal((await checkAccess(changed.data.accessToken)).user.role, 'sub_admin');
    });

    await t.test('contact collisions and ambiguous legacy phones never pick another person', async () => {
      const fresh = await signIn('9876543210', 'Changed-password-2');
      const session = verifyToken(fresh.data.accessToken);
      for (const patch of [{ phone: '9876543211' }, { email: ' SUBADMIN@EXAMPLE.TEST ' }]) await assert.rejects(service.updateProfile(session, { ...patch, current_password: 'Changed-password-2' }), /already assigned/);
      await query("INSERT INTO users(name,email,phone,password,role) VALUES ('Legacy duplicate','duplicate@example.test','09876543210',$1,'admin')", [password]);
      assert.equal((await signIn('9876543210', 'Changed-password-2')).status, 401);
      await query("DELETE FROM users WHERE email='duplicate@example.test'");
      await service.updateProfile(session, { name: 'Updated Name' });
      assert.equal((await userModel.findById(1)).name, 'Updated Name');
    });

    await t.test('Accounting password changes disable an older Aadhaar initial password automatically', async () => {
      const fresh = await signIn('admin@example.test', 'Changed-password-2');
      const session = verifyToken(fresh.data.accessToken);
      const result = await service.updateProfile(session, { aadhaar_number: '234567890123', current_password: 'Changed-password-2' });
      assert.equal(await matchesStaffPassword(result.user, '234567890123', { phoneLogin: true }), true);
      await query('UPDATE users SET password=$1 WHERE id=1', [await bcrypt.hash('Accounting-changed-3', 4)]);
      const user = await userModel.findById(1);
      assert.equal(await matchesStaffPassword(user, '234567890123', { phoneLogin: true }), false);
      assert.equal(userModel.sanitize(user).phone_aadhaar_enabled, false);
      assert.equal((await signIn('9876543210', 'Accounting-changed-3')).status, 200);
    });
  } finally {
    pool.query = original.query;
    pool.connect = original.connect;
    await db.close();
  }
});
