export const MEMBER_CODE_PREFIXES = { CLIENT:'CLT', FARMER:'FRM', MEMBER:'MEM', BROKER:'BRK', PARTNER:'PTN', VENDOR:'VND', EMPLOYEE:'EMP', SUPERVISOR:'SUP', OTHER:'OTH' };
const ROLES = Object.fromEntries(Object.entries(MEMBER_CODE_PREFIXES).map(([role,prefix]) => [prefix,role]));
export const parseMemberCode = value => {
  const match = String(value || '').trim().toUpperCase().match(/^([A-Z]{3})-(\d+)$/);
  const id = match ? Number(match[2]) : 0;
  return match && ROLES[match[1]] && Number.isSafeInteger(id) && id > 0 ? { role:ROLES[match[1]],id } : null;
};
export const canonicalMemberIdSql = (alias='m') => `COALESCE((SELECT MIN(code_person.id) FROM members code_person
  WHERE LENGTH(RIGHT(REGEXP_REPLACE(COALESCE(${alias}.phone, ''), '[^0-9]', '', 'g'), 10)) = 10
    AND RIGHT(REGEXP_REPLACE(COALESCE(code_person.phone, ''), '[^0-9]', '', 'g'), 10)
      = RIGHT(REGEXP_REPLACE(COALESCE(${alias}.phone, ''), '[^0-9]', '', 'g'), 10)), ${alias}.id)`;
export const memberCodeSql = (alias='m') => `(CASE ${alias}.member_type ${Object.entries(MEMBER_CODE_PREFIXES).map(([role,prefix])=>`WHEN '${role}' THEN '${prefix}'`).join(' ')} ELSE 'OTH' END || '-' || LPAD((${canonicalMemberIdSql(alias)})::text, GREATEST(5,LENGTH((${canonicalMemberIdSql(alias)})::text)), '0'))`;
export async function findMemberByCode(code,siteId,db,{activeOnly=false}={}) {
  const parsed=parseMemberCode(code);
  if(!parsed) return null;
  const {rows}=await db.query(`SELECT m.*, ${memberCodeSql()} AS member_code FROM members m WHERE m.site_id=$1 AND m.member_type=$2 AND ${canonicalMemberIdSql()}=$3 ${activeOnly ? "AND COALESCE(m.status,'ACTIVE')='ACTIVE'" : ''} ORDER BY m.id LIMIT 1`,[siteId,parsed.role,parsed.id]);
  return rows[0] || null;
}
export async function memberReferral(member,db) {
  if(member.referred_by_member_id) {
    const {rows}=await db.query(`SELECT m.full_name AS name, COALESCE($3::text,${memberCodeSql()}) AS referral_code FROM members m WHERE m.id=$1 AND m.site_id=$2`,[member.referred_by_member_id,member.site_id,member.referred_by_member_code || null]);
    return rows[0] || null;
  }
  if(!member.referred_by_user_id)return null;
  return (await db.query('SELECT name, referral_code FROM users WHERE id=$1',[member.referred_by_user_id])).rows[0] || null;
}

// Member and broker are both commission-eligible identities. Resolve an existing
// site member by a broker code only when that same canonical person is an active
// broker elsewhere; never import a person who has no eligible record at this site.
export async function findBrokerReferral(code,siteId,db) {
  const exact = await findMemberByCode(code,siteId,db,{activeOnly:true});
  if(exact) return exact;
  const parsed=parseMemberCode(code);
  if(parsed?.role !== 'BROKER') return null;
  const {rows}=await db.query(`SELECT m.*, $3::text AS member_code FROM members m
    WHERE m.site_id=$1 AND m.member_type='MEMBER' AND COALESCE(m.status,'ACTIVE')='ACTIVE'
      AND ${canonicalMemberIdSql()}=$2
      AND EXISTS (SELECT 1 FROM members broker_identity WHERE broker_identity.member_type='BROKER'
        AND COALESCE(broker_identity.status,'ACTIVE')='ACTIVE'
        AND ${canonicalMemberIdSql('broker_identity')}=$2)
    ORDER BY m.id LIMIT 1`,[siteId,parsed.id,`BRK-${String(parsed.id).padStart(5,'0')}`]);
  return rows[0] || null;
}
