import { canonicalMemberIdSql, findBrokerReferral, parseMemberCode } from './memberCodes.js';
import { workflowError } from './drawWorkflow.js';
import { memberHasType } from './memberRoles.service.js';

/**
 * Dealer teams (migration 038). Dealers are Members brokers identified by their
 * BRK code (canonical broker id); they have no logins. Staff enter the broker code
 * when enrolling a client in a draw, which is how money and clients trace back.
 */
export const brokerCode = (brokerId) => `BRK-${String(brokerId).padStart(5, '0')}`;

/**
 * Dealers of the given teams with per-site counts. A booking is a plot at the
 * selected site whose "Booking by" is this dealer (Accounting's dealer field — the
 * booking app writes the same field), any committed status except COMPANY.
 * ponytail: name match on booking_by; a broker-id column on plots would be exact.
 */
export async function listDealers(teamIds, siteId, db) {
  if (!teamIds.length) return [];
  const { rows } = await db.query(`
    SELECT td.broker_id, td.member_id, td.team_id, td.parent_broker_id, td.joined_at,
           m.full_name AS name, m.phone, m.photo, COALESCE(m.status, 'ACTIVE') AS status, ${canonicalMemberIdSql('m')} AS code_id
      FROM team_dealers td JOIN members m ON m.id = td.member_id
     WHERE td.team_id = ANY($1::int[])
     ORDER BY td.team_id, td.parent_broker_id NULLS FIRST, m.full_name, td.broker_id`, [teamIds.map(Number)]);
  const bookings = new Map(), draws = new Map(), names = new Map();
  if (siteId && rows.length) {
    // One scan each: the names on the dealer's registrations, the
    // site's plots grouped by "Booking by", and the site's draws grouped by broker.
    const codeIds = [...new Set(rows.map((row) => row.code_id))];
    const [named, plots, drawn] = await Promise.all([
      db.query(`SELECT ${canonicalMemberIdSql('x')} AS code_id, UPPER(TRIM(x.full_name)) AS name FROM members x
        WHERE 'BROKER' = ANY(COALESCE(x.member_types, ARRAY[x.member_type])) AND ${canonicalMemberIdSql('x')} = ANY($1::int[])`, [codeIds]),
      db.query(`SELECT UPPER(TRIM(booking_by)) AS name, count(*)::int AS n FROM plots
        WHERE site_id = $1 AND booking_by IS NOT NULL AND UPPER(TRIM(COALESCE(status, ''))) NOT IN ('', 'AVAILABLE', 'COMPANY', 'CANCELLED')
        GROUP BY 1`, [Number(siteId)]),
      db.query(`SELECT broker_id, count(*)::int AS n FROM draw_registrations
        WHERE site_id = $1 AND broker_id IS NOT NULL AND status <> 'CANCELLED' GROUP BY 1`, [Number(siteId)]),
    ]);
    for (const p of plots.rows) bookings.set(p.name, p.n);
    for (const d of drawn.rows) draws.set(Number(d.broker_id), d.n);
    for (const { code_id: codeId, name } of named.rows) {
      if (!names.has(codeId)) names.set(codeId, new Set());
      names.get(codeId).add(name);
    }
  }
  return rows.map(({ code_id: codeId, ...row }) => ({
    ...row, code: brokerCode(row.broker_id),
    booking_count: [...(names.get(codeId) || [])].reduce((sum, name) => sum + (bookings.get(name) || 0), 0),
    draw_count: draws.get(row.broker_id) || 0,
  }));
}

/** An active Members broker row → its canonical broker id (the number in BRK-xxxxx). */
export async function brokerFromMember(memberId, db) {
  const { rows } = await db.query(
    `SELECT m.id, m.full_name, m.member_type, m.member_types, COALESCE(m.status, 'ACTIVE') AS status, ${canonicalMemberIdSql('m')} AS broker_id
       FROM members m WHERE m.id = $1`, [Number(memberId)]);
  const row = rows[0];
  if (!row || !memberHasType(row, 'BROKER')) throw workflowError('Select a broker from Members', 400);
  if (row.status !== 'ACTIVE') throw workflowError(`${row.full_name} is not an active broker`, 409);
  return { ...row, broker_id: Number(row.broker_id) };
}

/** True when candidate sits inside brokerId's own branch (moving there would loop). */
export async function isInBranch(brokerId, candidateId, db) {
  const { rows } = await db.query(`
    WITH RECURSIVE branch AS (
      SELECT broker_id FROM team_dealers WHERE broker_id = $1
      UNION ALL
      SELECT td.broker_id FROM team_dealers td JOIN branch b ON td.parent_broker_id = b.broker_id
    ) SELECT 1 FROM branch WHERE broker_id = $2 LIMIT 1`, [Number(brokerId), Number(candidateId)]);
  return rows.length > 0;
}

/** Draw enrollment must name the broker (dealer) who brought the client. */
export async function resolveDrawBroker(code, siteId, db) {
  const parsed = parseMemberCode(code);
  if (parsed?.role !== 'BROKER') throw workflowError('Enter the broker code of the dealer who brought this client, for example BRK-00002');
  const row = await findBrokerReferral(code, siteId, db);
  if (!row) throw workflowError('This broker code is invalid, inactive or not available for this site');
  return { broker_id: parsed.id, broker_member_id: row.id, broker_code: brokerCode(parsed.id) };
}
