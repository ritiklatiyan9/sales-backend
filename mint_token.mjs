// Dev-only: mint an access token for an existing active user (verification helper).
import 'dotenv/config';
import jwt from 'jsonwebtoken';
import pool from './src/config/db.js';

const { rows } = await pool.query(
  `SELECT id, email, role, token_version FROM users WHERE is_active = true ORDER BY (role = 'admin') DESC, id ASC LIMIT 1`
);
const u = rows[0];
if (!u) { console.error('no active user'); process.exit(1); }
const token = jwt.sign(
  { id: u.id, email: u.email, role: u.role, version: u.token_version },
  process.env.JWT_ACCESS_SECRET,
  { expiresIn: '1d' }
);
console.log(JSON.stringify({ user: { id: u.id, email: u.email, role: u.role }, token }));
await pool.end();
