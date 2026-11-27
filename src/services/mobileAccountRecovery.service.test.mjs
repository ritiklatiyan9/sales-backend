import { strict as assert } from 'node:assert';
import test from 'node:test';
import bcrypt from 'bcrypt';
import { PGlite } from '@electric-sql/pglite';
import { migrateMobileAccountRecovery } from '../migrations/055_mobile_account_recovery.js';
import { clientIdentityKey } from './clientPortal.service.js';
import { createMobileAccountRecovery } from './mobileAccountRecovery.service.js';
import { createMobilePortalService } from './mobilePortal.service.js';

test('verified recovery resets only the selected account and revokes its prior mobile sessions', async t => {
  process.env.CLIENT_PORTAL_IDENTITY_SECRET = 'isolated-test-identity-secret';
  process.env.MOBILE_PORTAL_SECRET = 'isolated-test-mobile-signing-secret';
  const raw = new PGlite();
  t.after(() => raw.close());
  const query = async (sql, params) => {
    const result = await raw.query(sql, params);
    return { ...result, rowCount: result.affectedRows };
  };
  const db = { query, connect: async () => ({ query, release() {} }) };
  await raw.exec(`
    CREATE TABLE sites(id integer PRIMARY KEY, name text, code text, organization_id integer);
    CREATE TABLE users(id integer PRIMARY KEY, role text, is_active boolean, token_version integer,
      can_login_accounts boolean, can_login_booking boolean, organization_id integer);
    CREATE TABLE audit_logs(organization_id integer, site_id integer, user_id integer, action text,
      event_type text, module text, entity_type text, entity_id text, request_method text,
      request_path text, status_code integer, outcome text, description text);
    CREATE TABLE members(id integer PRIMARY KEY, site_id integer, full_name text, phone text, aadhar_no text,
      member_type text, member_types text[], is_active boolean DEFAULT true, email text, pan_no text);
    CREATE TABLE kyc_cases(id integer PRIMARY KEY, client_member_id integer, site_id integer, status text);
    CREATE TABLE booking_client_accounts(id integer PRIMARY KEY, phone text, identity_key text,
      password_hash text, password_changed boolean, token_version integer DEFAULT 0,
      is_active boolean DEFAULT true, aadhaar_last4 text, updated_at timestamptz DEFAULT now());
    CREATE TABLE booking_client_members(account_id integer, member_id integer UNIQUE, PRIMARY KEY(account_id, member_id));
    INSERT INTO sites VALUES (1,'Example','ONE',1);
    INSERT INTO users VALUES (7,'super_admin',true,2,true,false,1);
    INSERT INTO members(id,site_id,full_name,phone,aadhar_no,member_type) VALUES
      (1,1,'Example','9876500001','234567890123','CLIENT'),
      (2,1,'Other','9876500001','345678901234','CLIENT');
    INSERT INTO kyc_cases VALUES (1,1,1,'VERIFIED'), (2,2,1,'VERIFIED');
    INSERT INTO booking_client_members VALUES (1,1),(2,2);
  `);
  const previous = 'Previous-password-123';
  const other = 'Other-password-123';
  await query(`INSERT INTO booking_client_accounts(id,phone,identity_key,password_hash,password_changed)
    VALUES (1,$1,$2,$3,true),(2,$1,$4,$5,true)`, [
    '9876500001', clientIdentityKey('234567890123'), await bcrypt.hash(previous, 4),
    clientIdentityKey('345678901234'), await bcrypt.hash(other, 4),
  ]);
  await migrateMobileAccountRecovery(db);
  await migrateMobileAccountRecovery(db);

  let time = new Date();
  const recovery = createMobileAccountRecovery(db, { now: () => time });
  const mobilePortal = createMobilePortalService(db);
  const mobile = '9876500001';
  const oldSession = await mobilePortal.login({ mobile, password: previous });
  const request = { memberId: 1, identityVerified: true, actor: { id: 7, version: 2, role: 'super_admin', app: 'accounts' } };
  await assert.rejects(recovery.issue({ ...request, identityVerified: false }), { statusCode: 400 });
  await assert.rejects(recovery.issue({ ...request, actor: { ...request.actor, version: 1 } }), { statusCode: 403 });
  await assert.rejects(recovery.issue({ ...request, actor: { ...request.actor, role: 'agent' } }), { statusCode: 403 });
  await assert.rejects(recovery.issue({ ...request, memberId: 3 }), { statusCode: 404 });
  const expired = await recovery.issue(request);
  time = new Date(expired.expiresAt);
  const newPassword = 'Client-chosen-password-123';
  await assert.rejects(recovery.confirm({ mobile, code: expired.code, newPassword }), { statusCode: 401 });
  const superseded = await recovery.issue(request);
  const supersededLogin = await mobilePortal.login({ mobile, password: superseded.code });
  const active = await recovery.issue(request);
  assert.equal((await query('SELECT count(*)::integer AS count FROM audit_logs')).rows[0].count, 3);
  assert.equal((await query('SELECT count(*)::integer AS count FROM booking_client_password_resets WHERE code_hash=$1', [active.code])).rows[0].count, 0);
  await assert.rejects(recovery.confirm({ mobile, code: superseded.code, newPassword }), { statusCode: 401 });
  await assert.rejects(mobilePortal.getSession(supersededLogin.token), { statusCode: 401 });
  await assert.rejects(recovery.confirm({ mobile: '9876500002', code: active.code, newPassword }), { statusCode: 401 });
  await assert.rejects(mobilePortal.login({ mobile: '9876500002', password: active.code }), { statusCode: 401 });
  const recoveryLogin = await mobilePortal.login({ mobile, password: active.code });
  assert.equal(recoveryLogin.passwordChangeRequired, true);
  const recoverySession = await mobilePortal.getSession(recoveryLogin.token);
  await assert.rejects(mobilePortal.portfolio(recoverySession), { statusCode: 403 });
  await assert.rejects(mobilePortal.changePassword(recoverySession, { currentPassword: previous, newPassword }), { statusCode: 403 });
  await assert.rejects(recovery.confirm({ mobile, code: active.code, newPassword: other }), { statusCode: 400 });
  await assert.rejects(recovery.confirm({ mobile, code: active.code, newPassword: '2345 6789 0123' }), { statusCode: 400 });
  await query("UPDATE kyc_cases SET status='OPEN' WHERE id=1");
  await assert.rejects(recovery.confirm({ mobile, code: active.code, newPassword }), { statusCode: 401 });
  await query("UPDATE kyc_cases SET status='VERIFIED' WHERE id=1");

  await mobilePortal.changePassword(recoverySession, { currentPassword: active.code, newPassword });
  await assert.rejects(recovery.confirm({ mobile, code: active.code, newPassword }), { statusCode: 401 });
  await assert.rejects(mobilePortal.getSession(recoveryLogin.token), { statusCode: 401 });
  await assert.rejects(mobilePortal.login({ mobile, password: active.code }), { statusCode: 401 });
  await assert.rejects(mobilePortal.login({ mobile, password: previous }), { statusCode: 401 });
  await assert.rejects(mobilePortal.getSession(oldSession.token), { statusCode: 401 });
  assert.equal((await mobilePortal.login({ mobile, password: newPassword })).user.name, 'Example');
  assert.equal((await mobilePortal.login({ mobile, password: other })).user.name, 'Other');
});
