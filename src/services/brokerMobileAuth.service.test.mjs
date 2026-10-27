import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { migrateBrokerMobileAuth } from '../migrations/044_broker_mobile_auth.js';
import { createBrokerMobileAuthService } from './brokerMobileAuth.service.js';

const owner = { mobile: '9876500001', aadhaar: '234567890123' };
const linked = { mobile: '9876500003', aadhaar: '456789012345' };
const chosenPassword = 'Independent-App-Password!27';
const nextPassword = 'Recovered-App-Password!28';

// PGlite has one connection. Serialize pg-style checked-out connections so the
// concurrent reset assertions exercise the same transaction/row-lock boundary.
function pgAdapter(raw) {
  let tail = Promise.resolve();
  return {
    query: (sql, args) => raw.query(sql, args),
    async connect() {
      const before = tail;
      let unlock;
      tail = new Promise(resolve => { unlock = resolve; });
      await before;
      return { query: (sql, args) => raw.query(sql, args), release: unlock };
    },
  };
}

async function fixture() {
  const raw = new PGlite();
  await raw.exec(`
    CREATE TABLE organizations(id integer PRIMARY KEY,name text);
    INSERT INTO organizations VALUES(1,'Private Organization Brand'),(2,'Other Organization Brand');
    CREATE TABLE sites(id integer PRIMARY KEY,name text,organization_id integer);
    CREATE TABLE members(id integer PRIMARY KEY,site_id integer,full_name text,phone text,email text,aadhar_no text,
      member_type text,member_types text[],status text DEFAULT 'ACTIVE',is_active boolean DEFAULT true);
    CREATE TABLE users(id integer PRIMARY KEY,name text,email text,phone text,password text,role text,
      is_active boolean DEFAULT true,can_login_booking boolean DEFAULT true,organization_id integer,
      token_version integer DEFAULT 0,agent_status text DEFAULT 'ACTIVE');
    CREATE TABLE user_sites(user_id integer,site_id integer);
    CREATE TABLE booking_user_kyc_links(user_id integer PRIMARY KEY,member_id integer,kyc_case_id integer,phone text,aadhaar_last4 text);
    CREATE TABLE booking_staff_identities(user_id integer,aadhaar_password_hash text,password_fingerprint text,aadhaar_last4 text);
    CREATE TABLE kyc_cases(id integer PRIMARY KEY,client_member_id integer,site_id integer,status text);
    INSERT INTO sites VALUES(1,'Synthetic Site One',1),(2,'Synthetic Site Two',1),(3,'Other Organization',2);
    INSERT INTO members(id,site_id,full_name,phone,email,aadhar_no,member_type) VALUES
      (101,1,'Independent Partner','9876500001','owner@example.test','234567890123','BROKER'),
      (201,2,'Independent Partner','+91 98765 00001','owner@example.test','2345 6789 0123','BROKER'),
      (102,1,'Shared Phone Other Person','9876500001','other@example.test','345678901234','BROKER'),
      (103,1,'Client Only','9876500004','client@example.test','567890123456','CLIENT'),
      (104,1,'Mixed Roles','9876500005','mixed@example.test','678901234567','CLIENT'),
      (105,1,'Inactive Broker','9876500006','inactive@example.test','789012345678','BROKER'),
      (107,1,'No Recovery Email','9876500007',NULL,'890123456789','BROKER'),
      (301,1,'Linked Partner','9876500003','linked@example.test','456789012345','BROKER'),
      (401,2,'Linked Partner','9876500003','linked@example.test','456789012345','BROKER'),
      (501,3,'Linked Other Organization','9876500003','linked@example.test','456789012345','BROKER');
    UPDATE members SET member_types=ARRAY['CLIENT','BROKER'] WHERE id=104;
    UPDATE members SET status='INACTIVE' WHERE id=105;
    INSERT INTO users(id,name,email,phone,password,role,organization_id) VALUES
      (1,'Linked Partner','linked@example.test','9876500003','placeholder','agent',1);
    INSERT INTO user_sites VALUES(1,1),(1,2),(1,3);
    INSERT INTO kyc_cases VALUES(1,301,1,'VERIFIED');
    INSERT INTO booking_user_kyc_links VALUES(1,301,1,'9876500003','2345');
  `);
  await raw.query('UPDATE users SET password=$1 WHERE id=1', [await bcrypt.hash('Existing-Web-Password!Changed', 4)]);
  const db = pgAdapter(raw);
  await migrateBrokerMobileAuth(db);
  await migrateBrokerMobileAuth(db);
  let clock = Date.now();
  const delivered = [];
  const options = {
    now: () => clock,
    bcryptRounds: 4,
    isResetMailerEnabled: () => true,
    generateCode: () => '654321',
    generateToken: () => randomBytes(24).toString('hex'),
    sendResetEmail: async mail => { delivered.push(mail); },
  };
  return {
    raw, db, delivered, options,
    service: createBrokerMobileAuthService(db, options),
    advance: milliseconds => { clock += milliseconds; },
    close: () => raw.close(),
  };
}

