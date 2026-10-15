import bcrypt from 'bcrypt';
import { createHash } from 'node:crypto';
import { requireSiteAccess } from './bookingWorkspaceAccess.js';

export const STAFF_LOGIN_ROLES = ['super_admin', 'admin', 'sub_admin'];
export const PHONE_LOOKUP_SQL = "right(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10)";
export const STAFF_AUTH_SELECT = `SELECT u.*, i.aadhaar_password_hash AS booking_aadhaar_password_hash,
  i.password_fingerprint AS booking_aadhaar_password_fingerprint,
  COALESCE(l.aadhaar_last4, i.aadhaar_last4) AS booking_aadhaar_last4,
  l.kyc_case_id AS booking_kyc_case_id, l.member_id AS booking_kyc_member_id,
  l.phone AS booking_kyc_mobile,
  EXISTS (SELECT 1 FROM members bm JOIN kyc_cases bk ON bk.id = l.kyc_case_id
    WHERE bm.id = l.member_id AND bk.client_member_id = bm.id AND bk.status = 'VERIFIED'
      AND 'BROKER' = ANY(COALESCE(bm.member_types, ARRAY[bm.member_type]))) AS booking_linked_broker
  FROM users u LEFT JOIN booking_staff_identities i ON i.user_id = u.id
  LEFT JOIN booking_user_kyc_links l ON l.user_id = u.id`;
export const PHONE_LOGIN_ELIGIBILITY_SQL = `(u.role = ANY($2::text[]) OR (u.role = 'agent' AND EXISTS (
  SELECT 1 FROM booking_user_kyc_links pl JOIN members pm ON pm.id = pl.member_id
  JOIN kyc_cases pk ON pk.id = pl.kyc_case_id AND pk.client_member_id = pm.id
  WHERE pl.user_id = u.id AND pk.status = 'VERIFIED'
    AND 'BROKER' = ANY(COALESCE(pm.member_types, ARRAY[pm.member_type])))))`;
export const canUsePhoneLogin = user => Boolean(user && (STAFF_LOGIN_ROLES.includes(user.role)
  || (user.role === 'agent' && user.booking_linked_broker === true)));
const passwordFingerprint = user => createHash('sha256').update(user.password || '').digest('hex');
export const hasAadhaarCredential = user => Boolean(canUsePhoneLogin(user) && user.booking_aadhaar_password_hash
  && user.booking_aadhaar_password_fingerprint === passwordFingerprint(user));

const matchesCurrentPassword = async (user, password) => await matchesStaffPassword(user, password)
  || await matchesStaffPassword(user, password, { phoneLogin: true });

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

export function normalizeStaffPhone(value) {
  if (typeof value !== 'string' || !/^[+\d\s().-]+$/.test(value)) return null;
  let digits = value.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

export function normalizeLoginIdentifier(value) {
  if (typeof value !== 'string' || value.length > 254) return null;
  const input = value.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input)) return { type: 'email', value: input.toLowerCase() };
  const phone = normalizeStaffPhone(input);
  return phone ? { type: 'phone', value: phone } : null;
}

export async function matchesStaffPassword(user, password, { phoneLogin = false } = {}) {
  if (!user || typeof password !== 'string' || !password || password.length > 256) return false;
  if (phoneLogin && !canUsePhoneLogin(user)) return false;
  if (typeof user.password === 'string' && await bcrypt.compare(password, user.password)) return true;
  // Aadhaar is an explicitly enrolled initial phone credential. It cannot sign in
  // through the email field and is removed whenever the account password changes.
  return Boolean(phoneLogin && canUsePhoneLogin(user)
    && hasAadhaarCredential(user)
    && await bcrypt.compare(password.replace(/[\s-]/g, ''), user.booking_aadhaar_password_hash));
}

