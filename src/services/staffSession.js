import pool from '../config/db.js';
import { verifyToken } from '../config/jwt.js';

export async function currentStaffSession(token, db = pool) {
  const decoded = verifyToken(token);
  if (!Number.isSafeInteger(decoded.id) || decoded.id <= 0 || !Number.isSafeInteger(decoded.version)
    || !Number.isFinite(decoded.exp)) throw new Error('Invalid session');
  const { rows } = await db.query('SELECT id, email, role, token_version, is_active FROM users WHERE id = $1 LIMIT 1', [decoded.id]);
  const user = rows[0];
  if (!user?.is_active || user.token_version !== decoded.version || user.role === 'client') throw new Error('Invalid session');
  return { ...decoded, email: user.email, role: user.role };
}
