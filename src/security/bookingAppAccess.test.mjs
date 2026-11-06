import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import { PGlite } from '@electric-sql/pglite';

process.env.JWT_ACCESS_SECRET = 'booking-app-permission-tests-access-key';
process.env.JWT_REFRESH_SECRET = 'booking-app-permission-tests-refresh-key';
process.env.LOGIN_OTP_ENABLED = 'false';
const { login, refresh, verifyLoginOtp, resendLoginOtp } = await import('../controllers/auth.controller.js');
const { default: users } = await import('../models/User.model.js');
const { default: pool } = await import('../config/db.js');
const { signAccessToken, signRefreshToken, verifyToken } = await import('../config/jwt.js');
const { currentStaffSession } = await import('../services/staffSession.js');
const { default: auth, authBootstrapMiddleware, clientInvitationAuthMiddleware } = await import('../middlewares/auth.middleware.js');
const { migrateBookingAccountsLoginAccess } = await import('../migrations/047_booking_accounts_login_access.js');

const baseUser = { id: 8, email: 'desk@example.test', role: 'sub_admin', token_version: 2, is_active: true };
const request = (handler, body = {}) => new Promise(resolve => {
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; },
    json(data) { resolve({ status: this.statusCode, data }); return this; } };
  handler({ body }, res, error => resolve({ status: error.status || 500, data: { message: error.message } }));
});

test('all eight app permission combinations keep Booking and Booking Account independent from Accounts', async () => {
  const saved = { findByLoginIdentifier: users.findByLoginIdentifier, findById: users.findById, setRefreshToken: users.setRefreshToken };
  let user = { ...baseUser, password: await bcrypt.hash('secret-password', 4) };
  users.findByLoginIdentifier = users.findById = async () => user;
  users.setRefreshToken = async () => {};
  try {
    for (const accounts of [false, true]) for (const booking of [false, true]) for (const accountancy of [false, true]) {
      user = { ...user, can_login_accounts: accounts, can_login_booking: booking, can_login_booking_accounts: accountancy };
      const label = JSON.stringify({ accounts, booking, accountancy });
      const signedIn = await request(login, { identifier: user.email, password: 'secret-password' });
      assert.equal(signedIn.status, booking || accountancy ? 200 : 403, label);
      const accessToken = signAccessToken({ id: user.id, version: user.token_version, app: 'booking' });
      const refreshToken = signRefreshToken({ id: user.id, version: user.token_version, app: 'booking' });
      const db = { query: async () => ({ rows: [user] }) };
      const refreshed = await request(refresh, { refreshToken });
      assert.equal(refreshed.status, booking || accountancy ? 200 : 401, label);
      if (booking || accountancy) {
        assert.equal(verifyToken(signedIn.data.accessToken).app, 'booking');
        assert.equal(verifyToken(refreshed.data.accessToken).app, 'booking');
        assert.equal(verifyToken(refreshed.data.refreshToken, process.env.JWT_REFRESH_SECRET).app, 'booking');
        assert.equal((await currentStaffSession(accessToken, db, { allowAccountancyOnly: true })).can_login_booking_accounts, accountancy);
      } else {
        await assert.rejects(currentStaffSession(accessToken, db, { allowAccountancyOnly: true }), { code: 'INVALID_SESSION' });
      }
      if (booking) assert.equal((await currentStaffSession(accessToken, db)).id, user.id);
      else await assert.rejects(currentStaffSession(accessToken, db), { code: accountancy ? 'BOOKING_ACCESS_DENIED' : 'INVALID_SESSION' });
    }
  } finally { Object.assign(users, saved); }
});

test('current flags revoke business access immediately while preserving accountancy bootstrap; neither app can reuse another app token', async () => {
  const db = new PGlite();
  const savedQuery = pool.query;
  const savedFind = users.findById;
  pool.query = (...args) => db.query(...args);
  users.findById = async id => (await db.query('SELECT * FROM users WHERE id=$1', [id])).rows[0];
  const tokenFor = app => signAccessToken({ id: 8, version: 2, app });
  const middleware = async (handler, token, existingUser) => {
    const out = { status: 200, next: false };
    await handler({ user: existingUser, header: () => `Bearer ${token}` }, {
      set() { return this; }, status(code) { out.status = code; return this; }, json(body) { out.body = body; return this; },
    }, () => { out.next = true; });
    return out;
  };
  try {
    await db.exec(`CREATE TABLE users(id INT PRIMARY KEY,email TEXT,role TEXT,is_active BOOLEAN,token_version INT,
      can_login_accounts BOOLEAN,can_login_booking BOOLEAN,can_login_booking_accounts BOOLEAN);
      INSERT INTO users VALUES(8,'desk@example.test','sub_admin',true,2,false,true,true)`);
    assert.equal((await middleware(auth, tokenFor('booking'))).next, true);
    await db.exec('UPDATE users SET can_login_booking=false');
    assert.equal((await middleware(auth, tokenFor('booking'))).status, 403);
    assert.equal((await middleware(authBootstrapMiddleware, tokenFor('booking'))).next, true);
    assert.equal((await middleware(auth, tokenFor('booking'), { can_login_booking: false })).status, 403, 'bootstrap user cannot bypass business guard');
    await db.exec('UPDATE users SET can_login_booking=true,can_login_accounts=true');
    for (const app of ['accounts', 'booking_accounts', 'unknown']) {
      assert.equal((await middleware(auth, tokenFor(app))).status, 401);
      assert.equal((await middleware(authBootstrapMiddleware, tokenFor(app))).status, 401);
      assert.equal((await request(refresh, { refreshToken: signRefreshToken({ id: 8, version: 2, app }) })).status, 401);
    }
    await db.exec('UPDATE users SET can_login_booking=false,can_login_booking_accounts=false');
    assert.equal((await middleware(authBootstrapMiddleware, tokenFor('booking'))).status, 401);
    // The one existing cross-app client invitation integration remains explicit,
    // super-admin-only and still subject to the current Accounts permission.
    assert.equal((await middleware(clientInvitationAuthMiddleware, tokenFor('accounts'))).status, 401);
    await db.exec("UPDATE users SET role='super_admin'");
    assert.equal((await middleware(clientInvitationAuthMiddleware, tokenFor('accounts'))).next, true);
    assert.equal((await middleware(auth, tokenFor('accounts'))).status, 401);
    assert.equal((await middleware(auth, tokenFor('accounts'), { app: 'accounts', role: 'super_admin', can_login_booking: true, can_login_accounts: true })).status, 401, 'an integration cannot carry its scoped identity into Booking business middleware');
    await db.exec('UPDATE users SET can_login_accounts=false');
    assert.equal((await middleware(clientInvitationAuthMiddleware, tokenFor('accounts'))).status, 401);
  } finally { pool.query = savedQuery; users.findById = savedFind; await db.close(); }
});

