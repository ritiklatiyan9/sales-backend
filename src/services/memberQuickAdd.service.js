import { isAdminRole } from './agentNetwork.service.js';

/**
 * Quick-add a customer from a bare mobile number — the shared entry point for the
 * KYC flow (POST /kyc/cases) and the Draw Registration flow (POST /draws).
 *
 * MUST be called inside the caller's open transaction (`client`): find-or-create is
 * made atomic by an advisory xact lock keyed on the number, which serialises
 * double-taps and two agents racing on the same lead (members has no unique phone
 * constraint). Matching on the trailing 10 digits absorbs +91/0 prefixes.
 *
 * Referral claim: the first non-admin to add the number becomes the customer's
 * referrer — an existing claim is never overwritten.
 *
 * Throws { status: 400 } on an invalid number (handled by the error middleware).
 */
export async function findOrCreateClientByPhone({ siteId, phone, fullName, user }, client) {
  const cleanPhone = String(phone || '').replace(/\D/g, '');
  if (cleanPhone.length < 6 || cleanPhone.length > 15) {
    throw Object.assign(new Error('Enter a valid mobile number'), { status: 400 });
  }
  const isAdmin = isAdminRole(user?.role);

  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',
    [`kyc_quick_add:${siteId}:${cleanPhone.slice(-10)}`]);

  const { rows: existing } = await client.query(
    `SELECT * FROM members
      WHERE member_type = 'CLIENT' AND site_id = $1
        AND regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') <> ''
        AND RIGHT(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g'), 10) = RIGHT($2, 10)
      ORDER BY id DESC LIMIT 1`,
    [siteId, cleanPhone]
  );
  let member = existing[0];

  if (!member) {
    const name = String(fullName || '').trim() || `Customer ${cleanPhone}`;
    const referredBy = isAdmin ? null : user?.id || null;
    const { rows: created } = await client.query(
      `INSERT INTO members (site_id, member_type, status, full_name, phone, created_by, referred_by_user_id)
       VALUES ($1, 'CLIENT', 'ACTIVE', $2, $3, $4, $5) RETURNING *`,
      [siteId, name, cleanPhone, user?.id || null, referredBy]
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
