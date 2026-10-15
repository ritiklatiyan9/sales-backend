import pool from '../config/db.js';
import { normalizeLoginIdentifier, PHONE_LOOKUP_SQL, STAFF_LOGIN_ROLES, STAFF_AUTH_SELECT, PHONE_LOGIN_ELIGIBILITY_SQL, canUsePhoneLogin, hasAadhaarCredential } from '../services/staffIdentity.service.js';

// Reads/writes the SHARED accounting `users` table (login only — never created here).
class UserModel {
  async findByEmail(email) {
    return this.findByEmailInsensitive(email);
  }

  /** Case-insensitive lookup — Google emails arrive normalised, legacy rows may not be. */
  async findByEmailInsensitive(email) {
    if (typeof email !== 'string' || !email.trim()) return undefined;
    const { rows } = await pool.query(
      `${STAFF_AUTH_SELECT} WHERE lower(btrim(u.email)) = $1 LIMIT 2`,
      [email.trim().toLowerCase()]
    );
    return rows.length === 1 ? rows[0] : undefined;
  }

  async findByLoginIdentifier(identifier) {
    const parsed = normalizeLoginIdentifier(identifier);
    if (!parsed) return undefined;
    if (parsed.type === 'email') return this.findByEmailInsensitive(parsed.value);
    const { rows } = await pool.query(
      `${STAFF_AUTH_SELECT} WHERE ${PHONE_LOOKUP_SQL.replace(/\bphone\b/g, 'u.phone')} = $1 AND ${PHONE_LOGIN_ELIGIBILITY_SQL} LIMIT 2`,
      [parsed.value, STAFF_LOGIN_ROLES]
    );
    // Legacy shared users may share a phone. Never pick an arbitrary identity.
    return rows.length === 1 ? rows[0] : undefined;
  }

  async findById(id) {
    const { rows } = await pool.query(`${STAFF_AUTH_SELECT} WHERE u.id = $1 LIMIT 1`, [id]);
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
    const safe = Object.fromEntries(Object.entries(user).filter(([key]) => !/^booking_|password|token|aadhaar|aadhar|adhar/i.test(key)));
    return { ...safe,
      phone_login_allowed: canUsePhoneLogin(user), phone_aadhaar_enabled: hasAadhaarCredential(user),
      aadhaar_masked: user.booking_aadhaar_last4 ? `XXXX XXXX ${user.booking_aadhaar_last4}` : null,
      kyc_case_id: user.booking_kyc_case_id || null, kyc_member_id: user.booking_kyc_member_id || null,
      kyc_mobile: user.booking_kyc_mobile || null,
    };
  }
}

export default new UserModel();