test('independent broker credentials, recovery and revocation enforce exact live identity', async t => {
  const previous = process.env.MOBILE_PORTAL_SECRET;
  process.env.MOBILE_PORTAL_SECRET = 'synthetic-broker-auth-secret-at-least-thirty-two-characters';
  const f = await fixture();
  const { service, raw } = f;
  t.after(async () => {
    await f.close();
    if (previous === undefined) delete process.env.MOBILE_PORTAL_SECRET;
    else process.env.MOBILE_PORTAL_SECRET = previous;
  });
  let initialLogin;
  let currentPassword = owner.aadhaar;

  await t.test('member-only initial Aadhaar login is independent, exact and secret-free', async () => {
    const before = (await raw.query('SELECT * FROM users ORDER BY id')).rows;
    initialLogin = await service.login({ mobile: '+91 98765 00001', password: '2345-6789-0123' });
    assert.equal(initialLogin.user.role, 'broker');
    assert.equal(initialLogin.user.name, 'Independent Partner');
    const session = await service.getSession(initialLogin.token);
    assert.deepEqual([...session.brokerMemberIds].sort((a, b) => a - b), [101, 201]);
    assert.deepEqual([...session.userIds], []);
    assert.deepEqual([...session.siteIds].sort(), [1, 2]);
    const claims = jwt.decode(initialLogin.token);
    assert.equal(claims.exp - claims.iat, 30 * 86400);
    assert.equal(initialLogin.sessionDurationDays, 30);
    assert.equal(Date.parse(initialLogin.expiresAt), claims.exp * 1000);
    assert.ok(!/234567890123|2345-6789-0123|9876500001|password_hash|aadhar|aadhaar|pan_no/i.test(JSON.stringify(initialLogin)));
    assert.ok(!/234567890123|9876500001|password|aadhaar|aadhar/i.test(JSON.stringify(claims)));
    assert.throws(() => jwt.verify(initialLogin.token, process.env.MOBILE_PORTAL_SECRET));
    assert.deepEqual((await raw.query('SELECT * FROM users ORDER BY id')).rows, before);
    const account = (await raw.query('SELECT * FROM booking_broker_mobile_accounts')).rows[0];
    assert.match(account.identity_key, /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(account).includes(owner.aadhaar));
    assert.equal(await bcrypt.compare(owner.aadhaar, account.password_hash), true);
    await assert.rejects(service.login({ ...owner, password: 'wrong' }));
    await assert.rejects(service.login({ mobile: '9876500004', password: '567890123456' }));
    await assert.rejects(service.login({ mobile: '9876500006', password: '789012345678' }));
    const mixed = await service.login({ mobile: '9876500005', password: '678901234567' });
    assert.deepEqual((await service.getSession(mixed.token)).brokerMemberIds, [104]);
    const other = await service.login({ mobile: owner.mobile, password: '345678901234' });
    assert.deepEqual((await service.getSession(other.token)).brokerMemberIds, [102]);
    assert.notEqual(other.user.id, initialLogin.user.id);
  });

  await t.test('chosen app password disables Aadhaar and revokes existing sessions without changing web credentials', async () => {
    const before = (await raw.query('SELECT * FROM users ORDER BY id')).rows;
    const session = await service.getSession(initialLogin.token);
    await assert.rejects(service.changePassword(session, { currentPassword: 'wrong', newPassword: chosenPassword }));
    await assert.rejects(service.changePassword(session, { currentPassword: owner.aadhaar, newPassword: 'short' }));
    await assert.rejects(service.changePassword(session, { currentPassword: owner.aadhaar, newPassword: 'a'.repeat(73) }));
    assert.deepEqual(await service.changePassword(session, { currentPassword: owner.aadhaar, newPassword: chosenPassword }), { success: true });
    currentPassword = chosenPassword;
    await assert.rejects(service.getSession(initialLogin.token), { statusCode: 401 });
    await assert.rejects(service.login({ ...owner, password: owner.aadhaar }));
    const login = await service.login({ mobile: owner.mobile, password: currentPassword });
    assert.equal(login.user.id, initialLogin.user.id);
    assert.equal((await raw.query('SELECT password_changed FROM booking_broker_mobile_accounts WHERE id=$1', [Number(login.user.id.split(':')[1])])).rows[0].password_changed, true);
    assert.deepEqual((await raw.query('SELECT * FROM users ORDER BY id')).rows, before);
  });

  await t.test('identity corrections and inactive accounts cannot reprovision a credential or revive Aadhaar', async () => {
    const before = (await raw.query('SELECT count(*)::int AS n FROM booking_broker_mobile_accounts')).rows[0].n;
    const login = await service.login({ mobile: owner.mobile, password: currentPassword });
    await raw.query("UPDATE members SET aadhar_no='901234567890' WHERE id=ANY($1::integer[])", [[101, 201]]);
    await assert.rejects(service.getSession(login.token), { statusCode: 401 });
    await assert.rejects(service.login({ mobile: owner.mobile, password: '901234567890' }));
    assert.equal((await raw.query('SELECT count(*)::int AS n FROM booking_broker_mobile_accounts')).rows[0].n, before);
    await raw.query('UPDATE members SET aadhar_no=$1 WHERE id=ANY($2::integer[])', [owner.aadhaar, [101, 201]]);
    await raw.query('UPDATE booking_broker_mobile_accounts SET is_active=false WHERE id=$1', [Number(login.user.id.split(':')[1])]);
    await assert.rejects(service.getSession(login.token), { statusCode: 401 });
    await assert.rejects(service.login({ mobile: owner.mobile, password: currentPassword }));
    await assert.rejects(service.login({ ...owner, password: owner.aadhaar }));
    await raw.query('UPDATE booking_broker_mobile_accounts SET is_active=true WHERE id=$1', [Number(login.user.id.split(':')[1])]);
  });

  await t.test('later exact-person registrations and new staff enrollments are checked on ordinary login', async () => {
    await raw.exec(`INSERT INTO sites VALUES(4,'New Synthetic Site',1);
      INSERT INTO members(id,site_id,full_name,phone,email,aadhar_no,member_type)
      VALUES(202,4,'Independent Partner New Site','9876500001','owner@example.test','234567890123','BROKER');`);
    const expanded = await service.login({ mobile: owner.mobile, password: currentPassword });
    assert.deepEqual([...((await service.getSession(expanded.token)).brokerMemberIds)].sort((a, b) => a - b), [101, 201, 202]);
    await raw.exec('DELETE FROM members WHERE id=202; DELETE FROM sites WHERE id=4');
    const beforeLink = await service.login({ mobile: owner.mobile, password: currentPassword });
    await raw.exec(`INSERT INTO users(id,name,email,phone,password,role,organization_id)
      VALUES(2,'Later Linked Partner','owner@example.test','9876500001','independent-web-hash','agent',1);
      UPDATE users SET can_login_booking=false WHERE id=2;
      INSERT INTO user_sites VALUES(2,1),(2,2);
      INSERT INTO kyc_cases VALUES(2,101,1,'VERIFIED');
      INSERT INTO booking_user_kyc_links VALUES(2,101,2,'9876500001','0123');`);
    await assert.rejects(service.getSession(beforeLink.token), { statusCode: 401 });
    await assert.rejects(service.login({ mobile: owner.mobile, password: currentPassword }));
    // A failed sign-in rolls back its own transaction. Enrollment history must
    // still survive unlinking before the broker has any successful new session.
    await raw.exec('DELETE FROM booking_user_kyc_links WHERE user_id=2; UPDATE users SET can_login_booking=true WHERE id=2');
    await assert.rejects(service.login({ mobile: owner.mobile, password: currentPassword }));
    await raw.exec("INSERT INTO booking_user_kyc_links VALUES(2,101,2,'9876500001','0123')");
    const enrolled = await service.login({ mobile: owner.mobile, password: currentPassword });
    assert.deepEqual((await service.getSession(enrolled.token)).userIds, [2]);
    await raw.exec('UPDATE users SET can_login_booking=false WHERE id=2');
    await assert.rejects(service.getSession(enrolled.token), { statusCode: 401 });
    await assert.rejects(service.login({ mobile: owner.mobile, password: currentPassword }));
    await raw.exec('UPDATE users SET can_login_booking=true WHERE id=2; DELETE FROM booking_user_kyc_links WHERE user_id=2');
    await assert.rejects(service.login({ mobile: owner.mobile, password: currentPassword }));
    await raw.exec("INSERT INTO booking_user_kyc_links VALUES(2,101,2,'9876500001','0123')");
    assert.ok((await service.login({ mobile: owner.mobile, password: currentPassword })).token);
  });

  await t.test('linked enrollments remain binding after unlinking and web revocation', async () => {
    const before = (await raw.query('SELECT * FROM users ORDER BY id')).rows;
    const login = await service.login({ ...linked, password: linked.aadhaar });
    const session = await service.getSession(login.token);
    assert.deepEqual([...session.brokerMemberIds].sort((a, b) => a - b), [301, 401]);
    assert.deepEqual(session.userIds, [1]);
    for (const [change, restore] of [
      ['UPDATE users SET is_active=false WHERE id=1', 'UPDATE users SET is_active=true WHERE id=1'],
      ['UPDATE users SET can_login_booking=false WHERE id=1', 'UPDATE users SET can_login_booking=true WHERE id=1'],
      ["UPDATE users SET role='admin' WHERE id=1", "UPDATE users SET role='agent' WHERE id=1"],
      ["UPDATE kyc_cases SET status='PENDING' WHERE id=1", "UPDATE kyc_cases SET status='VERIFIED' WHERE id=1"],
      ["UPDATE members SET status='BLOCKED' WHERE id=301", "UPDATE members SET status='ACTIVE' WHERE id=301"],
    ]) {
      await raw.exec(change);
      await assert.rejects(service.getSession(login.token), { statusCode: 401 });
      await assert.rejects(service.login({ ...linked, password: linked.aadhaar }));
      await raw.exec(restore);
    }
    await raw.exec('DELETE FROM booking_user_kyc_links WHERE user_id=1');
    await assert.rejects(service.getSession(login.token), { statusCode: 401 });
    await assert.rejects(service.login({ ...linked, password: linked.aadhaar }));
    assert.equal((await raw.query('SELECT count(*)::int AS n FROM booking_broker_mobile_user_bindings WHERE user_id=1')).rows[0].n, 1);
    await raw.exec("INSERT INTO booking_user_kyc_links VALUES(1,301,1,'9876500003','2345')");
    const valid = await service.login({ ...linked, password: linked.aadhaar });
    await raw.exec('UPDATE users SET token_version=token_version+1 WHERE id=1');
    await assert.rejects(service.getSession(valid.token), { statusCode: 401 });
    await raw.exec('UPDATE users SET token_version=token_version-1 WHERE id=1');
    assert.deepEqual((await raw.query('SELECT * FROM users ORDER BY id')).rows, before);
  });

  await t.test('recovery uses only registered email and opaque challenges, and never stores plaintext codes', async () => {
    const response = await service.requestPasswordReset({ ...owner, email: 'attacker@example.test' });
    assert.ok(response.challengeId);
    assert.equal(response.expiresInSeconds, 300);
    assert.equal(response.resendAfterSeconds, 60);
    assert.equal(response.emailHint, 'ow•••@•••');
    assert.ok(!JSON.stringify(response).includes('example.test'));
    assert.ok(!JSON.stringify(response).includes('654321'));
    assert.equal(f.delivered.length, 1);
    assert.equal(f.delivered[0].to, 'owner@example.test');
    assert.equal(f.delivered[0].code, '654321');
    assert.ok(!JSON.stringify(f.delivered[0]).includes(owner.aadhaar));
    const rows = (await raw.query('SELECT * FROM booking_broker_mobile_resets')).rows;
    assert.equal(rows.length, 1);
    assert.ok(!JSON.stringify(rows).includes('654321'));
    assert.ok(!JSON.stringify(rows).includes(response.challengeId));
    const invalid = await service.requestPasswordReset({ mobile: '9876599999', aadhaar: '901234567890' });
    assert.ok(invalid.challengeId);
    assert.equal(invalid.expiresInSeconds, 300);
    assert.equal(f.delivered.length, 1);
    await assert.rejects(service.confirmPasswordReset({ challengeId: invalid.challengeId, code: '654321', newPassword: nextPassword }));
    await assert.rejects(service.requestPasswordReset({ mobile: '9876500007', aadhaar: '890123456789' }), { statusCode: 503 });
    assert.equal(f.delivered.length, 1);
  });

  await t.test('wrong OTP attempts are bounded and valid recovery rotates only app credentials', async () => {
    f.advance(16 * 60_000);
    const challenge = await service.requestPasswordReset(owner);
    for (let i = 0; i < 5; i++) await assert.rejects(service.confirmPasswordReset({ challengeId: challenge.challengeId, code: '000000', newPassword: nextPassword }));
    await assert.rejects(service.confirmPasswordReset({ challengeId: challenge.challengeId, code: '654321', newPassword: nextPassword }));
    assert.ok((await service.login({ mobile: owner.mobile, password: currentPassword })).token);
    f.advance(61_000);
    const next = await service.requestPasswordReset(owner);
    const old = await service.login({ mobile: owner.mobile, password: currentPassword });
    const before = (await raw.query('SELECT * FROM users ORDER BY id')).rows;
    assert.deepEqual(await service.confirmPasswordReset({ challengeId: next.challengeId, code: '654321', newPassword: nextPassword }), { success: true });
    currentPassword = nextPassword;
    await assert.rejects(service.getSession(old.token), { statusCode: 401 });
    await assert.rejects(service.login({ ...owner, password: owner.aadhaar }));
    await assert.rejects(service.login({ mobile: owner.mobile, password: chosenPassword }));
    assert.ok((await service.login({ mobile: owner.mobile, password: currentPassword })).token);
    await assert.rejects(service.confirmPasswordReset({ challengeId: next.challengeId, code: '654321', newPassword: chosenPassword }));
    assert.deepEqual((await raw.query('SELECT * FROM users ORDER BY id')).rows, before);
  });

  await t.test('expired, changed-email and changed-identity reset challenges fail closed', async () => {
    f.advance(16 * 60_000);
    let challenge = await service.requestPasswordReset(owner);
    f.advance(301_000);
    await assert.rejects(service.confirmPasswordReset({ challengeId: challenge.challengeId, code: '654321', newPassword: chosenPassword }));
    f.advance(61_000);
    challenge = await service.requestPasswordReset(owner);
    await raw.query("UPDATE members SET email='replacement@example.test' WHERE id=ANY($1::integer[])", [[101, 201]]);
    await assert.rejects(service.confirmPasswordReset({ challengeId: challenge.challengeId, code: '654321', newPassword: chosenPassword }));
    await raw.query("UPDATE members SET email='owner@example.test' WHERE id=ANY($1::integer[])", [[101, 201]]);
    f.advance(61_000);
    challenge = await service.requestPasswordReset(owner);
    await raw.query("UPDATE members SET aadhar_no='901234567890' WHERE id=ANY($1::integer[])", [[101, 201]]);
    await assert.rejects(service.confirmPasswordReset({ challengeId: challenge.challengeId, code: '654321', newPassword: chosenPassword }));
    await raw.query('UPDATE members SET aadhar_no=$1 WHERE id=ANY($2::integer[])', [owner.aadhaar, [101, 201]]);
    assert.ok((await service.login({ mobile: owner.mobile, password: currentPassword })).token);
  });

  await t.test('resends replace old codes, concurrent sends serialize and account quotas survive password changes', async () => {
    f.advance(16 * 60_000);
    const before = f.delivered.length;
    const first = await service.requestPasswordReset(owner);
    f.advance(61_000);
    await service.requestPasswordReset(owner);
    await assert.rejects(service.confirmPasswordReset({ challengeId: first.challengeId, code: '654321', newPassword: chosenPassword }));
    f.advance(61_000);
    const concurrent = await Promise.allSettled([service.requestPasswordReset(owner), service.requestPasswordReset(owner)]);
    assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(concurrent.filter(result => result.status === 'rejected' && result.reason.statusCode === 429).length, 1);
    assert.equal(f.delivered.length - before, 3);
    f.advance(61_000);
    await service.requestPasswordReset(owner);
    f.advance(61_000);
    const last = await service.requestPasswordReset(owner);
    assert.equal(f.delivered.length - before, 5);
    f.advance(61_000);
    await assert.rejects(service.requestPasswordReset(owner), { statusCode: 429 });
    assert.equal(f.delivered.length - before, 5);
    const resetPassword = 'Quota-Test-App-Password!29';
    await service.confirmPasswordReset({ challengeId: last.challengeId, code: '654321', newPassword: resetPassword });
    const login = await service.login({ mobile: owner.mobile, password: resetPassword });
    currentPassword = 'Post-Quota-Change-Password!30';
    await service.changePassword(await service.getSession(login.token), { currentPassword: resetPassword, newPassword: currentPassword });
    await assert.rejects(service.requestPasswordReset(owner), { statusCode: 429 });
    assert.equal(f.delivered.length - before, 5);
  });

  await t.test('concurrent valid confirmations consume exactly once', async () => {
    f.advance(16 * 60_000);
    const challenge = await service.requestPasswordReset(owner);
    const passwords = ['Concurrent-App-Password!A', 'Concurrent-App-Password!B'];
    const results = await Promise.allSettled(passwords.map(newPassword => service.confirmPasswordReset({ challengeId: challenge.challengeId, code: '654321', newPassword })));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    currentPassword = passwords[results.findIndex(result => result.status === 'fulfilled')];
    assert.ok((await service.login({ mobile: owner.mobile, password: currentPassword })).token);
  });

  await t.test('delivery failure never changes the password or creates a usable recovery challenge', async () => {
    f.advance(16 * 60_000);
    const failing = createBrokerMobileAuthService(f.db, { ...f.options, sendResetEmail: async () => { throw new Error('Synthetic delivery failure'); } });
    const before = (await raw.query('SELECT password_hash,token_version FROM booking_broker_mobile_accounts WHERE id=$1', [Number(initialLogin.user.id.split(':')[1])])).rows[0];
    let challenge;
    try { challenge = await failing.requestPasswordReset(owner); } catch (error) { assert.ok(error.statusCode >= 400); }
    if (challenge) await assert.rejects(failing.confirmPasswordReset({ challengeId: challenge.challengeId, code: '654321', newPassword: chosenPassword }));
    const after = (await raw.query('SELECT password_hash,token_version FROM booking_broker_mobile_accounts WHERE id=$1', [Number(initialLogin.user.id.split(':')[1])])).rows[0];
    assert.deepEqual(after, before);
    assert.ok((await service.login({ mobile: owner.mobile, password: currentPassword })).token);
    const disabled = createBrokerMobileAuthService(f.db, { ...f.options, isResetMailerEnabled: () => false });
    f.advance(61_000);
    const count = f.delivered.length;
    try { await disabled.requestPasswordReset(owner); } catch (error) { assert.ok(error.statusCode >= 400); }
    assert.equal(f.delivered.length, count);
  });
});

