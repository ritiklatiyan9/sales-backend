import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { createBrokerReviewerAccess } from './brokerReviewer.service.js';
import { createBrokerMobileAuthService } from './brokerMobileAuth.service.js';
import { createBrokerMobileRouter } from '../routes/brokerMobile.routes.js';

const password = 'fictional test credential';
const passwordHash = await bcrypt.hash(password, 10);
const settings = () => ({ BROKER_REVIEWER_ENABLED: 'true', BROKER_REVIEWER_PHONE: '9999900016',
  BROKER_REVIEWER_PASSWORD_HASH: passwordHash, BROKER_REVIEWER_SECRET: randomBytes(32).toString('hex'), BROKER_REVIEWER_TOKEN_VERSION: '1' });
const credentials = { mobile: '9999900016', password };

function fixture() {
  let time = Date.parse('2026-11-09T12:00:00Z');
  let realCalls = 0;
  const env = settings();
  const reviewer = createBrokerReviewerAccess({ env, now: () => time });
  const real = () => { realCalls++; throw new Error('Real database, broker, push or SMTP service must never be used for a sample principal'); };
  const service = Object.fromEntries(['login', 'getSession', 'portfolio', 'plot', 'logout', 'changePassword', 'requestPasswordReset', 'confirmPasswordReset'].map(key => [key, real]));
  const pass = (_req, _res, next) => next();
  const router = createBrokerMobileRouter(service, { reviewerAccess: reviewer, isEnabled: () => true,
    loginLimiter: pass, resetRequestLimiter: pass, resetConfirmLimiter: pass, passwordChangeLimiter: pass,
    pushDevices: { register: real, unregister: real },
  });
  const invoke = (method, url, { body = {}, token } = {}) => new Promise((resolve, reject) => {
    const req = { method, url, body, query: {}, ip: 'test-only', headers: token ? { authorization: `Bearer ${token}` } : {},
      get(name) { return this.headers[name.toLowerCase()]; } };
    const res = { statusCode: 200, headers: {}, set(key, value) { this.headers[key] = value; return this; }, vary() { return this; },
      status(code) { this.statusCode = code; return this; }, json(payload) { resolve({ status: this.statusCode, body: payload, headers: this.headers }); } };
    router.handle(req, res, error => reject(error || new Error('Unmatched route')));
  });
  return { env, reviewer, invoke, advance: milliseconds => { time += milliseconds; }, realCalls: () => realCalls };
}

test('sample sign-in and every readonly page use fictional DTOs without touching real services', async () => {
  const f = fixture();
  const login = await f.invoke('POST', '/auth/login', { body: credentials });
  assert.equal(login.status, 200);
  assert.match(login.body.user.name, /Sample data/);
  const token = login.body.token;
  const me = await f.invoke('GET', '/me', { token });
  assert.deepEqual(me.body.user, login.body.user);
  const portfolio = await f.invoke('GET', '/portfolio', { token });
  assert.equal(portfolio.status, 200);
  assert.equal(portfolio.headers['Cache-Control'], 'private, no-store');
  assert.equal(portfolio.body.clients.length, 2);
  for (const client of portfolio.body.clients) {
    assert.match(client.name, /^Sample Client /);
    assert.equal(client.phone, '');
    assert.match(client.email, /@example\.test$/);
    for (const plot of client.plots) {
      assert.match(plot.number, /^SAMPLE-/);
      assert.equal(plot.installmentRemindersEligible, false);
      assert.ok(!Object.hasOwn(plot, 'payments'));
      const detail = await f.invoke('GET', `/plots/${plot.id}`, { token });
      assert.equal(detail.status, 200);
      assert.equal(detail.body.sampleData, true);
      assert.ok(detail.body.plot.payments.length > 0);
      assert.ok(detail.body.plot.bookingProgress.milestones.length > 0);
    }
  }
  const serialized = JSON.stringify(portfolio.body);
  assert.ok(!/aadhaar|aadhar|pan_no|bank_account|kyc|password/i.test(serialized));
  for (const id of ['1', '999999', `pr_${'f'.repeat(32)}`, 'sample-client-1']) {
    assert.equal((await f.invoke('GET', `/plots/${id}`, { token })).status, 404);
  }
  for (const [method, path] of [['DELETE', '/account'], ['POST', '/admin/accounts'], ['GET', '/unknown']]) {
    assert.equal((await f.invoke(method, path, { token })).status, 404, path);
  }
  assert.equal(f.realCalls(), 0);
});

