import asyncHandler from '../utils/asyncHandler.js';
import {
  signAccessToken, signRefreshToken, verifyToken, comparePassword, hashRefreshToken,
} from '../config/jwt.js';
import userModel from '../models/User.model.js';
import pool from '../config/db.js';

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

  const version = user.token_version;
  const accessToken = signAccessToken({ id: user.id, email: user.email, role: user.role, version });
  const refreshToken = signRefreshToken({ id: user.id, version });
  await userModel.setRefreshToken(user.id, await hashRefreshToken(refreshToken));

  res.json({ user: userModel.sanitize(user), accessToken, refreshToken });
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

  let sites;
  if (user.role === 'admin' || user.role === 'super_admin') {
    const { rows } = await pool.query('SELECT id, name FROM sites ORDER BY name');
    sites = rows;
  } else {
    const { rows } = await pool.query(
      `SELECT s.id, s.name FROM sites s
       JOIN user_sites us ON us.site_id = s.id
       WHERE us.user_id = $1 ORDER BY s.name`,
      [user.id]
    );
    sites = rows;
  }

  res.json({ user: userModel.sanitize(user), sites });
});