export function validateProfileUpdate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Profile details are required');
  const allowed = new Set(['name', 'email', 'phone', 'current_password', 'new_password', 'aadhaar_number', 'kyc_case_id']);
  if (Object.keys(body).some(key => !allowed.has(key))) fail(400, 'Only your name, email, phone and sign-in details can be changed here');
  if (body.kyc_case_id !== undefined) {
    if (!Number.isSafeInteger(body.kyc_case_id) || body.kyc_case_id <= 0) fail(400, 'Select a valid KYC case');
    if (Object.keys(body).some(key => !['kyc_case_id', 'current_password'].includes(key))) fail(400, 'Import KYC separately from other profile changes');
    return { update: { kyc_case_id: body.kyc_case_id }, currentPassword: body.current_password };
  }
  const update = {};
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 150) fail(400, 'Name must contain 1–150 characters');
    update.name = body.name.trim();
  }
  if (body.email !== undefined) {
    if (typeof body.email !== 'string' || body.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())) fail(400, 'Enter a valid email address');
    update.email = body.email.trim().toLowerCase();
  }
  if (body.phone !== undefined) {
    update.phone = normalizeStaffPhone(body.phone);
    if (!update.phone) fail(400, 'Enter a valid 10-digit Indian mobile number');
  }
  if (body.new_password !== undefined) {
    if (typeof body.new_password !== 'string' || body.new_password.length < 8 || Buffer.byteLength(body.new_password, 'utf8') > 72) fail(400, 'New password must have at least 8 characters and at most 72 UTF-8 bytes');
    update.new_password = body.new_password;
  }
  if (body.aadhaar_number !== undefined) {
    if (typeof body.aadhaar_number !== 'string') fail(400, 'Enter a valid 12-digit Aadhaar number');
    update.aadhaar_number = body.aadhaar_number.replace(/[\s-]/g, '');
    if (!/^[2-9]\d{11}$/.test(update.aadhaar_number)) fail(400, 'Enter a valid 12-digit Aadhaar number');
  }
  if (update.new_password && update.aadhaar_number) fail(400, 'Set either an Aadhaar initial password or a new password at a time');
  if (!Object.keys(update).length) fail(400, 'No profile changes were supplied');
  if (body.current_password !== undefined && (typeof body.current_password !== 'string' || body.current_password.length > 256)) fail(400, 'Enter your current password');
  return { update, currentPassword: body.current_password };
}

