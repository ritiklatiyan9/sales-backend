import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { createBrokerReviewerAccess } from './brokerReviewer.service.js';
import { createBrokerMobileAuthService } from './brokerMobileAuth.service.js';
import { createBrokerMobileRouter } from '../routes/brokerMobile.routes.js';

const password = 'fictional test credential';
const recoveryIdentity = '222222222222';
const recoveryCode = '112233';
const [passwordHash, recoveryIdHash, recoveryCodeHash] = await Promise.all([
  bcrypt.hash(password, 10), bcrypt.hash(recoveryIdentity, 10), bcrypt.hash(recoveryCode, 10),
]);
const settings = () => ({ BROKER_REVIEWER_ENABLED: 'true', BROKER_REVIEWER_PHONE: '9999900016',
  BROKER_REVIEWER_PASSWORD_HASH: passwordHash, BROKER_REVIEWER_SECRET: randomBytes(32).toString('hex'), BROKER_REVIEWER_TOKEN_VERSION: '1',
  BROKER_REVIEWER_RECOVERY_ID_HASH: recoveryIdHash, BROKER_REVIEWER_RECOVERY_CODE_HASH: recoveryCodeHash,
  BROKER_REVIEWER_NOTIFICATIONS_ENABLED: 'true' });
const credentials = { mobile: '9999900016', password };

