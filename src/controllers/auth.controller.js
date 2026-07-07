import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { OAuth2Client } from 'google-auth-library';
import asyncHandler from '../utils/asyncHandler.js';
import {
  signAccessToken, signRefreshToken, verifyToken, comparePassword, hashRefreshToken,
} from '../config/jwt.js';
import { firebaseEnabled, verifyFirebaseIdToken } from '../config/firebaseAdmin.js';
import { mailerEnabled, sendLoginOtpEmail } from '../services/mailer.service.js';
import { isAdminRole } from '../services/agentNetwork.service.js';
import userModel from '../models/User.model.js';
import pool from '../config/db.js';

const googleClient = new OAuth2Client();

/** Mint the shared-shape token pair for an authenticated user (same as password login). */
const issueTokens = async (user) => {
  const version = user.token_version;
  const accessToken = signAccessToken({ id: user.id, email: user.email, role: user.role, version });
  const refreshToken = signRefreshToken({ id: user.id, version });
  await userModel.setRefreshToken(user.id, await hashRefreshToken(refreshToken));
  return { accessToken, refreshToken };
};

/* ── Email OTP second factor — admin-class roles only, never agents ── */
const OTP_TTL_MINUTES = 5;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_SECONDS = 30;

const maskEmail = (email) => {
  const [local, domain] = String(email).split('@');
  if (!domain) return email;
  const visible = local.slice(0, 2);
  return `${visible}${'•'.repeat(Math.max(2, local.length - 2))}@${domain}`;
};

/**
 * Second sign-in step: park the login as a pending challenge and email a 6-digit
 * code. No JWTs leave the server until /auth/verify-otp succeeds. One active
 * challenge per user (a fresh login supersedes the previous one).
 */
const startOtpChallenge = async (user, res) => {
  const otp = String(crypto.randomInt(100000, 1000000));
  const pendingToken = crypto.randomBytes(24).toString('hex');
  const otpHash = await bcrypt.hash(otp, 10);

  await pool.query('DELETE FROM login_otps WHERE user_id = $1', [user.id]);
  await pool.query(
    `INSERT INTO login_otps (user_id, pending_token, otp_hash, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval)`,
    [user.id, pendingToken, otpHash, OTP_TTL_MINUTES]
  );

  try {
    await sendLoginOtpEmail({ to: user.email, name: user.name, otp, minutes: OTP_TTL_MINUTES });
  } catch (err) {
    await pool.query('DELETE FROM login_otps WHERE pending_token = $1', [pendingToken]);
    console.error('[auth] OTP email failed:', err.message);
    return res.status(502).json({ message: 'Could not send the verification email. Try again or contact your admin.' });
  }

  res.json({
    otp_required: true,
    pending_token: pendingToken,
    email_hint: maskEmail(user.email),
    expires_in: OTP_TTL_MINUTES * 60,
    resend_after: OTP_RESEND_SECONDS,
  });
};

/** Admins verify with a second step whenever the mailer is configured. */
const needsOtp = (user) => isAdminRole(user.role) && mailerEnabled();

/**
 * POST /auth/login
 * Authenticates against the SHARED accounting `users` table and mints the same JWT
 * shape — so a token works on both the booking-api and the accounting backend.
 */
export const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const user = await userModel.findByEmail(email);
  if (!user || !(await comparePassword(password, user.password))) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }
  if (!user.is_active) {
    return res.status(403).json({ message: 'Account is deactivated. Contact your admin.' });
  }

  // Admin-class roles get a second step: a 6-digit code emailed to the account's
  // address. Agents sign in directly — the OTP wall is for admin power only.
  if (needsOtp(user)) return startOtpChallenge(user, res);

  const tokens = await issueTokens(user);
  res.json({ user: userModel.sanitize(user), ...tokens });
});

/**
 * POST /auth/verify-otp — body { pending_token, otp }. Completes an admin login.
 * The challenge is single-use, expires after ${OTP_TTL} minutes, and dies after
 * 5 wrong attempts — then the admin must sign in again from step one.
 */
