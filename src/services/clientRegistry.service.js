import { parseMemberCode, canonicalMemberIdSql, findBrokerReferral, memberReferral } from './memberCodes.js';
import { requireSiteAccess } from './bookingWorkspaceAccess.js';
import { isAdminRole } from './agentNetwork.service.js';
import { memberTypePayload, memberHasType, addMemberType } from './memberRoles.service.js';
import { hasPermission } from './permissions.service.js';
import kycCaseModel from '../models/KycCase.model.js';

export const clientRegistryError = (message, status = 400, code) =>
  Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

export const requireClientRegistryPermission = async (user, action = 'can_read') => {
  const flags = action === 'can_read' ? ['can_read'] : ['can_read', action];
  const allowed = await Promise.all(flags.map(flag => hasPermission(user, 'booking_clients', flag)));
  if (allowed.some(value => !value)) throw clientRegistryError('Access Control has not granted this Clients action for your account', 403);
};

/** Promise.all for independent checks/reads that still fails like the sequential awaits it
 *  replaces: the first rejection in argument order wins, whichever settled first. */
export async function allInOrder(promises) {
  const results = await Promise.allSettled(promises);
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  return results.map(result => result.value);
}

// Keep this expression identical to migration 030's index and duplicate guard.
export const memberPhoneSql = (alias = 'm') =>
  `RIGHT(regexp_replace(COALESCE(${alias}.phone, ''), '\\D', '', 'g'), 10)`;

// Onboarding KYC is complete once one case holds these three slots. identityDocsSql is
// the single definition shared by the auto-verify rule, the lookup and the upload reply.
export const IDENTITY_DOCUMENTS = ['aadhaar_front', 'aadhaar_back', 'pan'];
export const identityDocsSql = caseId => `SELECT
    COALESCE(bool_or(type = 'AADHAAR' AND member_document_field = 'aadhar_front_url'), false) AS aadhaar_front,
    COALESCE(bool_or(type = 'AADHAAR' AND member_document_field = 'aadhar_back_url'), false) AS aadhaar_back,
    COALESCE(bool_or(type = 'PAN'), false) AS pan
  FROM documents WHERE kyc_case_id = ${caseId}`;
export const missingIdentityDocuments = docs => IDENTITY_DOCUMENTS.filter(key => !docs?.[key]);

/** Registered = any VERIFIED case at the member's site (client portal and dashboard rule). */
export const kycVerifiedSql = (alias = 'm') => `EXISTS (SELECT 1 FROM kyc_cases kv
    WHERE kv.client_member_id = ${alias}.id AND kv.site_id = ${alias}.site_id AND kv.status = 'VERIFIED')`;

/** The case POST /clients/:id/documents writes to: mirrors KycCase.getOrCreateForMember. */
export const uploadCaseLateral = (alias, visibleParam, as = 'upload_case') => `LEFT JOIN LATERAL (
    SELECT kc.id, kc.status FROM kyc_cases kc
     WHERE kc.client_member_id = ${alias}.id AND kc.booking_id IS NULL
       AND (${visibleParam}::int[] IS NULL OR kc.created_by = ANY(${visibleParam}::int[]))
     ORDER BY kc.id DESC LIMIT 1) ${as} ON true`;

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
  const code = parseMemberCode(q);
  if (code) {
    params.push(code.role, code.id);
    return `(${alias}.member_type=$${params.length - 1} AND ${canonicalMemberIdSql(alias)}=$${params.length})`;
  }
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
  const memberCode = parseMemberCode(normalized);
  if (memberCode) {
    if (memberCode.role !== 'BROKER') throw clientRegistryError('Use a broker code such as BRK-00002 for the referral',400,'INVALID_AGENT_REFERRAL');
    const broker = await findBrokerReferral(normalized,siteId,db);
    if (!broker) throw clientRegistryError('This broker code is invalid, inactive or unavailable for this site',400,'INVALID_AGENT_REFERRAL');
    return {id:null,member_id:broker.id,name:broker.full_name,referral_code:broker.member_code};
  }
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
  const referralCode = input.agent_referral_code ?? input.referral_code ?? input.agent_code;
  if (registration && !String(referralCode || '').trim()) throw clientRegistryError('Broker code is required.', 400, 'BROKER_CODE_REQUIRED');
  const referral = await resolveClientReferral(referralCode, siteId, db);
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
    // One person, many roles: an employee registering as a client gains CLIENT on the same row.
    reused = memberHasType(member, memberType);
    member = await addMemberType(member, memberType, db);
    if (referral && (
      (member.referred_by_member_id && Number(member.referred_by_member_id) !== Number(referral.member_id)) ||
      (!member.referred_by_member_id && member.referred_by_user_id && Number(member.referred_by_user_id) !== Number(referral.id))
    )) {
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
  if (referral?.member_id && !member.referred_by_member_id) {
    member = (await db.query('UPDATE members SET referred_by_member_id=$1, referred_by_member_code=$3, updated_at=now() WHERE id=$2 AND referred_by_member_id IS NULL RETURNING *',[referral.member_id,member.id,referral.referral_code])).rows[0] || member;
  }
  // Explicit code wins on a new claim. Never replace an existing attribution.
  const referrerId = referral?.id || (!isAdminRole(user.role) ? user.id : null);
  if (referrerId && !member.referred_by_user_id) {
    const updated = await db.query('UPDATE members SET referred_by_user_id = $1, updated_at = now() WHERE id = $2 AND referred_by_user_id IS NULL RETURNING *', [referrerId, member.id]);
    member = updated.rows[0] || member;
  }
  const kyc = memberType === 'CLIENT' ? await kycCaseModel.getOrCreateForMember({ memberId: member.id, siteId, createdBy: user.id, visibleUserIds }, db) : null;
  const agent = await memberReferral(member,db);
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