/** Injected DB supports isolated PostgreSQL tests without touching the shared DB. */
export function createStaffIdentityService(db) {
  return {
    async getKycLoginOptions(session, caseId) { return getKycLoginOptions(db, session, caseId); },
    async linkKyc(session, targetId, body, { selfImport = false } = {}) {
      return linkKycIdentity(db, session, targetId, body, { selfImport });
    },
    async updateProfile(session, body) {
      const { update, currentPassword } = validateProfileUpdate(body);
      if (update.kyc_case_id) return linkKycIdentity(db, session, session.id, body, { selfImport: true });
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query(`${STAFF_AUTH_SELECT} WHERE u.id = $1 FOR UPDATE OF u`, [session.id]);
        const user = rows[0];
        if (!user || !user.is_active || user.token_version !== session.version) fail(401, 'Session expired. Please login again.');

        const sensitive = (update.email !== undefined && update.email !== user.email)
          || (update.phone !== undefined && update.phone !== normalizeStaffPhone(user.phone || ''))
          || Boolean(update.new_password || update.aadhaar_number);
        if (sensitive && !(await matchesCurrentPassword(user, currentPassword))) fail(403, 'Your current password is incorrect');
        if (update.aadhaar_number && !canUsePhoneLogin(user)) fail(403, 'Aadhaar phone sign-in is available to Super Admin, Admin, Sub-Admin and linked Broker accounts');
        if (update.aadhaar_number && !normalizeStaffPhone(update.phone || user.phone || '')) fail(400, 'Save a mobile number before enabling Aadhaar phone sign-in');

        // Serialize contact assignments made through this module, including cases
        // where old shared data prevents creating a global unique phone index.
        for (const key of [update.email && `booking-email:${update.email}`, update.phone && `booking-phone:${update.phone}`].filter(Boolean).sort()) {
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
        }
        if (update.email !== undefined) {
          const conflict = await client.query('SELECT id FROM users WHERE lower(btrim(email)) = $1 AND id <> $2 LIMIT 1', [update.email, user.id]);
          if (conflict.rows.length) fail(409, 'This email address is already assigned to another account');
        }
        if (update.phone !== undefined) {
          const conflict = await client.query(`SELECT id FROM users WHERE ${PHONE_LOOKUP_SQL} = $1 AND id <> $2 LIMIT 1`, [update.phone, user.id]);
          if (conflict.rows.length) fail(409, 'This mobile number is already assigned to another account');
        }

        const columns = [];
        const values = [];
        const set = (column, value) => { values.push(value); columns.push(`${column} = $${values.length}`); };
        for (const column of ['name', 'email', 'phone']) if (update[column] !== undefined) set(column, update[column]);
        if (update.new_password) {
          set('password', await bcrypt.hash(update.new_password, 12));
        }
        if (sensitive) {
          columns.push('token_version = token_version + 1', 'refresh_token = NULL');
          const otpTable = await client.query("SELECT to_regclass('public.login_otps') AS name");
          if (otpTable.rows[0]?.name) await client.query('DELETE FROM login_otps WHERE user_id = $1', [user.id]);
        }
        columns.push('updated_at = now()');
        values.push(user.id);
        const result = await client.query(`UPDATE users SET ${columns.join(', ')} WHERE id = $${values.length} RETURNING *`, values);
        const savedUser = result.rows[0];
        if (update.new_password) {
          await client.query('DELETE FROM booking_staff_identities WHERE user_id = $1', [user.id]);
        } else if (update.aadhaar_number) {
          savedUser.booking_aadhaar_password_hash = await bcrypt.hash(update.aadhaar_number, 12);
          savedUser.booking_aadhaar_password_fingerprint = passwordFingerprint(savedUser);
          await client.query(`INSERT INTO booking_staff_identities (user_id, aadhaar_password_hash, password_fingerprint, aadhaar_last4)
            VALUES ($1, $2, $3, $4) ON CONFLICT (user_id) DO UPDATE SET aadhaar_password_hash = EXCLUDED.aadhaar_password_hash,
              password_fingerprint = EXCLUDED.password_fingerprint, aadhaar_last4 = EXCLUDED.aadhaar_last4, updated_at = now()`,
          [user.id, savedUser.booking_aadhaar_password_hash, savedUser.booking_aadhaar_password_fingerprint, update.aadhaar_number.slice(-4)]);
        } else {
          savedUser.booking_aadhaar_password_hash = user.booking_aadhaar_password_hash;
          savedUser.booking_aadhaar_password_fingerprint = user.booking_aadhaar_password_fingerprint;
        }
        const { rows: fresh } = await client.query(`${STAFF_AUTH_SELECT} WHERE u.id = $1`, [user.id]);
        await client.query('COMMIT');
        return { user: fresh[0], sessionChanged: sensitive };
      } catch (error) {
        await client.query('ROLLBACK');
        if (error.code === '23505') fail(409, 'This email or mobile number is already assigned to another account');
        throw error;
      } finally { client.release(); }
    },
  };
}

const sameName = (a, b) => typeof a === 'string' && typeof b === 'string'
  && a.trim().replace(/\s+/g, ' ').toLocaleLowerCase() === b.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
const sameEmail = (a, b) => typeof a === 'string' && typeof b === 'string'
  && Boolean(a.trim()) && a.trim().toLowerCase() === b.trim().toLowerCase();