export const verifyLoginOtp = asyncHandler(async (req, res) => {
  const { pending_token, otp } = req.body;
  if (!pending_token || !otp) {
    return res.status(400).json({ message: 'pending_token and otp are required' });
  }

  const { rows } = await pool.query(
    'SELECT * FROM login_otps WHERE pending_token = $1 LIMIT 1',
    [String(pending_token)]
  );
  const challenge = rows[0];
  if (!challenge || challenge.consumed_at) {
    return res.status(401).json({ message: 'This sign-in attempt is no longer valid. Please sign in again.' });
  }
  if (new Date(challenge.expires_at) < new Date()) {
    await pool.query('DELETE FROM login_otps WHERE id = $1', [challenge.id]);
    return res.status(401).json({ message: 'The code has expired. Please sign in again.' });
  }
  if (challenge.attempts >= OTP_MAX_ATTEMPTS) {
    await pool.query('DELETE FROM login_otps WHERE id = $1', [challenge.id]);
    return res.status(401).json({ message: 'Too many wrong attempts. Please sign in again.' });
  }

  const ok = await bcrypt.compare(String(otp).trim(), challenge.otp_hash);
  if (!ok) {
    const { rows: bumped } = await pool.query(
      'UPDATE login_otps SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts',
      [challenge.id]
    );
    const left = Math.max(0, OTP_MAX_ATTEMPTS - bumped[0].attempts);
    return res.status(401).json({
      message: left > 0 ? `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Too many wrong attempts. Please sign in again.',
    });
  }

  const user = await userModel.findById(challenge.user_id);
  if (!user || !user.is_active) {
    await pool.query('DELETE FROM login_otps WHERE id = $1', [challenge.id]);
    return res.status(403).json({ message: 'Account is deactivated. Contact your admin.' });
  }

  await pool.query('UPDATE login_otps SET consumed_at = now() WHERE id = $1', [challenge.id]);
  const tokens = await issueTokens(user);
  res.json({ user: userModel.sanitize(user), ...tokens });
});

/** POST /auth/resend-otp — body { pending_token }. Same challenge, fresh code (30s throttle). */
export const resendLoginOtp = asyncHandler(async (req, res) => {
  const { pending_token } = req.body;
  if (!pending_token) return res.status(400).json({ message: 'pending_token is required' });

  const { rows } = await pool.query(
    'SELECT * FROM login_otps WHERE pending_token = $1 LIMIT 1',
    [String(pending_token)]
  );
  const challenge = rows[0];
  if (!challenge || challenge.consumed_at || new Date(challenge.expires_at) < new Date()) {
    return res.status(401).json({ message: 'This sign-in attempt is no longer valid. Please sign in again.' });
  }
  const sinceLastSend = (Date.now() - new Date(challenge.last_sent_at).getTime()) / 1000;
  if (sinceLastSend < OTP_RESEND_SECONDS) {
    return res.status(429).json({ message: `Please wait ${Math.ceil(OTP_RESEND_SECONDS - sinceLastSend)}s before requesting a new code` });
  }

  const user = await userModel.findById(challenge.user_id);
  if (!user || !user.is_active) {
    return res.status(403).json({ message: 'Account is deactivated. Contact your admin.' });
  }

  const otp = String(crypto.randomInt(100000, 1000000));
  const otpHash = await bcrypt.hash(otp, 10);
  await pool.query(
    `UPDATE login_otps
        SET otp_hash = $1, attempts = 0, last_sent_at = now(),
            expires_at = now() + ($2 || ' minutes')::interval
      WHERE id = $3`,
    [otpHash, OTP_TTL_MINUTES, challenge.id]
  );
  try {
    await sendLoginOtpEmail({ to: user.email, name: user.name, otp, minutes: OTP_TTL_MINUTES });
  } catch (err) {
    console.error('[auth] OTP resend failed:', err.message);
    return res.status(502).json({ message: 'Could not send the verification email. Try again shortly.' });
  }
  res.json({ resent: true, email_hint: maskEmail(user.email), expires_in: OTP_TTL_MINUTES * 60 });
});

/**
 * POST /auth/google — Sign in with Google.
 * The frontend runs the Firebase Google popup and sends the Firebase ID token here;
 * it is verified with the Firebase Admin SDK (service account in secrets/). A plain
 * Google Identity Services token verified against GOOGLE_CLIENT_ID is also accepted
 * as a fallback deployment mode. Either way the user signs in ONLY when the Google
 * email already belongs to an account — created manually or by an admin. There is
 * deliberately NO self-signup path: an unknown Gmail is rejected, exactly as
 * required ("the gmail attached with his account").
 */
export const googleLogin = asyncHandler(async (req, res) => {
  const { credential } = req.body;
  if (!credential || typeof credential !== 'string') {
    return res.status(400).json({ message: 'Missing Google credential' });
  }
  if (!firebaseEnabled() && !process.env.GOOGLE_CLIENT_ID) {
    return res.status(503).json({ message: 'Google Sign-In is not configured on this server' });
  }

  let payload = null;
  if (firebaseEnabled()) {
    try {
      const decoded = await verifyFirebaseIdToken(credential);
      // Only trust tokens minted by an actual Google sign-in (not anonymous/phone).
      if (decoded.firebase?.sign_in_provider !== 'google.com') {
        return res.status(401).json({ message: 'Only Google sign-in is accepted here' });
      }
      payload = { email: decoded.email, email_verified: decoded.email_verified === true };
    } catch {
      payload = null; // fall through to the GIS path (different token format) if configured
    }
  }
  if (!payload && process.env.GOOGLE_CLIENT_ID) {
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken: credential,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      const p = ticket.getPayload();
      payload = { email: p?.email, email_verified: p?.email_verified === true };
    } catch {
      payload = null;
    }
  }
  if (!payload) {
    return res.status(401).json({ message: 'Invalid Google credential' });
  }
  if (!payload.email || payload.email_verified !== true) {
    return res.status(401).json({ message: 'Your Google account has no verified email' });
  }

  const user = await userModel.findByEmailInsensitive(payload.email);
  if (!user) {
    return res.status(403).json({
      message: `No account is linked to ${payload.email}. Ask your admin to create your account with this email, then try again.`,
    });
  }
  if (!user.is_active) {
    return res.status(403).json({ message: 'Account is deactivated. Contact your admin.' });
  }

  // Same second step as password login: admins confirm a code from their inbox.
  if (needsOtp(user)) return startOtpChallenge(user, res);

  const tokens = await issueTokens(user);
  res.json({ user: userModel.sanitize(user), ...tokens, via: 'google' });
});

/** POST /auth/refresh */
export const refresh = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken || typeof refreshToken !== 'string') {
    return res.status(401).json({ message: 'Invalid refresh token' });
  }

  let decoded;
  try {
    decoded = verifyToken(refreshToken, process.env.JWT_REFRESH_SECRET);
  } catch {
    return res.status(401).json({ message: 'Invalid refresh token' });
  }

  const user = await userModel.findById(decoded.id);
  if (!user || user.token_version !== decoded.version) {
    if (user) await userModel.bumpTokenVersion(user.id, user.token_version);
    return res.status(401).json({ message: 'Invalid refresh token' });
  }
  if (!user.refresh_token || !(await comparePassword(refreshToken, user.refresh_token))) {
    await userModel.bumpTokenVersion(user.id, user.token_version);
    return res.status(401).json({ message: 'Invalid refresh token' });
  }

  const version = user.token_version;
  const accessToken = signAccessToken({ id: user.id, email: user.email, role: user.role, version });
  const newRefreshToken = signRefreshToken({ id: user.id, version });
  await userModel.setRefreshToken(user.id, await hashRefreshToken(newRefreshToken));

  res.json({ accessToken, refreshToken: newRefreshToken });
});

/** GET /auth/me — current user + accessible sites (read-only from shared tables). */
export const getMe = asyncHandler(async (req, res) => {
  const user = await userModel.findById(req.user.id);
  if (!user) return res.status(404).json({ message: 'User not found' });

  // Include address/city/state so the print forms can source full site details from
  // context (currentSite) instead of hardcoding a company/site name.
  let sites;
  if (user.role === 'admin' || user.role === 'super_admin') {
    const { rows } = await pool.query('SELECT id, name, code, address, city, state FROM sites ORDER BY name');
    sites = rows;
  } else {
    const { rows } = await pool.query(
      `SELECT s.id, s.name, s.code, s.address, s.city, s.state FROM sites s
       JOIN user_sites us ON us.site_id = s.id
       WHERE us.user_id = $1 ORDER BY s.name`,
      [user.id]
    );
    sites = rows;
  }

  res.json({ user: userModel.sanitize(user), sites });
});
