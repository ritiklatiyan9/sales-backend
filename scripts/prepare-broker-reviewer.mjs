import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcrypt';

// Creates local, git-ignored deployment material. Never prints credentials and
// never calls the API, database, Firebase or mailer. Existing files are final.
const directory = path.resolve('secrets');
const envPath = path.join(directory, 'broker-reviewer.env');
const credentialsPath = path.join(directory, 'broker-reviewer-credentials.json');
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
  'BROKER_REVIEWER_TOKEN_VERSION=1', '',
].join('\n'), { mode: 0o600, flag: 'wx' });
await writeFile(credentialsPath, JSON.stringify({
  mobile: phone, password,
  scope: 'Sample data only; no real broker, client, booking or financial records.',
  instructions: 'Use the normal My Real Partners sign-in. All displayed clients, properties, payments and timelines are fictional. Remote notifications and password changes are disabled for this read-only sample account.',
}, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log('Saved ignored deployment settings to secrets/broker-reviewer.env and Play reviewer credentials to secrets/broker-reviewer-credentials.json. No credentials were printed.');
