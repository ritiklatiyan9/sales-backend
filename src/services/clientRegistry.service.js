import { requireSiteAccess } from './bookingWorkspaceAccess.js';
import { isAdminRole } from './agentNetwork.service.js';
import { memberTypePayload } from './memberRoles.service.js';
import kycCaseModel from '../models/KycCase.model.js';

export const clientRegistryError = (message, status = 400, code) =>
  Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

// Keep this expression identical to migration 030's index and duplicate guard.
export const memberPhoneSql = (alias = 'm') =>
  `RIGHT(regexp_replace(COALESCE(${alias}.phone, ''), '\\D', '', 'g'), 10)`;

export function normalizeClientPhone(value, { required = false, strict = false } = {}) {
  const input = String(value ?? '').trim();
  if (!input) {
    if (required) throw clientRegistryError('Mobile number is required');
    return null;
  }
  if (!/^[+\d\s().-]+$/.test(input)) throw clientRegistryError('Enter a valid mobile number');
  let digits = input.replace(/\D/g, '');
  if ((digits.length === 12 && digits.startsWith('91')) || (digits.length === 11 && digits.startsWith('0'))) {
    digits = digits.slice(-10);
  }
  if (strict ? !/^[6-9]\d{9}$/.test(digits) : digits.length < 6 || digits.length > 15) {
    throw clientRegistryError(strict ? 'Enter a valid 10-digit Indian mobile number' : 'Enter a valid mobile number');
  }
  return digits;
}

export function normalizeClientIdentity(input) {
  const output = { ...input };
  if (output.pan_no !== undefined) {
    output.pan_no = String(output.pan_no ?? '').replace(/\s/g, '').toUpperCase() || null;
    if (output.pan_no && !/^[A-Z]{5}\d{4}[A-Z]$/.test(output.pan_no)) {
      throw clientRegistryError('PAN must contain 5 letters, 4 digits and 1 letter');
    }
  }
  if (output.aadhar_no !== undefined) {
    const raw = String(output.aadhar_no ?? '').trim();
    if (raw && !/^[\d\s-]+$/.test(raw)) throw clientRegistryError('Aadhaar must contain 12 digits');
    output.aadhar_no = raw.replace(/[\s-]/g, '') || null;
    if (output.aadhar_no && !/^\d{12}$/.test(output.aadhar_no)) {
      throw clientRegistryError('Aadhaar must contain 12 digits');
    }
  }
  return output;
}

export function maskClientIdentity(member) {
  return {
    ...member,
    aadhar_no: member.aadhar_no ? `XXXX XXXX ${String(member.aadhar_no).replace(/\D/g, '').slice(-4)}` : null,
    pan_no: member.pan_no ? `${String(member.pan_no).slice(0, 2)}******${String(member.pan_no).slice(-2)}` : null,
  };
}

export function clientSearchFilter(query, params, alias = 'm') {
  const q = String(query || '').trim().slice(0, 120);
  if (!q) return null;
  if (/^[+\d\s().-]+$/.test(q)) {
    let digits = q.replace(/\D/g, '');
    if (!digits) return 'false';
    if ((digits.length === 12 && digits.startsWith('91')) || (digits.length === 11 && digits.startsWith('0'))) digits = digits.slice(-10);
    params.push(`${digits.replace(/[\\%_]/g, '\\$&')}%`);
    return `${memberPhoneSql(alias)} LIKE $${params.length}`;
  }
  params.push(`${q.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`);
  return `lower(${alias}.full_name) LIKE $${params.length}`;
}

/** Codes identify active users who are eligible to work at the selected site. */
export async function resolveClientReferral(code, siteId, db) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!normalized) return null;
  if (!/^[A-Z0-9-]{1,40}$/.test(normalized)) throw clientRegistryError('Enter a valid agent referral code');
  const { rows } = await db.query(
    `SELECT u.id, u.name, u.referral_code
       FROM users u
      WHERE upper(u.referral_code) = $1 AND u.is_active = true
        AND COALESCE(u.agent_status, 'ACTIVE') = 'ACTIVE'
        AND (u.role IN ('super_admin', 'admin')
             OR EXISTS (SELECT 1 FROM user_sites us WHERE us.user_id = u.id AND us.site_id = $2))
      LIMIT 1`,
    [normalized, siteId],
  );
  if (!rows[0]) throw clientRegistryError('This referral code is invalid, inactive or unavailable for this site', 400, 'INVALID_AGENT_REFERRAL');
  return rows[0];
}

