import pool from '../config/db.js';
import { verifyToken } from '../config/jwt.js';

const invalidSession = () => Object.assign(new Error('Invalid session'), { code: 'INVALID_SESSION', status: 401 });

// The caller's booking_* grants ride along with the session row: a per-request snapshot
// that hasPermission reads instead of querying again. Never cached across requests, never
// put in the JWT, so revocation (token_version, Access Control edits) applies on the next request.
const sessionSql = grants => `SELECT u.id, u.email, u.role, u.token_version, u.is_active, u.can_login_booking${grants ? `,
    (SELECT jsonb_object_agg(p.module, jsonb_build_array(p.can_read, p.can_write, p.can_update, p.can_delete))
       FROM user_permissions p WHERE p.user_id = u.id AND p.module LIKE 'booking\\_%') AS grants` : ''}
  FROM users u WHERE u.id = $1 LIMIT 1`;

export async function currentStaffSession(token, db = pool) {
  let decoded;
  try { decoded = verifyToken(token); } catch { throw invalidSession(); }
  if (!Number.isSafeInteger(decoded.id) || decoded.id <= 0 || !Number.isSafeInteger(decoded.version)
    || !Number.isFinite(decoded.exp)) throw invalidSession();
  // ponytail: 42P01 = an isolated schema without the shared user_permissions table (test fixtures);
  // the session still loads and hasPermission falls back to its own query.
  const { rows } = await db.query(sessionSql(true), [decoded.id])
    .catch(error => { if (error.code === '42P01') return db.query(sessionSql(false), [decoded.id]); throw error; });
  const user = rows[0];
  if (!user?.is_active || user.can_login_booking === false || user.token_version !== decoded.version || user.role === 'client') throw invalidSession();
  return { ...decoded, email: user.email, role: user.role, ...(user.grants !== undefined ? { grants: user.grants || {} } : {}) };
}
