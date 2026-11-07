import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkMobileFcm, loadEnvironment, parseArguments, verifyFcmApi } from './check-mobile-fcm.mjs';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const account = {
  type: 'service_account', project_id: 'myrealassets-380f8',
  client_email: 'synthetic@myrealassets-380f8.iam.gserviceaccount.com', private_key: privateKey,
};
const env = { MRA_FCM_ENABLED: 'true', MRA_FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(account) };
const token = 'synthetic_device_token_do_not_print_123456';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'mra-fcm-check-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const androidConfig = join(directory, 'google-services.json');
  writeFileSync(androidConfig, JSON.stringify({
    project_info: { project_id: 'myrealassets-380f8', project_number: '352636590441' },
    client: [{ client_info: { android_client_info: { package_name: 'app.myrealassets.my_real_assets' } } }],
  }));
  const tokenFile = join(directory, 'token.txt');
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  return { directory, androidConfig, tokenFile };
}

test('local verification cannot contact Firebase and only returns safe project metadata', async t => {
  const { androidConfig } = fixture(t);
  let calls = 0;
  const report = await checkMobileFcm({ env, androidConfig }, { verify: async () => { calls++; } });
  assert.equal(report.ok, true);
  assert.equal(report.mode, 'local-configuration');
  assert.equal(report.deliveryAttempted, false);
  assert.equal(report.credential.projectId, account.project_id);
  assert.equal(calls, 0);
  assert.ok(!JSON.stringify(report).includes('PRIVATE KEY'));
  assert.ok(!JSON.stringify(report).includes(token));
});

test('disabled, missing and wrong-project configurations fail closed before any API request', async t => {
  const { androidConfig, tokenFile } = fixture(t);
  for (const candidate of [
    {},
    { ...env, MRA_FCM_ENABLED: 'false' },
    { ...env, MRA_FCM_PROJECT_ID: 'different-project' },
    { ...env, MRA_FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({ ...account, project_id: 'different-project' }) },
  ]) {
    let calls = 0;
    const report = await checkMobileFcm({ env: candidate, androidConfig, verifyApi: true, tokenFile }, { verify: async () => { calls++; } });
    assert.equal(report.ok, false);
    assert.equal(report.apiVerification.status, 'skipped');
    assert.equal(calls, 0);
  }
});

test('an invalid configured key file cannot fall back to another credential or expose parsing errors', async t => {
  const { directory, androidConfig } = fixture(t);
  const broken = join(directory, 'broken.json');
  writeFileSync(broken, '{"private_key":"SENSITIVE_BAD_KEY"');
  for (const path of ['relative.json', broken]) {
    const report = await checkMobileFcm({ env: { ...env, MRA_FCM_SERVICE_ACCOUNT_FILE: path }, androidConfig });
    assert.equal(report.ok, false);
    assert.deepEqual(report.credential, { configured: true, source: 'file', valid: false });
    assert.ok(!JSON.stringify(report).includes('SENSITIVE_BAD_KEY'));
  }
});

test('Firebase dry-run always passes validationOnly=true and disposes the isolated Firebase app', async () => {
  const app = {};
  let deleted = false;
  const sent = [];
  await verifyFcmApi({ account, projectId: account.project_id, token }, {
    cert: credential => { assert.equal(credential, account); return 'synthetic-credential'; },
    initializeApp: options => { assert.equal(options.projectId, account.project_id); return app; },
    getMessaging: selected => { assert.equal(selected, app); return { send: async (...args) => sent.push(args) }; },
    deleteApp: async selected => { assert.equal(selected, app); deleted = true; },
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0][1], true);
  assert.equal(sent[0][0].android.notification.channelId, 'installment_reminders');
  assert.equal(sent[0][0].token, token);
  assert.equal(deleted, true);
});

test('dry-run error reports exclude credential/token-bearing Firebase error messages', async t => {
  const { androidConfig, tokenFile } = fixture(t);
  const report = await checkMobileFcm({ env, androidConfig, verifyApi: true, tokenFile }, {
    verify: async () => { throw Object.assign(new Error(`secret ${privateKey} ${token}`), { code: 'messaging/mismatched-credential' }); },
  });
  assert.equal(report.ok, false);
  assert.deepEqual(report.apiVerification, { status: 'failed', code: 'messaging/mismatched-credential', deliveryAttempted: false });
  assert.ok(!JSON.stringify(report).includes('PRIVATE KEY'));
  assert.ok(!JSON.stringify(report).includes(token));
});

test('CLI loads the selected environment independently of cwd and does not send by default', t => {
  const { directory, androidConfig } = fixture(t);
  const envFile = join(directory, 'checker.env');
  writeFileSync(envFile, `MRA_FCM_ENABLED=true\nMRA_FCM_SERVICE_ACCOUNT_JSON='${JSON.stringify(account)}'\n`, { mode: 0o600 });
  writeFileSync(join(directory, '.env'), 'MRA_FCM_ENABLED=false\nMRA_FCM_PROJECT_ID=unrelated-cwd-project\n');
  assert.equal(loadEnvironment(envFile, {}).MRA_FCM_ENABLED, 'true');
  assert.equal(loadEnvironment(envFile, { MRA_FCM_ENABLED: 'false' }).MRA_FCM_ENABLED, 'false');
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./check-mobile-fcm.mjs', import.meta.url)),
    '--env-file', envFile, '--android-config', androidConfig], { cwd: directory, env: {}, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.deliveryAttempted, false);
  assert.ok(!result.stdout.includes('PRIVATE KEY'));
  assert.deepEqual(parseArguments([]), {});
  assert.throws(() => parseArguments(['--verify-api']));
  assert.throws(() => parseArguments(['--token-file', 'private.txt']));
  assert.throws(() => parseArguments(['--send']));
});