/** Credentials are a confirmed snapshot. Subsequent OCR/member edits never reset sign-in. */
async function linkKycIdentity(db, session, targetId, body, { selfImport }) {
  if (!Number.isSafeInteger(Number(targetId)) || Number(targetId) <= 0) fail(400, 'Select a valid login account');
  const { update, currentPassword } = validateProfileUpdate(body);
  if (!update.kyc_case_id) fail(400, 'Select a KYC case to import');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: locked } = await client.query(`${STAFF_AUTH_SELECT}
      WHERE u.id = ANY($1::integer[]) ORDER BY u.id FOR UPDATE OF u`, [[session.id, Number(targetId)]]);
    const actor = locked.find(user => user.id === Number(session.id));
    const target = locked.find(user => user.id === Number(targetId));
    if (!actor || !actor.is_active || actor.token_version !== session.version) fail(401, 'Session expired. Please login again.');
    if (!target || !target.is_active) fail(404, 'Active login account not found');
    const isSelf = actor.id === target.id;
    if (selfImport && !isSelf) fail(403, 'You can import KYC only into your own profile');
    if (!selfImport && !(actor.role === 'super_admin'
      || (actor.role === 'admin' && (isSelf || ['sub_admin', 'agent'].includes(target.role))))) {
      fail(403, 'Only an authorized Admin or Super Admin can link this login account');
    }
    if (!(await matchesCurrentPassword(actor, currentPassword))) fail(403, 'Your current password is incorrect');

    const { rows } = await client.query(`SELECT k.id AS case_id, k.status, k.site_id, m.id AS member_id,
      m.full_name, m.phone, m.email, m.aadhar_no,
      'BROKER' = ANY(COALESCE(m.member_types, ARRAY[m.member_type])) AS is_broker,
      s.organization_id
      FROM kyc_cases k JOIN members m ON m.id = k.client_member_id AND m.site_id = k.site_id
      JOIN sites s ON s.id = k.site_id WHERE k.id = $1 FOR SHARE OF k, m, s`, [update.kyc_case_id]);
    const source = rows[0];
    if (!source) fail(404, 'KYC identity not found');
    // Read roles and organizations from locked database rows, never JWT/client claims.
    for (const person of [actor, target]) {
      if (person.role !== 'super_admin' && person.organization_id != null && source.organization_id != null
        && person.organization_id !== source.organization_id) fail(403, 'KYC and login account belong to different organizations');
      await requireSiteAccess(person, source.site_id, client);
    }
    if (source.status !== 'VERIFIED') fail(409, 'Verify this KYC before using it for login');
    if (!STAFF_LOGIN_ROLES.includes(target.role) && !(target.role === 'agent' && source.is_broker)) {
      fail(403, 'Phone sign-in is limited to Super Admin, Admin, Sub-Admin and verified Brokers');
    }
    const phone = normalizeStaffPhone(source.phone);
    const aadhaar = typeof source.aadhar_no === 'string' ? source.aadhar_no.replace(/[\s-]/g, '') : '';
    if (!phone || !/^[2-9]\d{11}$/.test(aadhaar)) fail(400, 'This KYC needs a valid mobile and 12-digit Aadhaar number');
    if (selfImport && target.booking_kyc_member_id !== source.member_id
      && !['admin', 'super_admin'].includes(actor.role)) {
      fail(403, 'Ask an Admin to confirm this KYC link from the KYC page before importing it into your profile');
    }
    if (selfImport && target.booking_kyc_member_id !== source.member_id
      && !(sameName(target.name, source.full_name)
        && (normalizeStaffPhone(target.phone || '') === phone || sameEmail(target.email, source.email)))) {
      fail(403, 'This KYC does not match your existing account. Ask an Admin to confirm the account link from the KYC page.');
    }
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`booking-phone:${phone}`]);
    const duplicate = await client.query(`SELECT id FROM users WHERE ${PHONE_LOOKUP_SQL} = $1 AND id <> $2 LIMIT 1`, [phone, target.id]);
    if (duplicate.rows.length) fail(409, 'This mobile number is already assigned to another account');
    const taken = await client.query('SELECT user_id FROM booking_user_kyc_links WHERE member_id = $1 AND user_id <> $2 LIMIT 1', [source.member_id, target.id]);
    if (taken.rows.length) fail(409, 'This KYC identity is already linked to another login account');
    await client.query(`INSERT INTO booking_user_kyc_links
      (user_id, member_id, kyc_case_id, phone, aadhaar_last4, linked_by)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id) DO UPDATE SET
        member_id=EXCLUDED.member_id, kyc_case_id=EXCLUDED.kyc_case_id, phone=EXCLUDED.phone,
        aadhaar_last4=EXCLUDED.aadhaar_last4, linked_by=EXCLUDED.linked_by, linked_at=now()`,
    [target.id, source.member_id, source.case_id, phone, aadhaar.slice(-4), actor.id]);
    await client.query(`INSERT INTO booking_staff_identities (user_id,aadhaar_password_hash,password_fingerprint,aadhaar_last4)
      VALUES ($1,$2,$3,$4) ON CONFLICT (user_id) DO UPDATE SET aadhaar_password_hash=EXCLUDED.aadhaar_password_hash,
        password_fingerprint=EXCLUDED.password_fingerprint,aadhaar_last4=EXCLUDED.aadhaar_last4,updated_at=now()`,
    [target.id, await bcrypt.hash(aadhaar, 12), passwordFingerprint(target), aadhaar.slice(-4)]);
    await client.query(`UPDATE users SET phone=$1, token_version=token_version+1,
      refresh_token=NULL, updated_at=now() WHERE id=$2`, [phone, target.id]);
    const otpTable = await client.query("SELECT to_regclass('public.login_otps') AS name");
    if (otpTable.rows[0]?.name) await client.query('DELETE FROM login_otps WHERE user_id=$1', [target.id]);
    await client.query(`INSERT INTO booking_kyc_login_events (actor_user_id,target_user_id,member_id,kyc_case_id)
      VALUES ($1,$2,$3,$4)`, [actor.id, target.id, source.member_id, source.case_id]);
    const { rows: fresh } = await client.query(`${STAFF_AUTH_SELECT} WHERE u.id=$1`, [target.id]);
    await client.query('COMMIT');
    return { user: fresh[0], sessionChanged: true, isSelf };
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') fail(409, 'This mobile or KYC identity is already assigned to another account');
    throw error;
  } finally { client.release(); }
}