function fixture({ getNotificationSender, notificationTimeoutMs } = {}) {
  let time = Date.parse('2026-11-09T12:00:00Z');
  let realCalls = 0;
  const env = settings();
  const sent = [];
  const reviewer = createBrokerReviewerAccess({ env, now: () => time,
    getNotificationSender: getNotificationSender || (() => async message => { sent.push(message); return 'sample-message-id'; }), notificationTimeoutMs });
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
  return { env, reviewer, invoke, sent, advance: milliseconds => { time += milliseconds; }, realCalls: () => realCalls };
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
      assert.equal(plot.installmentRemindersEligible, plot.balanceAmount > 0);
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

test('sample device enrollment validates, stores/removes bounded memory state and sends only fictional supplied-token alerts', async () => {
  const f = fixture();
  const token = (await f.invoke('POST', '/auth/login', { body: credentials })).body.token;
  const device = index => `sample_device_token_0000_${index}`;
  for (let i = 0; i < 20; i++) {
    if (i > 0) f.advance(60001);
    assert.equal((await f.invoke('POST', '/device-tokens', { token, body: { token: device(i), platform: 'android' } })).status, 200);
  }
  assert.equal(f.sent.length, 20);
  assert.equal((await f.invoke('POST', '/device-tokens', { token, body: { token: device(0), platform: 'android' } })).status, 200, 'existing registration is updated');
  assert.equal(f.sent.length, 20, 'duplicate enrollment is idempotent');
  assert.equal((await f.invoke('POST', '/device-tokens', { token, body: { token: device(20), platform: 'android' } })).status, 429);
  assert.equal((await f.invoke('DELETE', '/device-tokens', { token, body: { token: device(0) } })).status, 200);
  f.advance(60001);
  assert.equal((await f.invoke('POST', '/device-tokens', { token, body: { token: device(20), platform: 'android' } })).status, 200, 'removal actually frees capacity');
  for (const [method, body] of [
    ['POST', { token: 'short', platform: 'android' }], ['POST', { token: device(1), platform: 'windows' }], ['POST', { token: device(1), platform: 'ios' }],
    ['POST', { token: device(1), platform: 'android', accountId: 1 }], ['POST', []],
    ['DELETE', { token: device(1), accountId: 1 }], ['DELETE', { token: 'x'.repeat(4097) }],
  ]) {
    assert.equal((await f.invoke(method, '/device-tokens', { body, token })).status, 400);
  }
  for (const message of f.sent) {
    assert.match(message.token, /^sample_device_token_0000_\d+$/);
    assert.equal(message.notification.title, 'Sample reminder');
    assert.match(message.notification.body, /fictional sample/);
    assert.deepEqual(message.data, { type: 'installment', sample: 'true' });
    assert.equal(message.android.restrictedPackageName, 'app.myrealassets.broker');
    assert.equal(message.android.notification.channelId, 'partner_installment_reminders');
    assert.equal(message.android.ttl, 300000);
    assert.ok(!/amount|client|sample-client|property|SAMPLE-17/i.test(JSON.stringify(message)));
  }
  assert.equal(f.realCalls(), 0);
});

test('sample notification transport is explicitly gated, rate-limited and fails before fake enrollment success', async () => {
  const f = fixture();
  const token = (await f.invoke('POST', '/auth/login', { body: credentials })).body.token;
  const enroll = (target, auth = token) => f.invoke('POST', '/device-tokens', { token: auth, body: { token: target, platform: 'android' } });
  assert.equal((await enroll('sample_notification_token_one')).status, 200);
  assert.equal((await enroll('sample_notification_token_two')).status, 429);
  assert.equal(f.sent.length, 1);
  const unavailable = fixture({ getNotificationSender: () => null });
  const unavailableToken = (await unavailable.invoke('POST', '/auth/login', { body: credentials })).body.token;
  assert.equal((await unavailable.invoke('POST', '/device-tokens', { token: unavailableToken, body: { token: 'sample_notification_token_one', platform: 'android' } })).status, 503);
  let attempts = 0;
  const failed = fixture({ getNotificationSender: () => async () => { attempts++; throw new Error('private transport failure'); } });
  const failedToken = (await failed.invoke('POST', '/auth/login', { body: credentials })).body.token;
  const failedRequest = () => failed.invoke('POST', '/device-tokens', { token: failedToken, body: { token: 'sample_notification_token_one', platform: 'android' } });
  assert.equal((await failedRequest()).status, 503);
  assert.equal((await failedRequest()).status, 429, 'failed attempts are also rate-limited');
  assert.equal(attempts, 1);
  const gated = fixture();
  gated.env.BROKER_REVIEWER_NOTIFICATIONS_ENABLED = 'false';
  const gatedToken = (await gated.invoke('POST', '/auth/login', { body: credentials })).body.token;
  assert.equal((await gated.invoke('POST', '/device-tokens', { token: gatedToken, body: { token: 'sample_notification_token_one', platform: 'android' } })).status, 503);
  assert.equal(gated.sent.length, 0);
  assert.equal(f.realCalls() + unavailable.realCalls() + failed.realCalls() + gated.realCalls(), 0);
});

test('sample enrollment rechecks revocation after asynchronous sender resolution and dispatch', async () => {
  let releaseProvider, providerStarted;
  const providerReady = new Promise(resolve => { providerStarted = resolve; });
  let sent = 0;
  const f = fixture({ getNotificationSender: () => { providerStarted(); return new Promise(resolve => { releaseProvider = resolve; }); } });
  const token = (await f.invoke('POST', '/auth/login', { body: credentials })).body.token;
  const pending = f.invoke('POST', '/device-tokens', { token, body: { token: 'sample_notification_token_one', platform: 'android' } });
  await providerReady;
  f.env.BROKER_REVIEWER_ENABLED = 'false'; f.reviewer.handlesToken(token);
  releaseProvider(async () => { sent++; });
  assert.equal((await pending).status, 401);
  assert.equal(sent, 0, 'revocation before sender is ready prevents dispatch');
  let releaseSend, sendStarted;
  const sendReady = new Promise(resolve => { sendStarted = resolve; });
  const g = fixture({ getNotificationSender: () => () => { sent++; sendStarted(); return new Promise(resolve => { releaseSend = resolve; }); } });
  const otherToken = (await g.invoke('POST', '/auth/login', { body: credentials })).body.token;
  const dispatched = g.invoke('POST', '/device-tokens', { token: otherToken, body: { token: 'sample_notification_token_two', platform: 'android' } });
  await sendReady;
  g.env.BROKER_REVIEWER_ENABLED = 'false'; g.reviewer.handlesToken(otherToken);
  releaseSend('sample-message-id');
  assert.equal((await dispatched).status, 401);
  assert.equal(sent, 1, 'already dispatched generic sample alert cannot be unsent');
  assert.equal(f.realCalls() + g.realCalls(), 0);
});

test('bounded transport waits stay outside the mutation queue so sample recovery remains usable', async () => {
  for (const getNotificationSender of [() => new Promise(() => {}), () => () => new Promise(() => {})]) {
    const timeout = fixture({ getNotificationSender, notificationTimeoutMs: 10 });
    const token = (await timeout.invoke('POST', '/auth/login', { body: credentials })).body.token;
    assert.equal((await timeout.invoke('POST', '/device-tokens', { token, body: { token: 'sample_notification_token_timeout', platform: 'android' } })).status, 503);
    assert.equal((await timeout.invoke('POST', '/auth/password-reset/request', { body: { mobile: credentials.mobile, aadhaar: recoveryIdentity } })).status, 200);
    assert.equal(timeout.realCalls(), 0);
  }
  let releaseSend, sendStarted;
  const started = new Promise(resolve => { sendStarted = resolve; });
  const f = fixture({ getNotificationSender: () => () => { sendStarted(); return new Promise(resolve => { releaseSend = resolve; }); } });
  const token = (await f.invoke('POST', '/auth/login', { body: credentials })).body.token;
  const pending = f.invoke('POST', '/device-tokens', { token, body: { token: 'sample_notification_token_hanging', platform: 'android' } });
  await started;
  let timer;
  try {
    const recovered = await Promise.race([
      (async () => {
        const challenge = await f.invoke('POST', '/auth/password-reset/request', { body: { mobile: credentials.mobile, aadhaar: recoveryIdentity } });
        assert.equal(challenge.status, 200);
        return f.invoke('POST', '/auth/password-reset/confirm', { body: { challengeId: challenge.body.challengeId, code: recoveryCode, newPassword: password } });
      })(),
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Recovery was blocked behind transport')), 2000); }),
    ]);
    assert.equal(recovered.status, 200, 'recovery completes while send is still pending');
  } finally { clearTimeout(timer); releaseSend('sample-message-id'); }
  assert.equal((await pending).status, 401, 'recovery revocation prevents stale registration storage');
  assert.equal(f.realCalls(), 0);
});

test('unregister cancels pending enrollment and a late timed-out send cannot create registration state', async () => {
  let releaseProvider, providerStarted;
  const started = new Promise(resolve => { providerStarted = resolve; });
  let sent = 0;
  const f = fixture({ getNotificationSender: () => { providerStarted(); return new Promise(resolve => { releaseProvider = resolve; }); } });
  const token = (await f.invoke('POST', '/auth/login', { body: credentials })).body.token;
  const target = 'sample_notification_token_cancelled';
  const pending = f.invoke('POST', '/device-tokens', { token, body: { token: target, platform: 'android' } });
  await started;
  assert.equal((await f.invoke('DELETE', '/device-tokens', { token, body: { token: target } })).status, 200);
  releaseProvider(async () => { sent++; });
  assert.equal((await pending).status, 400);
  assert.equal(sent, 0);
  let finishLate, dispatches = 0;
  const g = fixture({ notificationTimeoutMs: 10, getNotificationSender: () => () => {
    dispatches++;
    return dispatches === 1 ? new Promise(resolve => { finishLate = resolve; }) : Promise.resolve('sample-message-id');
  } });
  const otherToken = (await g.invoke('POST', '/auth/login', { body: credentials })).body.token;
  const enroll = () => g.invoke('POST', '/device-tokens', { token: otherToken, body: { token: target, platform: 'android' } });
  assert.equal((await enroll()).status, 503);
  finishLate('late-sample-message-id');
  g.advance(60001);
  assert.equal((await enroll()).status, 200);
  assert.equal(dispatches, 2, 'a timed-out late success never stored an idempotent registration');
  assert.equal(f.realCalls() + g.realCalls(), 0);
});

test('sandbox password changes actually replace credentials and reusable recovery restores the supplied password', async () => {
  const f = fixture();
  const originalHash = f.env.BROKER_REVIEWER_PASSWORD_HASH;
  const token = (await f.invoke('POST', '/auth/login', { body: credentials })).body.token;
  const replacement = 'new fictional sandbox password';
  assert.equal((await f.invoke('POST', '/auth/password/change', { token, body: { currentPassword: 'wrong password', newPassword: replacement } })).status, 400);
  assert.equal((await f.invoke('POST', '/auth/password/change', { token, body: { currentPassword: password, newPassword: recoveryIdentity } })).status, 400);
  assert.deepEqual((await f.invoke('POST', '/auth/password/change', { token, body: { currentPassword: password, newPassword: replacement } })).body, { success: true });
  assert.equal((await f.invoke('GET', '/portfolio', { token })).status, 401);
  assert.equal((await f.invoke('POST', '/auth/login', { body: credentials })).status, 401, 'old password is not silently retained');
  const changed = await f.invoke('POST', '/auth/login', { body: { ...credentials, password: replacement } });
  assert.equal(changed.status, 200);
  const request = await f.invoke('POST', '/auth/password-reset/request', { body: { mobile: credentials.mobile, aadhaar: recoveryIdentity } });
  assert.equal(request.status, 200);
  assert.equal(request.body.expiresInSeconds, 300);
  assert.match(request.body.message, /No email is sent/);
  const reset = { challengeId: request.body.challengeId, code: recoveryCode, newPassword: password };
  assert.deepEqual((await f.invoke('POST', '/auth/password-reset/confirm', { body: reset })).body, { success: true });
  assert.equal((await f.invoke('GET', '/portfolio', { token: changed.body.token })).status, 401);
  assert.equal((await f.invoke('POST', '/auth/password-reset/confirm', { body: reset })).status, 400, 'challenge is single use');
  assert.equal((await f.invoke('POST', '/auth/login', { body: { ...credentials, password: replacement } })).status, 401);
  assert.equal((await f.invoke('POST', '/auth/login', { body: credentials })).status, 200);
  assert.equal(f.env.BROKER_REVIEWER_PASSWORD_HASH, originalHash, 'initial environment hash is unchanged');
  const restarted = createBrokerReviewerAccess({ env: f.env });
  assert.ok((await restarted.login(credentials)).token, 'restart restores original supplied credential');
  assert.equal(f.realCalls(), 0);
});

test('sample recovery bounds attempts, expiry, resend and concurrent consumption without SMTP', async () => {
  const f = fixture();
  const request = () => f.invoke('POST', '/auth/password-reset/request', { body: { mobile: credentials.mobile, aadhaar: recoveryIdentity } });
  const first = await request();
  assert.equal((await request()).status, 429);
  const confirm = (challengeId, code = recoveryCode) => f.invoke('POST', '/auth/password-reset/confirm', { body: { challengeId, code, newPassword: password } });
  for (let i = 0; i < 5; i++) assert.equal((await confirm(first.body.challengeId, '000000')).status, 400);
  assert.equal((await confirm(first.body.challengeId)).status, 400, 'five guesses exhaust the challenge');
  f.advance(60001);
  const expired = await request();
  f.advance(300001);
  assert.equal((await confirm(expired.body.challengeId)).status, 400);
  const fresh = await request();
  const results = await Promise.all([confirm(fresh.body.challengeId), confirm(fresh.body.challengeId)]);
  assert.deepEqual(results.map(value => value.status).sort(), [200, 400]);
  const token = (await f.invoke('POST', '/auth/login', { body: credentials })).body.token;
  for (const [path, body, auth] of [
    ['/auth/password-reset/request', { mobile: credentials.mobile, aadhaar: 'not-real' }, undefined],
    ['/auth/password-reset/request', { mobile: '9876500001', aadhaar: recoveryIdentity }, token],
    ['/auth/password-reset/confirm', { challengeId: 'sample-reviewer:invalid', code: recoveryCode, newPassword: password }, undefined],
    ['/auth/password-reset/confirm', { challengeId: 'other-unknown-challenge', code: recoveryCode, newPassword: password }, token],
  ]) assert.equal((await f.invoke('POST', path, { body, token: auth })).status, 400);
  assert.equal(f.realCalls(), 0);
});

test('config changes revoke recovery challenges and concurrent password writes cannot retain stale credentials', async () => {
  const f = fixture();
  const request = await f.invoke('POST', '/auth/password-reset/request', { body: { mobile: credentials.mobile, aadhaar: recoveryIdentity } });
  f.env.BROKER_REVIEWER_ENABLED = 'false';
  f.reviewer.handlesToken('invalid.token');
  f.env.BROKER_REVIEWER_ENABLED = 'true';
  assert.equal((await f.invoke('POST', '/auth/password-reset/confirm', { body: { challengeId: request.body.challengeId, code: recoveryCode, newPassword: password } })).status, 400);
  const token = (await f.invoke('POST', '/auth/login', { body: credentials })).body.token;
  const writes = ['first fictional replacement', 'second fictional replacement'].map(newPassword => f.invoke('POST', '/auth/password/change', { token, body: { currentPassword: password, newPassword } }));
  assert.deepEqual((await Promise.all(writes)).map(value => value.status), [200, 401]);
  assert.equal((await f.invoke('POST', '/auth/login', { body: { ...credentials, password: 'first fictional replacement' } })).status, 200);
  assert.equal((await f.invoke('POST', '/auth/login', { body: { ...credentials, password: 'second fictional replacement' } })).status, 401);
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
    ['BROKER_REVIEWER_RECOVERY_ID_HASH', 'invalid'], ['BROKER_REVIEWER_RECOVERY_CODE_HASH', 'invalid'],
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
    ['BROKER_REVIEWER_RECOVERY_ID_HASH', await bcrypt.hash('333333333333', 10)],
    ['BROKER_REVIEWER_RECOVERY_CODE_HASH', await bcrypt.hash('334455', 10)],
    ['BROKER_REVIEWER_NOTIFICATIONS_ENABLED', 'false'],
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