test('sample push, credential changes and recovery reject before real DB, Firebase or SMTP', async () => {
  const f = fixture();
  const token = (await f.invoke('POST', '/auth/login', { body: credentials })).body.token;
  for (const [method, path, body, auth] of [
    ['POST', '/device-tokens', { token: 'fictional-device-token', platform: 'android' }, token],
    ['DELETE', '/device-tokens', { token: 'fictional-device-token' }, token],
    ['POST', '/auth/password/change', { currentPassword: password, newPassword: 'another fictional password' }, token],
    ['POST', '/auth/password-reset/request', { mobile: credentials.mobile, aadhaar: 'not-real' }, undefined],
    ['POST', '/auth/password-reset/request', { mobile: '9876500001', aadhaar: 'not-real' }, token],
    ['POST', '/auth/password-reset/confirm', { challengeId: 'sample-reviewer:invalid' }, undefined],
    ['POST', '/auth/password-reset/confirm', { challengeId: 'other-unknown-challenge' }, token],
  ]) {
    const response = await f.invoke(method, path, { body, token: auth });
    assert.equal(response.status, 403, path);
    assert.match(response.body.message, /read-only/);
  }
  assert.equal(f.realCalls(), 0);
});

test('reserved phone cannot fall through on wrong credentials, disabled or incomplete config', async () => {
  const f = fixture();
  assert.equal((await f.invoke('POST', '/auth/login', { body: { ...credentials, password: 'incorrect credential' } })).status, 401);
  assert.equal((await f.invoke('POST', '/auth/login', { body: { ...credentials, role: 'admin' } })).status, 401);
  assert.equal((await f.invoke('POST', '/auth/login', { body: { identifier: '+91 99999 00016', password } })).status, 200);
  for (const [key, invalid] of [
    ['BROKER_REVIEWER_ENABLED', 'false'], ['BROKER_REVIEWER_PASSWORD_HASH', 'plaintext-is-not-a-hash'],
    ['BROKER_REVIEWER_SECRET', 'short'], ['BROKER_REVIEWER_TOKEN_VERSION', '-1'], ['BROKER_REVIEWER_PHONE', '9876500001'],
  ]) {
    const previous = f.env[key]; f.env[key] = invalid;
    assert.equal((await f.invoke('POST', '/auth/login', { body: credentials })).status, 401, key);
    f.env[key] = previous;
  }
  f.env.BROKER_REVIEWER_PHONE = '9876500001';
  assert.equal(f.reviewer.handlesLogin({ mobile: '9876500001' }), false, 'misconfigured phone never shadows a real identifier');
  f.env.BROKER_REVIEWER_PHONE = credentials.mobile;
  const missing = createBrokerReviewerAccess({ env: {} });
  assert.equal(missing.handlesLogin(credentials), true, 'the fixed sample identifier remains reserved without configuration');
  await assert.rejects(missing.login(credentials), { statusCode: 401 });
  const pending = f.invoke('POST', '/auth/login', { body: credentials });
  f.env.BROKER_REVIEWER_ENABLED = 'false';
  assert.equal((await pending).status, 401, 'disable while password comparison is in flight');
  assert.equal(f.realCalls(), 0);
});