test('broker enrollment capture handles pending links and unvisited sites without phone-only matches', async t => {
  const previous = process.env.MOBILE_PORTAL_SECRET;
  process.env.MOBILE_PORTAL_SECRET = 'synthetic-broker-trigger-secret-at-least-thirty-two-characters';
  const f = await fixture();
  t.after(async () => {
    await f.close();
    if (previous === undefined) delete process.env.MOBILE_PORTAL_SECRET;
    else process.env.MOBILE_PORTAL_SECRET = previous;
  });
  const { raw, service } = f;
  const initial = await service.login({ ...owner, password: owner.aadhaar });
  const accountId = Number(initial.user.id.split(':')[1]);
  await raw.exec(`INSERT INTO sites VALUES(4,'Unvisited Synthetic Site',1);
    INSERT INTO members(id,site_id,full_name,phone,email,aadhar_no,member_type)
      VALUES(202,4,'Independent New Registration','+91 98765 00001','owner@example.test','2345-6789-0123','BROKER');
    INSERT INTO users(id,name,email,phone,password,role,organization_id,can_login_booking)
      VALUES(2,'Newly Enrolled Partner','owner@example.test','9876500001','synthetic-web-hash','agent',1,false);
    INSERT INTO user_sites VALUES(2,1),(2,2),(2,4);
    INSERT INTO kyc_cases VALUES(2,202,4,'VERIFIED');
    INSERT INTO booking_user_kyc_links VALUES(2,202,2,'9876500001','0123');`);
  assert.equal((await raw.query('SELECT count(*)::int AS n FROM booking_broker_mobile_members WHERE account_id=$1 AND member_id=202', [accountId])).rows[0].n, 0);
  assert.equal((await raw.query('SELECT count(*)::int AS n FROM booking_broker_mobile_user_bindings WHERE account_id=$1 AND user_id=2', [accountId])).rows[0].n, 1);
  // Remove the enrollment before the app ever visits this registration.
  await raw.exec('DELETE FROM booking_user_kyc_links WHERE user_id=2; UPDATE users SET can_login_booking=true WHERE id=2');
  await assert.rejects(service.getSession(initial.token), { statusCode: 401 });
  await assert.rejects(service.login({ ...owner, password: owner.aadhaar }));
  await raw.exec("INSERT INTO booking_user_kyc_links VALUES(2,202,2,'9876500001','0123')");
  const enrolled = await service.login({ ...owner, password: owner.aadhaar });
  assert.deepEqual((await service.getSession(enrolled.token)).brokerMemberIds, [101, 201, 202]);

  // A different broker shares the mobile but has a different exact Aadhaar.
  await raw.exec(`INSERT INTO users(id,name,email,phone,password,role,organization_id,can_login_booking)
      VALUES(4,'Other Person Shared Phone','other@example.test','9876500001','different-web-hash','agent',1,false);
    INSERT INTO user_sites VALUES(4,1);
    INSERT INTO kyc_cases VALUES(4,102,1,'VERIFIED');
    INSERT INTO booking_user_kyc_links VALUES(4,102,4,'9876500001','1234');`);
  assert.equal((await raw.query('SELECT count(*)::int AS n FROM booking_broker_mobile_user_bindings WHERE account_id=$1 AND user_id=4', [accountId])).rows[0].n, 0);
  assert.ok((await service.login({ ...owner, password: owner.aadhaar })).token);

  const mixed = await service.login({ mobile: '9876500005', password: '678901234567' });
  const mixedId = Number(mixed.user.id.split(':')[1]);
  await raw.exec(`INSERT INTO users(id,name,email,phone,password,role,organization_id)
      VALUES(3,'Pending Enrollment','mixed@example.test','9876500005','pending-web-hash','agent',1);
    INSERT INTO user_sites VALUES(3,1);
    INSERT INTO booking_user_kyc_links VALUES(3,104,NULL,'9876500005','4567');`);
  assert.equal((await raw.query('SELECT count(*)::int AS n FROM booking_broker_mobile_user_bindings WHERE account_id=$1', [mixedId])).rows[0].n, 0);
  await assert.rejects(service.getSession(mixed.token), { statusCode: 401 });
  await raw.exec("INSERT INTO kyc_cases VALUES(3,104,1,'VERIFIED'); UPDATE booking_user_kyc_links SET kyc_case_id=3 WHERE user_id=3");
  const ready = await service.login({ mobile: '9876500005', password: '678901234567' });
  assert.deepEqual((await service.getSession(ready.token)).userIds, [3]);
  // Changing to a pending link cannot erase its previous non-null enrollment.
  await raw.exec('UPDATE booking_user_kyc_links SET kyc_case_id=NULL WHERE user_id=3; DELETE FROM booking_user_kyc_links WHERE user_id=3');
  assert.equal((await raw.query('SELECT kyc_case_id FROM booking_broker_mobile_user_bindings WHERE account_id=$1 AND user_id=3', [mixedId])).rows[0].kyc_case_id, 3);
  await assert.rejects(service.login({ mobile: '9876500005', password: '678901234567' }));
});