async function getKycLoginOptions(db, session, caseId) {
  if (!Number.isSafeInteger(Number(caseId)) || Number(caseId) <= 0) fail(400, 'Select a valid KYC case');
  const actorResult = await db.query('SELECT * FROM users WHERE id=$1', [session.id]);
  const actor = actorResult.rows[0];
  if (!actor || !actor.is_active || actor.token_version !== session.version) fail(401, 'Session expired. Please login again.');
  if (!['admin', 'super_admin'].includes(actor.role)) fail(403, 'Only Admin and Super Admin can link login accounts');
  const { rows } = await db.query(`SELECT k.id, k.client_member_id, k.site_id, k.status, m.member_type, m.phone,
    'BROKER' = ANY(COALESCE(m.member_types, ARRAY[m.member_type])) AS is_broker,
    s.organization_id, l.user_id AS linked_user_id
    FROM kyc_cases k JOIN members m ON m.id=k.client_member_id AND m.site_id=k.site_id
    JOIN sites s ON s.id=k.site_id LEFT JOIN booking_user_kyc_links l ON l.member_id=m.id
    WHERE k.id=$1`, [Number(caseId)]);
  const source = rows[0];
  if (!source) fail(404, 'KYC identity not found');
  if (actor.role !== 'super_admin' && actor.organization_id != null && source.organization_id != null
    && actor.organization_id !== source.organization_id) fail(403, 'KYC and login account belong to different organizations');
  await requireSiteAccess(actor, source.site_id, db);
  const phone = normalizeStaffPhone(source.phone);
  const candidates = await db.query(`SELECT u.id,u.name,u.email,u.role,u.phone FROM users u
    WHERE u.is_active=true
      AND (u.role=ANY($1::text[]) OR (u.role='agent' AND $2::boolean))
      AND ($3::boolean OR u.id=$4 OR u.role=ANY(ARRAY['sub_admin','agent']))
      AND (u.role='super_admin' OR u.organization_id IS NULL OR $5::integer IS NULL OR u.organization_id=$5)
      AND (u.role=ANY(ARRAY['admin','super_admin']) OR EXISTS
        (SELECT 1 FROM user_sites us WHERE us.user_id=u.id AND us.site_id=$6))
      AND ($7::integer IS NULL OR u.id=$7)
      AND ($8::text IS NULL OR NOT EXISTS (SELECT 1 FROM users other
        WHERE ${PHONE_LOOKUP_SQL.replace(/\bphone\b/g, 'other.phone')}=$8 AND other.id<>u.id))
    ORDER BY u.name,u.id`,
  [STAFF_LOGIN_ROLES, source.is_broker, actor.role === 'super_admin', actor.id,
    source.organization_id, source.site_id, source.linked_user_id, phone]);
  return {
    kyc_case_id: source.id, member_id: source.client_member_id,
    verified: source.status === 'VERIFIED', member_type: source.member_type,
    is_broker: source.is_broker, linked_user_id: source.linked_user_id || null,
    candidates: candidates.rows.map(user => ({ id: user.id, name: user.name, email: user.email, role: user.role,
      phone_hint: normalizeStaffPhone(user.phone || '') ? `••••••${normalizeStaffPhone(user.phone).slice(-4)}` : null })),
  };
}
