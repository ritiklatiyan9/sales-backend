import { createPrivateKey } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseEnv } from 'dotenv';

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const defaultAndroidConfig = resolve(backendRoot, '../../MyRealAssets/mobile/android/app/google-services.json');
const androidPackage = 'app.myrealassets.my_real_assets';
const maxCredentialBytes = 64 * 1024;

function readBounded(path, maximum) {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > maximum) throw new Error('INVALID_FILE');
  return readFileSync(path, 'utf8');
}

/** Parse only the intended backend environment; invoking from another cwd is safe. */
export function loadEnvironment(path = resolve(backendRoot, '.env'), current = process.env, { optional = true } = {}) {
  let stored = {};
  try { stored = parseEnv(readBounded(path, 1024 * 1024)); }
  catch (error) { if (!optional || error.code !== 'ENOENT') throw new Error('ENV_FILE_UNAVAILABLE'); }
  return { ...stored, ...current };
}

function serviceAccountFor(env) {
  let raw;
  let source = 'missing';
  if (env.MRA_FCM_SERVICE_ACCOUNT_FILE) {
    source = 'file';
    const path = env.MRA_FCM_SERVICE_ACCOUNT_FILE;
    if (!isAbsolute(path) || path.includes('\0')) throw new Error('CREDENTIAL_FILE_INVALID');
    // Match the sender: a configured file never falls back to a different key.
    raw = readBounded(path, maxCredentialBytes);
  } else if (env.MRA_FCM_SERVICE_ACCOUNT_JSON) {
    source = 'environment-json';
    raw = env.MRA_FCM_SERVICE_ACCOUNT_JSON;
  } else if (env.MRA_FCM_SERVICE_ACCOUNT_B64) {
    source = 'environment-base64';
    const encoded = env.MRA_FCM_SERVICE_ACCOUNT_B64.replace(/\s/g, '');
    if (encoded.length > maxCredentialBytes * 2 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('CREDENTIAL_INVALID');
    raw = Buffer.from(encoded, 'base64').toString('utf8');
  }
  if (!raw) return { source, account: null };
  if (Buffer.byteLength(raw) > maxCredentialBytes) throw new Error('CREDENTIAL_INVALID');
  const account = JSON.parse(raw);
  if (account?.type !== 'service_account' || !/^[a-z0-9][a-z0-9-]+$/.test(account.project_id || '')
    || !/^[^\s@]+@[^\s@]+\.gserviceaccount\.com$/.test(account.client_email || '')
    || typeof account.private_key !== 'string' || createPrivateKey(account.private_key).asymmetricKeyType !== 'rsa') {
    throw new Error('CREDENTIAL_INVALID');
  }
  return { source, account };
}

function safeFirebaseCode(error) {
  const code = error?.code || error?.errorInfo?.code;
  return typeof code === 'string' && /^(?:messaging|app|auth)\/[a-z0-9-]+$/.test(code) ? code : 'FCM_VALIDATION_FAILED';
}

/** Firebase validation only: the second send argument is always true. */
export async function verifyFcmApi({ account, projectId, token }, firebase) {
  const api = firebase ?? {
    ...await import('firebase-admin/app'),
    ...await import('firebase-admin/messaging'),
  };
  const app = api.initializeApp({ credential: api.cert(account), projectId }, `mra-fcm-verification-${process.pid}`);
  try {
    await api.getMessaging(app).send({
      token,
      notification: { title: 'Installment reminder', body: 'An installment is coming due. Open the app to view your plan.' },
      data: { type: 'installment' },
      android: { priority: 'high', notification: { channelId: 'installment_reminders', sound: 'default' } },
      apns: { headers: { 'apns-push-type': 'alert', 'apns-priority': '10' }, payload: { aps: { sound: 'default' } } },
    }, true);
  } finally { await api.deleteApp(app); }
}

/** No database access, no credential/token output, and no delivery capability. */
export async function checkMobileFcm({
  env = process.env, androidConfig = defaultAndroidConfig, verifyApi = false, tokenFile,
} = {}, { verify = verifyFcmApi } = {}) {
  // Capture the chosen environment before loading the sender's shared policy:
  // its dependency tree includes legacy dotenv/config cwd loading.
  env = { ...env };
  const report = {
    ok: false,
    mode: verifyApi ? 'firebase-dry-run' : 'local-configuration',
    deliveryAttempted: false,
    enabled: env.MRA_FCM_ENABLED === 'true',
    android: null,
    credential: { configured: false, source: 'missing', valid: false },
    checks: [],
  };
  const check = (name, ok) => report.checks.push({ name, ok: Boolean(ok) });
  check('sender-enabled', report.enabled);
  let expectedProject;
  try {
    const config = JSON.parse(readBounded(androidConfig, 1024 * 1024));
    const { project_id: projectId, project_number: senderId } = config.project_info ?? {};
    const packages = (config.client ?? []).map(client => client?.client_info?.android_client_info?.package_name).filter(Boolean);
    expectedProject = projectId;
    report.android = { projectId, senderId, packages };
    check('android-project-configured', typeof projectId === 'string' && /^[a-z0-9][a-z0-9-]+$/.test(projectId)
      && /^\d+$/.test(String(senderId ?? '')) && packages.includes(androidPackage));
  } catch { check('android-project-configured', false); }
  let account;
  const source = env.MRA_FCM_SERVICE_ACCOUNT_FILE ? 'file' : env.MRA_FCM_SERVICE_ACCOUNT_JSON
    ? 'environment-json' : env.MRA_FCM_SERVICE_ACCOUNT_B64 ? 'environment-base64' : 'missing';
  report.credential = { configured: source !== 'missing', source, valid: false };
  try {
    const credential = serviceAccountFor(env);
    account = credential.account;
    report.credential = { configured: Boolean(account), source: credential.source, valid: Boolean(account),
      ...(account ? { projectId: account.project_id, clientEmail: account.client_email } : {}) };
    check('sender-credential-valid', account != null);
  } catch { check('sender-credential-valid', false); }
  let projectMatches = false;
  try {
    const { validateMobilePushProject } = await import('../src/services/mobilePush.service.js');
    projectMatches = expectedProject != null && validateMobilePushProject(account, env) === expectedProject;
  } catch { /* Fail closed. */ }
  check('sender-project-matches-app', projectMatches);
  report.ok = report.checks.every(item => item.ok);
  if (!verifyApi) return report;
  report.apiVerification = { status: 'skipped', deliveryAttempted: false };
  if (!report.ok) return report;
  let token;
  try {
    token = readBounded(tokenFile, 8192).trim();
    if (token.length < 20 || token.length > 4096 || !/^[A-Za-z0-9_:.\-]+$/.test(token)) throw new Error('INVALID_TOKEN');
  } catch {
    report.ok = false;
    report.apiVerification = { status: 'failed', code: 'TOKEN_FILE_INVALID', deliveryAttempted: false };
    return report;
  }
  try {
    await verify({ account, projectId: expectedProject, token });
    report.apiVerification = { status: 'passed', validationOnly: true, deliveryAttempted: false };
  } catch (error) {
    report.ok = false;
    report.apiVerification = { status: 'failed', code: safeFirebaseCode(error), deliveryAttempted: false };
  }
  return report;
}

export function parseArguments(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--verify-api' || arg === '--dry-run') options.verifyApi = true;
    else if (['--env-file', '--android-config', '--token-file'].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('A file option is missing its path.');
      options[{ '--env-file': 'envFile', '--android-config': 'androidConfig', '--token-file': 'tokenFile' }[arg]] = resolve(value);
    } else throw new Error('Unknown option. Use --help for supported options.');
  }
  if (!options.help && Boolean(options.verifyApi) !== Boolean(options.tokenFile)) {
    throw new Error('--verify-api and --token-file must be supplied together.');
  }
  return options;
}

const usage = `Usage: node scripts/check-mobile-fcm.mjs [--env-file FILE] [--android-config FILE]
       node scripts/check-mobile-fcm.mjs --verify-api --token-file FILE [--env-file FILE]

Default: local checks only, without contacting Firebase or the database.
--verify-api (alias --dry-run): validate the FCM request with Firebase without
delivering a notification. Supply a device token in a private file, never argv.
The backend .env is loaded regardless of cwd; existing environment values win.
Output contains public project metadata and pass/fail checks, never credentials
or device tokens. This tool cannot send real notifications.
`;

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) process.stdout.write(usage);
    else {
      const env = loadEnvironment(options.envFile, process.env, { optional: !options.envFile });
      const report = await checkMobileFcm({ ...options, env });
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.exitCode = report.ok ? 0 : 1;
    }
  } catch {
    process.stderr.write('FCM check could not read its configuration or options. Use --help; no notification was sent.\n');
    process.exitCode = 2;
  }
}
