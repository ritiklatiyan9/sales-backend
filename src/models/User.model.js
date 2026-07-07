import pool from '../config/db.js';

// Reads/writes the SHARED accounting `users` table (login only — never created here).
class UserModel {
  async findByEmail(email) {
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1 LIMIT 1', [email]);
    return rows[0];
  }

  /** Case-insensitive lookup — Google emails arrive normalised, legacy rows may not be. */
  async findByEmailInsensitive(email) {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE lower(email) = lower($1) LIMIT 1',
      [email]
    );
    return rows[0];
  }

  async findById(id) {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1 LIMIT 1', [id]);
    return rows[0];
  }

  async setRefreshToken(id, hashedToken) {
    await pool.query('UPDATE users SET refresh_token = $1 WHERE id = $2', [hashedToken, id]);
  }

  async bumpTokenVersion(id, currentVersion) {
    await pool.query('UPDATE users SET token_version = $1, refresh_token = NULL WHERE id = $2', [currentVersion + 1, id]);
  }

  sanitize(user) {
    if (!user) return null;
    const { password, refresh_token, ...safe } = user;
    return safe;
  }
}

export default new UserModel();
