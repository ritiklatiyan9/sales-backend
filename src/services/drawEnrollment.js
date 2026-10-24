import pool from '../config/db.js';
import { openingDate, workflowError } from './drawWorkflow.js';
import { memberHasType } from './memberRoles.service.js';
import { getDrawSettings } from '../models/ProjectSettings.model.js';
import drawModel from '../models/Draw.model.js';

/** A stable identity for a named draw, while keeping its printed name readable. */
export function normalizeDrawScheme(value, fallback) {
  const raw = value === undefined || value === null || value === '' ? fallback : value;
  if (raw !== undefined && raw !== null && typeof raw !== 'string') throw workflowError('Enter a draw name such as A1 or B5');
  const name = String(raw || '').trim().replace(/\s+/g, ' ');
  if (name.length > 150) throw workflowError('Draw name must be at most 150 characters');
  return { name: name || null, key: name ? `name:${name.toUpperCase()}` : 'default' };
}

/** POST /draws' site checks, in createDraw's order. Pure; `error` is the workflowError createDraw throws. */
export function drawOpenState(setting, { waitDays, now = new Date() } = {}) {
  if (setting?.draw_enabled === false) return { open: false, reason: 'DRAW_DISABLED' };
  const required = Number(setting?.draw_required_amount || 0);
  if (!required || required <= 0) return { open: false, reason: 'NOT_CONFIGURED' };
  try {
    return { open: true, reason: null, required, scheduledDate: openingDate(setting.draw_opening_date, waitDays ?? setting.draw_wait_days, now) };
  } catch (error) {
    return { open: false, reason: setting.draw_opening_date ? 'OPENING_DATE_PASSED' : 'INVALID_DRAW_PERIOD', required, error };
  }
}

/** What the UI calls "open": the server gate plus DrawRegister's scheme name (POST /draws itself accepts none). */
export function drawAvailability(setting, options) {
  const gate = drawOpenState(setting, options);
  const scheme = normalizeDrawScheme(null, setting?.draw_scheme_name);
  return { open: gate.open && !!scheme.name, reason: gate.reason || (scheme.name ? null : 'NO_SCHEME'), scheme };
}

/** The member checks createDraw runs under its enrollment lock. Pure. */
export const clientDrawBlock = (member, siteId) =>
  !member || Number(member.site_id) !== Number(siteId) ? 'WRONG_SITE'
    : memberHasType(member, 'CLIENT') ? null : 'NOT_CLIENT';

const ENROLLING_ROLES = new Set(['super_admin', 'admin', 'sub_admin', 'agent']);
/** The /draws/new nav rule (isModuleAllowed) + POST /draws' sub-admin Create grant, from RAW
 *  user_permissions rows: hasPermission() lets admins through, the Module Show switch does not. */
export function canEnrollDraws(user, perms) {
  const p = perms || {};
  return ENROLLING_ROLES.has(user?.role)
    && p.booking_item_draws_new?.can_read !== false
    && p.booking_draws?.can_read !== false
    && (user.role !== 'sub_admin' || p.booking_draws?.can_write !== false);
}

/** Selects `draw_perms`: the viewer's raw draw rows, keyed by module. */
export const drawPermsSql = userParam => `(SELECT json_object_agg(up.module, json_build_object('can_read', up.can_read, 'can_write', up.can_write))
    FROM user_permissions up WHERE up.user_id = ${userParam} AND up.module IN ('booking_draws', 'booking_item_draws_new')) AS draw_perms`;

/** Adds draw_active = every active entry of the member at the site (what POST /draws counts) and
 *  draw_list = only those the viewer may open (agents: own network, as Draw.model list). */
export const drawEntriesLateral = (alias, siteParam, visibleParam) => `LEFT JOIN LATERAL (
    SELECT count(*)::int AS draw_active,
           COALESCE(json_agg(json_build_object('id', r.id, 'registration_no', r.registration_no, 'status', r.status,
             'slip_no', r.slip_no, 'scheme_name', r.scheme_name) ORDER BY r.id)
             FILTER (WHERE ${visibleParam}::int[] IS NULL OR r.agent_user_id = ANY(${visibleParam}::int[]) OR r.created_by = ANY(${visibleParam}::int[])), '[]'::json) AS draw_list
      FROM draw_registrations r
     WHERE r.site_id = ${siteParam} AND r.client_member_id = ${alias}.id AND r.status <> 'CANCELLED') draw_entries ON true`;

const STATE_SQL = `SELECT m.site_id, m.member_type, m.member_types, ${drawPermsSql('$3')}, draw_entries.draw_active, draw_entries.draw_list
  FROM (SELECT 1) one LEFT JOIN members m ON m.id = $2
  ${drawEntriesLateral('m', '$1', '$4')}`;

/**
 * Can this user enroll this client (or anyone, without memberId) at the site right now?
 * The caller has already run requireSiteAccess. `prefetched` = [setting, row] when the
 * caller folded draw_perms, draw_active, draw_list (+ the member's site_id/member_type/member_types) into its own query.
 */
export async function drawEnrollmentState({ db = pool, user, siteId, memberId = null, visibleUserIds = null, now = new Date(), prefetched = null }) {
  const [setting, row] = prefetched || await Promise.all([getDrawSettings(siteId),
    db.query(STATE_SQL, [siteId, memberId, user.id, visibleUserIds]).then(({ rows }) => rows[0])]);
  const { open, reason, scheme } = drawAvailability(setting, { now });
  // ponytail: findActiveEnrollment stays the one "already enrolled" rule; it costs a round trip only for clients holding entries.
  const current = memberId && row?.draw_active
    ? await drawModel.findActiveEnrollment({ siteId, clientMemberId: memberId, ...scheme }, db) : null;
  return {
    open, reason, can_enroll: canEnrollDraws(user, row?.draw_perms),
    scheme_name: scheme.name, opening_date: setting?.draw_opening_date || '',
    client_block: memberId ? clientDrawBlock(row?.site_id == null ? null : row, siteId) : null,
    enrolled: !!current, entry_count: current ? Number(current.entry_count) || 1 : 0,
    entries: memberId ? row?.draw_list || [] : [],
  };
}
