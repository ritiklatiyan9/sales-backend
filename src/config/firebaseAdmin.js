import fs from 'fs';
import path from 'path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

/**
 * Firebase Admin — verifies Google Sign-In ID tokens minted by the booking-ui's
 * Firebase popup (project `defencegardenbooking`).
 *
 * The service-account key lives OUTSIDE version control at
 * `secrets/firebase-service-account.json` (override with FIREBASE_SERVICE_ACCOUNT).
 * When the file is absent the app still boots — /auth/google then falls back to
 * plain Google client-id verification (GOOGLE_CLIENT_ID) or reports 503.
 */
const keyPath = path.resolve(
  process.cwd(),
  process.env.FIREBASE_SERVICE_ACCOUNT || 'secrets/firebase-service-account.json'
);

let app = null;
if (fs.existsSync(keyPath)) {
  try {
    const serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    app = initializeApp({ credential: cert(serviceAccount) }, 'booking-google-auth');
    console.log(`[booking-api] Firebase Admin ready (project ${serviceAccount.project_id})`);
  } catch (err) {
    console.error('[booking-api] Firebase Admin init failed:', err.message);
  }
}

export const firebaseEnabled = () => !!app;

/** Verify a Firebase ID token → decoded payload (throws on invalid/expired). */
export const verifyFirebaseIdToken = (idToken) => getAuth(app).verifyIdToken(idToken);