/** Caller owns the transaction. Uses the same lock as quick-add and the DB guard. */
export async function registerClientMember({ input, memberType, editableFields, user, visibleUserIds }, db) {
  const siteId = Number(input.site_id);
  await requireSiteAccess(user, siteId, db);
  const fullName = String(input.full_name || '').trim();
  if (!fullName || fullName.length > 255) throw clientRegistryError('Enter a client name of at most 255 characters');
  const registration = [true, 'true', '1', 1].includes(input.registration);
  if (registration && memberType !== 'CLIENT') throw clientRegistryError('Client registration must use the CLIENT role');
  const values = normalizeClientIdentity({ ...input, full_name: fullName });
  const phone = normalizeClientPhone(input.phone, { required: registration, strict: registration });
  if (phone !== null) values.phone = phone;
  const referral = await resolveClientReferral(input.agent_referral_code ?? input.referral_code ?? input.agent_code, siteId, db);
  let member;
  let reused = false;
  if (phone) {
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`member_quick_add:${siteId}:${phone.slice(-10)}`]);
    const existing = await db.query(
      `SELECT * FROM members m WHERE m.site_id = $1 AND ${memberPhoneSql()} = RIGHT($2, 10) ORDER BY m.id DESC LIMIT 1 FOR UPDATE`,
      [siteId, phone],
    );
    member = existing.rows[0];
  }
  if (member) {
    if (member.member_type !== memberType) {
      throw Object.assign(clientRegistryError(`This mobile number is already registered as ${member.member_type} for ${member.full_name}`, 409, 'MEMBER_ROLE_CONFLICT'), {
        existing_member_id: member.id,
        existing_member_type: member.member_type,
      });
    }
    if (referral && member.referred_by_user_id && Number(member.referred_by_user_id) !== Number(referral.id)) {
      throw clientRegistryError('This client already has a different referring agent. Select the existing client to continue.', 409, 'CLIENT_REFERRAL_CONFLICT');
    }
    const identitySets = [];
    const identityParams = [];
    for (const field of ['pan_no', 'aadhar_no']) {
      if (!values[field]) continue;
      const stored = String(member[field] || '').replace(/[\s-]/g, '').toUpperCase();
      if (stored && stored !== values[field]) {
        throw clientRegistryError(`This mobile number already has a different ${field === 'pan_no' ? 'PAN' : 'Aadhaar'} number. Open the existing client to review their details.`, 409, 'CLIENT_IDENTITY_CONFLICT');
      }
      if (!stored) {
        identityParams.push(values[field]);
        identitySets.push(`${field} = $${identityParams.length}`);
      }
    }
    // Intake can complete a sparse existing profile without replacing confirmed data.
    for (const field of ['father_name','date_of_birth','gender','address','city','state','pincode']) {
      if (values[field] && !String(member[field] || '').trim() && editableFields.includes(field)) {
        identityParams.push(values[field]);
        identitySets.push(`${field} = $${identityParams.length}`);
      }
    }
    if (identitySets.length) {
      identityParams.push(member.id);
      const updated = await db.query(`UPDATE members SET ${identitySets.join(', ')}, updated_at = now()
        WHERE id = $${identityParams.length} RETURNING *`, identityParams);
      member = updated.rows[0];
    }
    reused = true;
  } else {
    const columns = ['site_id', 'member_type', 'status', 'created_by'];
    const params = [siteId, memberType, 'ACTIVE', user.id];
    for (const field of editableFields) {
      if (values[field] !== undefined) {
        columns.push(field);
        params.push(values[field] === '' ? null : values[field]);
      }
    }
    const { rows } = await db.query(`INSERT INTO members (${columns.join(', ')}) VALUES (${params.map((_, index) => `$${index + 1}`).join(', ')}) RETURNING *`, params);
    member = rows[0];
  }
  // Explicit code wins on a new claim. Never replace an existing attribution.
  const referrerId = referral?.id || (!isAdminRole(user.role) ? user.id : null);
  if (referrerId && !member.referred_by_user_id) {
    const updated = await db.query('UPDATE members SET referred_by_user_id = $1, updated_at = now() WHERE id = $2 AND referred_by_user_id IS NULL RETURNING *', [referrerId, member.id]);
    member = updated.rows[0] || member;
  }
  const kyc = memberType === 'CLIENT' ? await kycCaseModel.getOrCreateForMember({ memberId: member.id, siteId, createdBy: user.id, visibleUserIds }, db) : null;
  const agent = member.referred_by_user_id ? (await db.query('SELECT name, referral_code FROM users WHERE id = $1', [member.referred_by_user_id])).rows[0] : null;
  return {
    ...member,
    ...memberTypePayload(member),
    reused,
    kyc_case_id: kyc?.id || null,
    kyc_status: kyc?.status || null,
    referred_by_name: agent?.name || null,
    referred_by_code: agent?.referral_code || null,
    referral_agent_name: agent?.name || null,
    referral_code: agent?.referral_code || null,
  };
}
