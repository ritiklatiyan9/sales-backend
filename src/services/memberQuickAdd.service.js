import { isAdminRole } from './agentNetwork.service.js';
import { normalizeMemberType } from './memberRoles.service.js';

/**
 * Quick-add a person from a bare mobile number into the SHARED Accounting `members`
 * table. The role-aware KYC flow passes its selected member type; legacy draw and
 * booking callers use the CLIENT wrapper exported below.
 *
 * MUST be called inside the caller's open transaction (`client`): find-or-create is
 * made atomic by an advisory xact lock keyed on the number, which serialises
 * double-taps and two agents racing on the same person (members has no unique phone
 * constraint). The lock deliberately excludes role: Accounting treats a phone as
 * site-unique, so two concurrent registrations cannot create the same phone under
 * different roles. Matching on the trailing 10 digits absorbs +91/0 prefixes.
 *
 * Referral claim: the first non-admin to add the number becomes the customer's
 * referrer — an existing claim is never overwritten.
 *
 * Throws { status: 400 } on an invalid number (handled by the error middleware).
 */
export async function findOrCreateMemberByPhone(
  { siteId, phone, fullName, memberType = 'CLIENT', user },
  client
) {
  const cleanPhone = String(phone || '').replace(/\D/g, '');
  if (cleanPhone.length < 6 || cleanPhone.length > 15) {
    throw Object.assign(new Error('Enter a valid mobile number'), { status: 400 });
  }
  const canonicalType = normalizeMemberType(memberType);
  const isAdmin = isAdminRole(user?.role);

  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',
    [`member_quick_add:${siteId}:${cleanPhone.slice(-10)}`]);

  const { rows: existing } = await client.query(
    `SELECT * FROM members
      WHERE site_id = $1
        AND regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') <> ''
        AND RIGHT(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g'), 10) = RIGHT($2, 10)
      ORDER BY id DESC LIMIT 1`,
    [siteId, cleanPhone]
  );
  let member = existing[0];

  if (member && member.member_type !== canonicalType) {
    throw Object.assign(
      new Error(
        `Mobile number ${cleanPhone} is already registered as ${member.member_type} for ${member.full_name}. ` +
        `Select ${member.member_type} or use a different mobile number.`
      ),
      {
        status: 409,
        code: 'MEMBER_ROLE_CONFLICT',
        existing_member_id: member.id,
        existing_member_type: member.member_type,
      }
    );
  }

  if (!member) {
    const roleLabel = canonicalType.charAt(0) + canonicalType.slice(1).toLowerCase();
    const name = String(fullName || '').trim() || `${roleLabel} ${cleanPhone}`;
    const referredBy = isAdmin ? null : user?.id || null;
    const { rows: created } = await client.query(
      `INSERT INTO members (site_id, member_type, status, full_name, phone, created_by, referred_by_user_id)
       VALUES ($1, $2, 'ACTIVE', $3, $4, $5, $6) RETURNING *`,
      [siteId, canonicalType, name, cleanPhone, user?.id || null, referredBy]
    );
    member = created[0];
  } else if (!member.referred_by_user_id && !isAdmin) {
    // Existing customer without a referrer — the agent adding them now claims it.
    await client.query(
      `UPDATE members SET referred_by_user_id = $1, updated_at = now()
        WHERE id = $2 AND referred_by_user_id IS NULL`,
      [user.id, member.id]
    );
    member.referred_by_user_id = user.id;
  }
  return member;
}

/** Backwards-compatible CLIENT entry point used by booking/draw flows. */
export async function findOrCreateClientByPhone(input, client) {
  return findOrCreateMemberByPhone({ ...input, memberType: 'CLIENT' }, client);
}