test('Booking OTP verification and resend reject other app challenges and recheck access', async () => {
  const db = new PGlite();
  const saved = { query: pool.query, find: users.findById, save: users.setRefreshToken };
  let user = { ...baseUser, can_login_accounts: false, can_login_booking: false, can_login_booking_accounts: true };
  let issued = 0;
  pool.query = (...args) => db.query(...args);
  users.findById = async () => user;
  users.setRefreshToken = async () => { issued += 1; };
  try {
    await db.exec(`CREATE TABLE login_otps(id SERIAL PRIMARY KEY,user_id INT,pending_token TEXT,otp_hash TEXT,
      attempts INT DEFAULT 0,expires_at TIMESTAMPTZ,consumed_at TIMESTAMPTZ,last_sent_at TIMESTAMPTZ DEFAULT now()-interval '1 minute',app_context TEXT)`);
    const hash = await bcrypt.hash('123456', 4);
    const pending = 'a'.repeat(48);
    const insert = async context => {
      await db.exec('TRUNCATE login_otps');
      await db.query("INSERT INTO login_otps(user_id,pending_token,otp_hash,expires_at,app_context) VALUES(8,$1,$2,now()+interval '5 minutes',$3)", [pending, hash, context]);
    };
    for (const context of [null, 'accounts', 'booking_accounts']) {
      await insert(context);
      assert.equal((await request(verifyLoginOtp, { pending_token: pending, otp: '123456' })).status, 401);
      assert.equal((await request(resendLoginOtp, { pending_token: pending })).status, 401);
      assert.equal((await db.query('SELECT attempts FROM login_otps')).rows[0].attempts, 0);
    }
    await insert('booking');
    const valid = await request(verifyLoginOtp, { pending_token: pending, otp: '123456' });
    assert.equal(valid.status, 200);
    assert.equal(verifyToken(valid.data.accessToken).app, 'booking');
    assert.equal(issued, 1);
    await insert('booking');
    user = { ...user, can_login_booking_accounts: false };
    assert.equal((await request(resendLoginOtp, { pending_token: pending })).status, 403);
    assert.equal((await request(verifyLoginOtp, { pending_token: pending, otp: '123456' })).status, 403);
    assert.equal(issued, 1);
  } finally { pool.query = saved.query; users.findById = saved.find; users.setRefreshToken = saved.save; await db.close(); }
});

test('shared migration is additive, rerunnable and preserves disabled app choices', async () => {
  const db = new PGlite();
  const adapter = { connect: async () => ({
    query: (sql, values) => sql.includes('pg_advisory_xact_lock') ? Promise.resolve({ rows: [] }) : db.query(sql, values),
    release() {},
  }) };
  try {
    await db.exec('CREATE TABLE users(id INT PRIMARY KEY,can_login_booking BOOLEAN NOT NULL DEFAULT TRUE); INSERT INTO users VALUES(8,true),(9,false)');
    await migrateBookingAccountsLoginAccess(adapter);
    assert.deepEqual((await db.query('SELECT can_login_booking_accounts FROM users ORDER BY id')).rows.map(row => row.can_login_booking_accounts), [true, false], 'preserve existing Booking denials on initial rollout');
    await db.exec('UPDATE users SET can_login_booking_accounts=false,can_login_booking=false,can_login_accounts=false');
    await migrateBookingAccountsLoginAccess(adapter);
    assert.deepEqual((await db.query('SELECT can_login_accounts,can_login_booking,can_login_booking_accounts FROM users')).rows[0], {
      can_login_accounts: false, can_login_booking: false, can_login_booking_accounts: false,
    });
    await db.query("INSERT INTO login_otps(user_id,pending_token,otp_hash,expires_at,app_context) VALUES(8,'challenge','hash',now(),'booking')");
    assert.equal((await db.query('SELECT app_context FROM login_otps')).rows[0].app_context, 'booking');
  } finally { await db.close(); }
});
