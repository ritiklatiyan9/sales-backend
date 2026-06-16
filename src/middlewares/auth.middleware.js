import { verifyToken } from '../config/jwt.js';
import pool from '../config/db.js';

// Same verification as the accounting backend: validate JWT, then confirm the user
// still exists, is active, and the token_version matches (revocation support).
const authMiddleware = async (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ message: 'No token provided' });

  try {
    const decoded = verifyToken(token);
    const { rows } = await pool.query(
      'SELECT id, token_version, is_active FROM users WHERE id = $1 LIMIT 1',
      [decoded.id]
    );
    const dbUser = rows[0];
    if (!dbUser || !dbUser.is_active) {
      return res.status(401).json({ message: 'Session expired. Please login again.' });
    }
    if (decoded.version !== dbUser.token_version) {
      return res.status(401).json({ message: 'Session expired. Please login again.' });
    }
    req.user = decoded; // { id, email, role, version }
    next();
  } catch {
    res.status(401).json({ message: 'Invalid or expired token' });
  }
};

export default authMiddleware;
