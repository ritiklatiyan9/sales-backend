import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { getVisibleUserIds } from '../services/agentNetwork.service.js';
import { requireSiteAccess } from '../services/bookingWorkspaceAccess.js';
import { canonicalMemberIdSql, memberCodeSql } from '../services/memberCodes.js';
import { memberHasType, memberTypesSql } from '../services/memberRoles.service.js';
import { getDrawSettings } from '../models/ProjectSettings.model.js';
import { drawEnrollmentState, drawEntriesLateral, drawPermsSql } from '../services/drawEnrollment.js';
import { signMemberDocumentUrl } from '../utils/memberDocumentUrls.js';
import {
  allInOrder, clientRegistryError, identityDocsSql, kycVerifiedSql, maskClientIdentity, memberPhoneSql,
  missingIdentityDocuments, normalizeClientPhone, requireClientRegistryPermission, uploadCaseLateral,
} from '../services/clientRegistry.service.js';

/**
 * Always one row, so an unknown number still returns the viewer's draw grants.
 * $1 site, $2 normalized phone | member id, $3 visibleUserIds | null, $4 viewer.
 * A verified member is described by its newest VERIFIED case; anyone else by the case
 * their next upload lands in, so the checklist matches where documents will go.
 */
const lookupSql = byPhone => `
  SELECT m.id, m.site_id, m.full_name, ${memberPhoneSql('m')} AS phone, m.city, m.photo, m.member_type,
         ${memberTypesSql('m')} AS member_types, m.created_at, m.aadhar_no, m.pan_no,
         ${canonicalMemberIdSql('m')}::int AS code_id,
         COALESCE(broker.full_name, u.name) AS referred_by_name,
         CASE WHEN broker.id IS NOT NULL THEN COALESCE(m.referred_by_member_code, ${memberCodeSql('broker')}) ELSE u.referral_code END AS referred_by_code,
         ${kycVerifiedSql('m')} AS kyc_verified,
         COALESCE(verified_case.id, upload_case.id) AS case_id, COALESCE(verified_case.status, upload_case.status) AS case_status,
         docs.aadhaar_front, docs.aadhaar_back, docs.pan,
         ${drawPermsSql('$4')}, draw_entries.draw_active, draw_entries.draw_list
    FROM (SELECT 1) one
    LEFT JOIN LATERAL (
      SELECT c.id, c.site_id, c.full_name, c.phone, c.city, c.photo, c.member_type, c.member_types, c.created_at,
             c.aadhar_no, c.pan_no, c.referred_by_user_id, c.referred_by_member_id, c.referred_by_member_code
        FROM members c
       WHERE c.site_id = $1 AND ${byPhone ? `${memberPhoneSql('c')} = $2` : 'c.id = $2'}
       ORDER BY c.id DESC LIMIT 1) m ON true
    LEFT JOIN users u ON u.id = m.referred_by_user_id
    LEFT JOIN members broker ON broker.id = m.referred_by_member_id AND broker.site_id = m.site_id
    LEFT JOIN LATERAL (
      SELECT kv.id, kv.status FROM kyc_cases kv
       WHERE kv.client_member_id = m.id AND kv.site_id = m.site_id AND kv.status = 'VERIFIED'
       ORDER BY kv.id DESC LIMIT 1) verified_case ON true
    ${uploadCaseLateral('m', '$3')}
    LEFT JOIN LATERAL (${identityDocsSql('COALESCE(verified_case.id, upload_case.id)')}) docs ON true
    ${drawEntriesLateral('m', '$1', '$3')}`;

/**
 * GET /clients/lookup?site_id=&phone= | &id= — "is this number already a client?" in one
 * screen: registration state, the KYC checklist and the server-decided Lucky Draw block.
 * Masked, minimal payload: no full Aadhaar/PAN, email, address or document URLs.
 */
