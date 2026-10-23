import pool from '../config/db.js';
import { verifyToken } from '../config/jwt.js';

const invalidSession = () => Object.assign(new Error('Invalid session'), { code: 'INVALID_SESSION', status: 401 });

export async function currentStaffSession(token, db = pool) {
  let decoded;
  try { decoded = verifyToken(token); } catch { throw invalidSession(); }
  if (!Number.isSafeInteger(decoded.id) || decoded.id <= 0 || !Number.isSafeInteger(decoded.version)
    || !Number.isFinite(decoded.exp)) throw invalidSession();
  const { rows } = await db.query('SELECT id, email, role, token_version, is_active, can_login_booking FROM users WHERE id = $1 LIMIT 1', [decoded.id]);
  const user = rows[0];
  if (!user?.is_active || user.can_login_booking === false || user.token_version !== decoded.version || user.role === 'client') throw invalidSession();
  return { ...decoded, email: user.email, role: user.role };
}