test('invalid, expired, disabled, rotated and logged-out sample tokens deny without fallback', async () => {
  const f = fixture();
  const token = (await f.invoke('POST', '/auth/login', { body: credentials })).body.token;
  const claims = jwt.decode(token);
  const forged = jwt.sign({ ...claims }, 'unrelated-test-key');
  for (const bad of [forged, `${token.slice(0, -4)}AAAA`]) {
    assert.equal((await f.invoke('GET', '/portfolio', { token: bad })).status, 401);
    assert.equal((await f.invoke('POST', '/device-tokens', { token: bad })).status, 401);
  }
  const rotations = [
    ['BROKER_REVIEWER_ENABLED', 'false'], ['BROKER_REVIEWER_TOKEN_VERSION', '2'],
    ['BROKER_REVIEWER_PASSWORD_HASH', await bcrypt.hash('rotated fictional password', 10)],
    ['BROKER_REVIEWER_SECRET', randomBytes(32).toString('hex')],
    ['BROKER_REVIEWER_PHONE', '9876500001'],
  ];
  for (const [key, value] of rotations) {
    const changed = fixture();
    const old = (await changed.invoke('POST', '/auth/login', { body: credentials })).body.token;
    const previous = changed.env[key]; changed.env[key] = value;
    assert.equal((await changed.invoke('GET', '/portfolio', { token: old })).status, 401, key);
    changed.env[key] = previous;
    assert.equal((await changed.invoke('GET', '/portfolio', { token: old })).status, 401, `${key}: restoration cannot revive a revoked token`);
    const next = await changed.invoke('POST', '/auth/login', { body: credentials });
    assert.equal(next.status, 200, `${key}: a new sign-in is required after restoration`);
    assert.equal((await changed.invoke('GET', '/portfolio', { token: next.body.token })).status, 200);
    assert.equal(changed.realCalls(), 0);
  }
  const restarted = createBrokerReviewerAccess({ env: f.env });
  await assert.rejects(restarted.getSession(token), { statusCode: 401 });
  assert.equal((await f.invoke('POST', '/auth/logout', { token })).status, 200);
  assert.equal((await f.invoke('GET', '/portfolio', { token })).status, 401);
  const fresh = (await f.invoke('POST', '/auth/login', { body: credentials })).body.token;
  f.advance(31 * 86400000);
  assert.equal((await f.invoke('GET', '/portfolio', { token: fresh })).status, 401);
  assert.equal(f.realCalls(), 0);
});

test('sample token cannot authenticate directly with the real broker auth verifier', async t => {
  const previous = process.env.MOBILE_PORTAL_SECRET;
  process.env.MOBILE_PORTAL_SECRET = randomBytes(32).toString('hex');
  t.after(() => { if (previous === undefined) delete process.env.MOBILE_PORTAL_SECRET; else process.env.MOBILE_PORTAL_SECRET = previous; });
  const f = fixture();
  const token = (await f.reviewer.login(credentials)).token;
  let calls = 0;
  const auth = createBrokerMobileAuthService({ query: () => { calls++; throw new Error('No database access'); } });
  await assert.rejects(auth.getSession(token), { statusCode: 401 });
  assert.equal(calls, 0);
});

test('real broker requests still delegate to the real service with the original session', async () => {
  const calls = [];
  const session = { account: { id: 7 }, user: { name: 'Real-service fixture' } };
  const service = {
    login: async body => { calls.push(['login', body]); return { token: 'real.token.value' }; },
    getSession: async token => { calls.push(['session', token]); return session; },
    portfolio: async value => { assert.equal(value, session); calls.push(['portfolio']); return { clients: [] }; },
  };
  const router = createBrokerMobileRouter(service, { isEnabled: () => true,
    reviewerAccess: createBrokerReviewerAccess({ env: settings() }),
  });
  const invoke = (method, url, body, token) => new Promise((resolve, reject) => {
    const req = { method, url, body, query: {}, ip: 'test-only', headers: token ? { authorization: `Bearer ${token}` } : {}, get(key) { return this.headers[key.toLowerCase()]; } };
    const res = { set() { return this; }, vary() { return this; }, status() { return this; }, json: resolve };
    router.handle(req, res, error => reject(error || new Error('Unmatched route')));
  });
  await invoke('POST', '/auth/login', { mobile: '9876500001', password: 'fixture-only' });
  await invoke('GET', '/portfolio', {}, 'real.token.value');
  assert.deepEqual(calls.map(value => value[0]), ['login', 'session', 'portfolio']);
});