test('a dedicated stable identity secret preserves app passwords across signing-key rotation', async t => {
  const previous = {
    signing: process.env.MOBILE_PORTAL_SECRET,
    identity: process.env.BROKER_MOBILE_IDENTITY_SECRET,
  };
  process.env.MOBILE_PORTAL_SECRET = 'synthetic-signing-key-before-rotation-at-least-thirty-two';
  process.env.BROKER_MOBILE_IDENTITY_SECRET = 'synthetic-stable-identity-key-at-least-thirty-two';
  const f = await fixture();
  t.after(async () => {
    await f.close();
    if (previous.signing === undefined) delete process.env.MOBILE_PORTAL_SECRET;
    else process.env.MOBILE_PORTAL_SECRET = previous.signing;
    if (previous.identity === undefined) delete process.env.BROKER_MOBILE_IDENTITY_SECRET;
    else process.env.BROKER_MOBILE_IDENTITY_SECRET = previous.identity;
  });
  const initial = await f.service.login({ ...owner, password: owner.aadhaar });
  await f.service.changePassword(await f.service.getSession(initial.token), { currentPassword: owner.aadhaar, newPassword: chosenPassword });
  const before = await f.service.login({ mobile: owner.mobile, password: chosenPassword });
  const identity = (await f.raw.query('SELECT identity_key FROM booking_broker_mobile_accounts WHERE id=$1', [Number(before.user.id.split(':')[1])])).rows[0].identity_key;
  process.env.MOBILE_PORTAL_SECRET = 'synthetic-signing-key-after-rotation-at-least-thirty-two';
  await assert.rejects(f.service.getSession(before.token), { statusCode: 401 });
  const after = await f.service.login({ mobile: owner.mobile, password: chosenPassword });
  assert.equal(after.user.id, before.user.id);
  assert.equal((await f.raw.query('SELECT identity_key FROM booking_broker_mobile_accounts WHERE id=$1', [Number(after.user.id.split(':')[1])])).rows[0].identity_key, identity);
  await assert.rejects(f.service.login({ ...owner, password: owner.aadhaar }));
  process.env.BROKER_MOBILE_IDENTITY_SECRET = 'too-short';
  await assert.rejects(f.service.login({ mobile: owner.mobile, password: chosenPassword }), { statusCode: 503 });
});
