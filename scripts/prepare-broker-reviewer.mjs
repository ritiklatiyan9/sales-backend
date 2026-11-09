import { randomBytes, randomInt } from 'node:crypto';
import { mkdir, writeFile, access, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcrypt';

// Creates local, git-ignored deployment material. Never prints credentials and
// never calls the API, database, Firebase or mailer. --add-recovery preserves
// existing sign-in credentials and only adds the two new recovery settings.
const directory = path.resolve('secrets');
const envPath = path.join(directory, 'broker-reviewer.env');
const credentialsPath = path.join(directory, 'broker-reviewer-credentials.json');
const addRecovery = process.argv[2] === '--add-recovery';
if (process.argv.length > 2 && !addRecovery) throw new Error('Supported option: --add-recovery');
// The app requires a 12-digit value starting 2–9. A repeated-digit fictional
// verification number is generated only for this sandbox, never a real ID.
const recoveryIdentity = String(randomInt(2, 10)).repeat(12);
const recoveryCode = String(randomInt(0, 1000000)).padStart(6, '0');
const recoveryIdHash = await bcrypt.hash(recoveryIdentity, 12);
const recoveryCodeHash = await bcrypt.hash(recoveryCode, 12);
const instructions = `Sample sandbox: all records are fictional. To restore the supplied password, tap Forgot password, enter 9999900016 and sample verification number ${recoveryIdentity}, then reusable code ${recoveryCode} (no email); choose the supplied password. Password changes affect only this sandbox; server restart restores the supplied password. Enable notifications to test a sample alert and local reminders. No real office events occur.`;
if (instructions.length > 500) throw new Error('Reviewer instructions exceed 500 characters');
const recoveryEnv = [`BROKER_REVIEWER_RECOVERY_ID_HASH=${recoveryIdHash}`, `BROKER_REVIEWER_RECOVERY_CODE_HASH=${recoveryCodeHash}`];
if (addRecovery) {
  const existingEnv = await readFile(envPath, 'utf8');
  const existing = Object.fromEntries(existingEnv.trim().split('\n').filter(line => line.includes('=')).map(line => {
    const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];
  }));
  const credentials = JSON.parse(await readFile(credentialsPath, 'utf8'));
  if (existing.BROKER_REVIEWER_RECOVERY_ID_HASH || existing.BROKER_REVIEWER_RECOVERY_CODE_HASH || credentials.recoveryIdentity || credentials.recoveryCode) {
    throw new Error('Recovery settings already exist; refusing to rotate them.');
  }
  if (existing.BROKER_REVIEWER_PHONE !== '9999900016' || credentials.mobile !== '9999900016'
    || !await bcrypt.compare(credentials.password, existing.BROKER_REVIEWER_PASSWORD_HASH)) throw new Error('Existing reviewer files do not match; refusing to change them.');
  const nextEnv = existingEnv.trimEnd() + '\n' + recoveryEnv.join('\n') + '\n'
    + (existing.BROKER_REVIEWER_NOTIFICATIONS_ENABLED === undefined ? 'BROKER_REVIEWER_NOTIFICATIONS_ENABLED=false\n' : '');
  const nextCredentials = JSON.stringify({ ...credentials, recoveryIdentity, recoveryCode, instructions }, null, 2) + '\n';
  const suffix = `.${randomBytes(8).toString('hex')}.tmp`;
  const tempEnv = envPath + suffix, tempCredentials = credentialsPath + suffix;
  try {
    await writeFile(tempEnv, nextEnv, { mode: 0o600, flag: 'wx' });
    await writeFile(tempCredentials, nextCredentials, { mode: 0o600, flag: 'wx' });
    await rename(tempEnv, envPath);
    await rename(tempCredentials, credentialsPath);
  } finally {
    await unlink(tempEnv).catch(() => {}); await unlink(tempCredentials).catch(() => {});
  }
  console.log('Added private sample recovery settings. Existing reviewer password hash and signing secret were preserved. No credentials were printed.');
  process.exit(0);
}
for (const file of [envPath, credentialsPath]) {
  try { await access(file); throw new Error(`Refusing to overwrite existing ${path.basename(file)}. Rotate reviewer access deliberately.`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
await mkdir(directory, { recursive: true, mode: 0o700 });
const phone = '9999900016';
const password = randomBytes(24).toString('base64url');
const passwordHash = await bcrypt.hash(password, 12);
const secret = randomBytes(32).toString('hex');
await writeFile(envPath, [
  'BROKER_REVIEWER_ENABLED=true', `BROKER_REVIEWER_PHONE=${phone}`,
  `BROKER_REVIEWER_PASSWORD_HASH=${passwordHash}`, `BROKER_REVIEWER_SECRET=${secret}`,
  'BROKER_REVIEWER_TOKEN_VERSION=1', ...recoveryEnv, 'BROKER_REVIEWER_NOTIFICATIONS_ENABLED=false', '',
].join('\n'), { mode: 0o600, flag: 'wx' });
await writeFile(credentialsPath, JSON.stringify({
  mobile: phone, password, recoveryIdentity, recoveryCode,
  scope: 'Sample data only; no real broker, client, booking or financial records.',
  instructions,
}, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log('Saved ignored deployment settings to secrets/broker-reviewer.env and Play reviewer credentials to secrets/broker-reviewer-credentials.json. No credentials were printed.');
