import fs from 'fs';
import path from 'path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

/**
 * Firebase Admin — verifies Google Sign-In ID tokens minted by the booking-ui's
 * Firebase popup (project `defencegardenbooking`).
 *
 * The key is loaded from the FIRST source that exists:
 *   1. FIREBASE_SERVICE_ACCOUNT_B64 env var — the key JSON, base64-encoded.
 *   2. FIREBASE_SERVICE_ACCOUNT_JSON env var — the raw key JSON.
 *   3. A key file: $FIREBASE_SERVICE_ACCOUNT, secrets/firebase-service-account.json
 *      (local dev), /etc/secrets/... or repo root (Render secret-file mounts).
 * When nothing is found the app still boots — /auth/google then reports 503.
 */
let app = null;
let keySource = null;
let initError = null;

const readKeyJson = () => {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_B64) {
    keySource = 'env:FIREBASE_SERVICE_ACCOUNT_B64';
    return Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8');
  }
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    keySource = 'env:FIREBASE_SERVICE_ACCOUNT_JSON';
    return process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  }

  const candidates = [
    process.env.FIREBASE_SERVICE_ACCOUNT,
    'secrets/firebase-service-account.json',
    '/etc/secrets/firebase-service-account.json',
    'firebase-service-account.json',
  ].filter(Boolean).map((p) => path.resolve(process.cwd(), p));

  const keyPath = candidates.find((p) => fs.existsSync(p));
  if (keyPath) {
    keySource = `file:${keyPath}`;
    return fs.readFileSync(keyPath, 'utf8');
  }

  console.warn('[booking-api] Firebase key not found. Tried files:', candidates.join(', '));
  return null;
};

try {
  const raw = readKeyJson();
  if (raw) {
    const serviceAccount = JSON.parse(raw);
    app = initializeApp({ credential: cert(serviceAccount) }, 'booking-google-auth');
    console.log(`[booking-api] Firebase Admin ready (project ${serviceAccount.project_id}, source ${keySource})`);
  }
} catch (err) {
  console.error(`[booking-api] Firebase Admin init failed (source ${keySource}):`, err.message);
  initError = err.message;
  app = null;
}

export const firebaseEnabled = () => !!app;

export const firebaseStatus = () => ({
  configured: !!app,
  source: app ? keySource?.split(':')[0] : null,
  env_b64_present: !!process.env.FIREBASE_SERVICE_ACCOUNT_B64,
  env_b64_length: (process.env.FIREBASE_SERVICE_ACCOUNT_B64 || '').length,
  init_error: initError,
});

/** Verify a Firebase ID token → decoded payload (throws on invalid/expired). */
export const verifyFirebaseIdToken = (idToken) => getAuth(app).verifyIdToken(idToken);
