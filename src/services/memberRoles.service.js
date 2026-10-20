/**
 * Canonical person roles stored in the shared Accounting `members.member_type`
 * column. Keep this list aligned with the additive member-role migration and the
 * accounting app's member categories.
 */
export const MEMBER_TYPES = Object.freeze([
  'CLIENT',
  'FARMER',
  'MEMBER',
  'BROKER',
  'PARTNER',
  'VENDOR',
  'EMPLOYEE',
  'SUPERVISOR',
  'OTHER',
]);

const MEMBER_TYPE_SET = new Set(MEMBER_TYPES);

export const MEMBER_TYPE_OPTIONS = Object.freeze([
  { value: 'CLIENT', label: 'Client' },
  { value: 'MEMBER', label: 'Member' },
  { value: 'VENDOR', label: 'Vendor' },
  { value: 'SUPERVISOR', label: 'Supervisor' },
  { value: 'FARMER', label: 'Farmer' },
  { value: 'EMPLOYEE', label: 'Employee' },
  { value: 'BROKER', label: 'Broker' },
  { value: 'PARTNER', label: 'Partner' },
  { value: 'OTHER', label: 'Other' },
]);

const REQUEST_KEYS = [
  'member_type',
  'role',
  'registration_role',
  'applicant_role',
  'party_type',
  'client_type',
];

const normaliseToken = (value) => String(value || '')
  .trim()
  .toUpperCase()
  .replace(/[\s-]+/g, '_');

/**
 * Validate a member role at the HTTP boundary.
 *
 * Unknown values are rejected instead of silently creating a CLIENT. A fallback is
 * used only when the caller omitted the role entirely, preserving old clients that
 * pre-date role-aware registration.
 */
export const normalizeMemberType = (value, fallback = 'CLIENT') => {
  const raw = normaliseToken(value);
  if (!raw) {
    if (fallback === null || fallback === undefined) return null;
    return normalizeMemberType(fallback, null);
  }
  if (!MEMBER_TYPE_SET.has(raw)) {
    throw Object.assign(
      new Error(`member_type must be one of ${MEMBER_TYPES.join(', ')}`),
      { status: 400, code: 'INVALID_MEMBER_TYPE' }
    );
  }
  return raw;
};

/** Read the first supported role key from a JSON or multipart request body. */
export const memberTypeFromBody = (body, fallback = 'CLIENT') => {
  const source = body && typeof body === 'object' ? body : {};
  const key = REQUEST_KEYS.find((candidate) => {
    const value = source[candidate];
    return value !== undefined && value !== null && String(value).trim() !== '';
  });
  return normalizeMemberType(key ? source[key] : null, fallback);
};

/** Optional list-filter variant: blank/ALL means no role filter. */
export const memberTypeFilterFromQuery = (query) => {
  const source = query && typeof query === 'object' ? query : {};
  const key = REQUEST_KEYS.find((candidate) => {
    const value = source[candidate];
    return value !== undefined && value !== null && String(value).trim() !== '';
  });
  if (!key) return null;
  if (normaliseToken(source[key]) === 'ALL') return null;
  return normalizeMemberType(source[key], null);
};

export const memberTypePayload = (memberOrType) => {
  const memberType = normalizeMemberType(
    typeof memberOrType === 'object' ? memberOrType?.member_type : memberOrType,
    'CLIENT'
  );
  return {
    member_type: memberType,
    registration_role: memberType,
    role: memberType,
  };
};

/** Stable Fresh-OCR role comparison used by preview and commit. */
export const compareMemberTypes = (selectedValue, detectedValue) => {
  const selected = normalizeMemberType(selectedValue);
  const detected = normalizeMemberType(detectedValue, null);
  return {
    selected,
    detected,
    matches: detected ? detected === selected : null,
    blocking: !!detected && detected !== selected,
  };
};

/** Accounting migration 131: `member_types` is every role a person holds and
 *  `member_type` only the primary. Role checks read the set, so an employee or
 *  broker can also be a client on the same profile. */
export const memberTypesSql = (alias = 'm') => `COALESCE(${alias}.member_types, ARRAY[${alias}.member_type])`;

export const memberHasType = (member, type) =>
  (member?.member_types?.length ? member.member_types : [member?.member_type]).includes(type);

/** Grants `type` to an existing member row (no-op when held). Caller owns the lock. */
export async function addMemberType(member, type, db) {
  if (memberHasType(member, type)) return member;
  const { rows } = await db.query(
    `UPDATE members SET member_types = array_append(${memberTypesSql('members')}, $1::text), updated_at = now()
      WHERE id = $2 RETURNING *`, [type, member.id]);
  return rows[0] || member;
}
