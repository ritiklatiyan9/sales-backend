import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';

// Same secrets + token shape as the accounting backend → tokens are interchangeable.
const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

// Both tokens live 24h from login → user logs in once per day; keep in sync with the accounting backend.
export const signAccessToken = (payload) => jwt.sign(payload, ACCESS_SECRET, { expiresIn: '24h' });
export const signRefreshToken = (payload) => jwt.sign(payload, REFRESH_SECRET, { expiresIn: '24h' });
export const verifyToken = (token, secret = ACCESS_SECRET) => jwt.verify(token, secret);
export const hashPassword = async (password) => await bcrypt.hash(password, 10);
export const comparePassword = async (password, hash) => {
  if (!password || !hash || typeof password !== 'string' || typeof hash !== 'string') return false;
  return bcrypt.compare(password, hash);
};
export const hashRefreshToken = async (token) => await bcrypt.hash(token, 10);
