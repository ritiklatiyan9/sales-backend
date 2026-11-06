import pool from '../config/db.js';
import { verifyToken } from '../config/jwt.js';
import { canUseBooking, canSignInToBooking, isBookingToken } from './bookingAppAccess.js';

const invalidSession = () => Object.assign(new Error('Invalid session'), { code: 'INVALID_SESSION', status: 401 });
const bookingAccessDenied = () => Object.assign(new Error('This ID is not allowed to access Booking. Open Booking\'s Account instead.'), { code: 'BOOKING_ACCESS_DENIED', status: 403 });

// The caller's booking_* grants ride along with the session row: a per-request snapshot
// that hasPermission reads instead of querying again. Never cached across requests, never
// put in the JWT, so revocation (token_version, Access Control edits) applies on the next request.
const sessionSql = grants => `SELECT u.id, u.email, u.role, u.token_version, u.is_active, u.can_login_booking,
    (to_jsonb(u)->>'can_login_accounts')::boolean AS can_login_accounts,
    (to_jsonb(u)->>'can_login_booking_accounts')::boolean AS can_login_booking_accounts${grants ? `,
    (SELECT jsonb_object_agg(p.module, jsonb_build_array(p.can_read, p.can_write, p.can_update, p.can_delete))
       FROM user_permissions p WHERE p.user_id = u.id AND p.module LIKE 'booking\\_%') AS grants` : ''}
  FROM users u WHERE u.id = $1 LIMIT 1`;

export async function currentStaffSession(token, db = pool, { allowAccountancyOnly = false, allowAccountsIntegration = false } = {}) {
  let decoded;
  try { decoded = verifyToken(token); } catch { throw invalidSession(); }
  const accountsIntegration = allowAccountsIntegration && decoded.app === 'accounts'
    && !decoded.realm && !decoded.aud && !decoded.client;
  if (!Number.isSafeInteger(decoded.id) || decoded.id <= 0 || !Number.isSafeInteger(decoded.version)
    || !Number.isFinite(decoded.exp) || (!isBookingToken(decoded) && !accountsIntegration)) throw invalidSession();
  // ponytail: 42P01 = an isolated schema without the shared user_permissions table (test fixtures);
  // the session still loads and hasPermission falls back to its own query.
  const { rows } = await db.query(sessionSql(true), [decoded.id])
    .catch(error => { if (error.code === '42P01') return db.query(sessionSql(false), [decoded.id]); throw error; });
  const user = rows[0];
  if (!user?.is_active || user.token_version !== decoded.version || user.role === 'client') throw invalidSession();
  if (accountsIntegration) {
    // Only the explicit client-invitation route opts in. Never accept an
    // Accounts session for Booking business, mobile staff or websocket APIs.
    if (user.role !== 'super_admin' || user.can_login_accounts !== true) throw invalidSession();
  } else {
    if (!canSignInToBooking(user)) throw invalidSession();
    if (!allowAccountancyOnly && !canUseBooking(user)) throw bookingAccessDenied();
  }
  return { ...decoded, email: user.email, role: user.role,
    can_login_accounts: user.can_login_accounts === true,
    can_login_booking: user.can_login_booking !== false,
    can_login_booking_accounts: user.can_login_booking_accounts === true,
    ...(user.grants !== undefined ? { grants: user.grants || {} } : {}) };
}