export const lookupClient = asyncHandler(async (req, res) => {
  const byPhone = req.query.phone !== undefined && req.query.phone !== '';
  if (byPhone === (req.query.id !== undefined && req.query.id !== '')) throw clientRegistryError('Send either phone or id');
  const id = byPhone ? null : Number(req.query.id);
  if (!byPhone && !(Number.isSafeInteger(id) && id > 0)) throw clientRegistryError('Enter a valid client ID');
  // Exact match on the registry index: a typed prefix never enumerates the site's members.
  const key = byPhone ? normalizeClientPhone(req.query.phone, { required: true, strict: true }) : id;
  const siteId = Number(req.query.site_id);
  const visible = getVisibleUserIds(req.user); // null for admin roles; the upload case and entries follow it
  // One round trip for gates + reads; the member row is only sent once every gate has passed.
  const [, site, visibleUserIds, setting, { rows: [row] }] = await allInOrder([
    requireClientRegistryPermission(req.user),
    requireSiteAccess(req.user, siteId),
    visible,
    getDrawSettings(siteId),
    visible.then(ids => pool.query(lookupSql(byPhone), [siteId, key, ids, req.user.id])),
  ]);
  if (!byPhone && !row.id) throw clientRegistryError('Client not found at this site', 404);
  const draw = await drawEnrollmentState({ user: req.user, siteId: site.id, memberId: row.id, visibleUserIds, prefetched: [setting, row] });
  res.set('Cache-Control', 'private, no-store');
  if (!row.id) return res.json({ state: 'NEW', phone: key, client: null, kyc: null, draw });
  const isClient = memberHasType(row, 'CLIENT');
  const verified = row.kyc_verified === true;
  const documents = { aadhaar_front: row.aadhaar_front, aadhaar_back: row.aadhaar_back, pan: row.pan };
  res.json({
    state: !isClient ? 'NEW' : verified ? 'REGISTERED' : 'KYC_PENDING',
    phone: byPhone ? key : row.phone || null,
    client: {
      id: row.id, code_id: row.code_id, site_id: row.site_id, full_name: row.full_name, phone: row.phone || null,
      city: row.city || null, photo: await signMemberDocumentUrl(row.photo) || null,
      member_type: row.member_type, member_types: row.member_types, is_client: isClient, registered_at: row.created_at,
      referred_by_name: row.referred_by_name || null, referred_by_code: row.referred_by_code || null,
      aadhaar_last4: String(row.aadhar_no || '').replace(/\D/g, '').slice(-4) || null,
      pan_masked: maskClientIdentity({ pan_no: row.pan_no }).pan_no,
    },
    kyc: {
      case_id: row.case_id ?? null, status: verified ? 'VERIFIED' : row.case_status ?? null, verified,
      documents, missing: verified ? [] : missingIdentityDocuments(documents),
    },
    draw,
  });
});

// $1 site. scheme mirrors normalizeDrawScheme; the entry test is Draw.model findActiveEnrollment's.
// ponytail: awaiting_draw is limited to clients created in the last 30 days: unscoped it is nearly every
// verified client (271 of 273 at site 7), which nobody can act on. Add a "mine" scope when asked.
const OVERVIEW_SQL = `
  WITH day AS (SELECT date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata' AS start),
  scheme AS (
    SELECT CASE WHEN s.name = '' THEN 'default' ELSE 'name:' || upper(s.name) END AS key, upper(s.name) AS name
      FROM (SELECT btrim(regexp_replace(COALESCE((SELECT draw_scheme_name FROM project_settings WHERE site_id = $1), ''), '\\s+', ' ', 'g')) AS name) s),
  clients AS (
    SELECT m.id, m.created_at, ${kycVerifiedSql('m')} AS verified
      FROM members m WHERE m.site_id = $1 AND 'CLIENT' = ANY(${memberTypesSql('m')}))
  SELECT count(*) FILTER (WHERE c.created_at >= day.start)::int AS registered_today,
         count(*) FILTER (WHERE NOT c.verified)::int AS pending_kyc,
         count(*) FILTER (WHERE c.verified AND c.created_at >= now() - interval '30 days' AND NOT EXISTS (
           SELECT 1 FROM draw_registrations r
            WHERE r.site_id = $1 AND r.client_member_id = c.id AND r.status <> 'CANCELLED'
              AND (r.enrollment_key = scheme.key OR left(r.enrollment_key, length(scheme.key) + 7) = scheme.key || '#ENTRY-'
                   OR (r.enrollment_key IS NULL AND upper(regexp_replace(btrim(COALESCE(r.scheme_name, '')), '\\s+', ' ', 'g')) = scheme.name))))::int AS awaiting_draw
    FROM clients c, day, scheme`;

/** GET /clients/overview?site_id= — Home's "Today at <site>" counts + server-decided draw availability. */
export const clientOverview = asyncHandler(async (req, res) => {
  const siteId = Number(req.query.site_id);
  const [, site, draw, { rows: [counts] }] = await allInOrder([
    requireClientRegistryPermission(req.user),
    requireSiteAccess(req.user, siteId),
    drawEnrollmentState({ user: req.user, siteId }),
    pool.query(OVERVIEW_SQL, [siteId]),
  ]);
  res.set('Cache-Control', 'private, no-store');
  res.json({
    site_id: site.id, registered_today: counts.registered_today, pending_kyc: counts.pending_kyc,
    awaiting_draw: draw.open && draw.can_enroll ? counts.awaiting_draw : null,
    draw: { open: draw.open, reason: draw.reason, can_enroll: draw.can_enroll, scheme_name: draw.scheme_name, opening_date: draw.opening_date },
    generated_at: new Date().toISOString(),
  });
});
