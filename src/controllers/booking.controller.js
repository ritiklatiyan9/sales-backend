import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import bookingModel from '../models/Booking.model.js';
import kycCaseModel from '../models/KycCase.model.js';
import { deleteKycDocument, getKycDocumentUrl, uploadKycDocument, getPublicKycUrl } from '../utils/s3.js';
import { syncPlotBookingToAccounting } from '../services/plotBookingSync.js';
import { syncTokenPayment } from '../services/tokenPaymentSync.js';
import { buildVerifyUrl, ReceiptType } from '../utils/receiptToken.js';
import { isAdminRole, getVisibleUserIds } from '../services/agentNetwork.service.js';

// Token-payment capture fields a booking may set (mirror of the accounting plot-payment
// taking fields). Stored on the booking and propagated to plot_payments by tokenPaymentSync.
const TOKEN_PAYMENT_FIELDS = [
  'token_payment_from', 'token_payment_date', 'token_bank_name', 'token_branch',
  'token_bank_details', 'token_cheque_no', 'token_narration', 'token_received_by',
];

/**
 * Member columns a CLIENT record may set from the booking module. These all already
 * exist on the shared accounting `members` table — we only ever write the subset a
 * user supplies, and never touch member_type/site beyond create. Keeps every field
 * that the printable booking form / AddClient.jsx renders editable from the Members
 * screen — a field missing here silently never persists no matter what the UI shows.
 */
const CLIENT_FIELDS = [
  'full_name', 'father_name', 'mother_name', 'spouse_name', 'gender', 'date_of_birth',
  'nationality', 'religion', 'marital_status', 'qualification', 'occupation', 'company_name',
  'blood_group', 'caste', 'anniversary_date',
  'phone', 'alt_phone', 'whatsapp', 'email',
  'emergency_contact_name', 'emergency_contact_phone', 'emergency_contact_relation',
  'address', 'permanent_address', 'city', 'state', 'pincode',
  'aadhar_no', 'pan_no', 'voter_id', 'passport_no', 'driving_license_no', 'gst_no', 'tin_no',
  'bank_name', 'account_no', 'ifsc_code', 'branch',
  'co_applicant_name', 'co_applicant_relation', 'co_applicant_dob', 'co_applicant_gender',
  'co_applicant_phone', 'co_applicant_email', 'co_applicant_aadhar', 'co_applicant_pan',
  'co_applicant_address',
  'nominee_name', 'nominee_relation', 'nominee_phone', 'reference', 'notes', 'photo',
];

// Normalise '' → null so optional date/number-ish columns don't choke on empty strings.
const clean = (v) => (v === '' ? null : v);

/**
 * A draw-allotted booking that gets cancelled/deleted must release its allotment:
 * the draw registration returns to WINNER (still a winner, shop freed) so the unit
 * can be re-allotted — otherwise ALLOTTED is a dead-end pointing at a dead booking.
 * Best-effort: tolerates deploys where migration 011 hasn't run (42P01).
 */
const revertDrawAllotment = async (bookingId, actorId) => {
  try {
    const { rows } = await pool.query(
      `UPDATE draw_registrations
          SET status = 'WINNER', allotted_plot_id = NULL, allotted_at = NULL,
              allotted_by = NULL, booking_id = NULL, updated_at = now()
        WHERE booking_id = $1 AND status = 'ALLOTTED'
        RETURNING id`,
      [bookingId]
    );
    for (const r of rows) {
      await pool.query(
        `INSERT INTO draw_events (draw_registration_id, event_type, detail, actor_user_id)
         VALUES ($1, 'ALLOTMENT_REVERTED', $2, $3)`,
        [r.id, JSON.stringify({ booking_id: Number(bookingId) }), actorId || null]
      ).catch(() => { /* audit is best-effort here */ });
    }
    return rows.length;
  } catch (err) {
    if (err?.code !== '42P01') console.error('[booking] draw-allotment revert failed:', err.message);
    return 0;
  }
};

/** GET /bookings?site_id=&status=&kyc_status=&q=&client_member_id=
 * Visibility is role-scoped server-side: admins see everything; agents/team heads
 * see only bookings owned by (or created by) users inside their own network. */
export const listBookings = asyncHandler(async (req, res) => {
  const { site_id, status, kyc_status, q, client_member_id, agent_user_id } = req.query;
  const visibleUserIds = await getVisibleUserIds(req.user); // null = unrestricted
  const rows = await bookingModel.list(
    { siteId: site_id, status, kycStatus: kyc_status, q, clientMemberId: client_member_id, agentUserId: agent_user_id, visibleUserIds },
    pool
  );
  res.json(rows);
});

/**
 * GET /bookings/dashboard?site_id=&days=
 * Single aggregated payload for the dashboard — replaces the old pattern of shipping
 * the full 500-row bookings list (with 3 correlated subqueries per row) to the browser
 * and aggregating client-side. All aggregates run as set-based SQL, in parallel; the
 * response is a few KB regardless of booking volume.
 *
 * Role-scoped: admins see the whole site; agents/team heads see only bookings (and
 * KYC cases) owned by or created within their own network — the same visibility rule
 * listBookings/getBooking already enforce, applied here to every aggregate so an
 * agent's dashboard reflects their own work instead of the whole site's.
 */
export const getDashboard = asyncHandler(async (req, res) => {
  const siteId = Number(req.query.site_id);
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });
  const days = Math.min(90, Math.max(7, Number(req.query.days) || 14));

  const visibleUserIds = await getVisibleUserIds(req.user); // null = admin, unrestricted
  const scoped = Array.isArray(visibleUserIds);
  // Ownership filter applied to every booking-derived aggregate below. $2 (or $3 where
  // a query already uses $2 for something else) is always the visibleUserIds array.
  const bookingScope = (alias, param) => (scoped ? `AND (${alias}.agent_user_id = ANY($${param}) OR ${alias}.created_by = ANY($${param}))` : '');
  // Mirrors KycCase.model.js list()'s visibility clause: a case is "mine" if I created
  // it directly, OR I own/created the booking it's since been adopted into.
  const kycScope = (caseAlias, bookingAlias, param) => (scoped
    ? `AND (${caseAlias}.created_by = ANY($${param}) OR ${bookingAlias}.agent_user_id = ANY($${param}) OR ${bookingAlias}.created_by = ANY($${param}))`
    : '');

  const recentSelect = `
    SELECT b.id, b.booking_no, b.status, b.kyc_status, b.booking_date, b.created_at,
           b.token_amount, b.booked_by, b.buyer_name,
           m.full_name AS client_name, m.photo AS client_photo,
           p.plot_no, p.block AS plot_block
    FROM bookings b
    LEFT JOIN members m ON m.id = b.client_member_id
    LEFT JOIN plots   p ON p.id = b.plot_id
    WHERE b.site_id = $1 ${bookingScope('b', 2)}`;

  const kpiParams = scoped ? [siteId, visibleUserIds] : [siteId];
  const docsParams = scoped ? [siteId, visibleUserIds] : [siteId];
  const distParams = scoped ? [siteId, visibleUserIds] : [siteId];
  const trendParams = scoped ? [siteId, days, visibleUserIds] : [siteId, days];
  const listParams = scoped ? [siteId, visibleUserIds] : [siteId];
  const activityParams = scoped ? [siteId, visibleUserIds] : [siteId];
  const myKycParams = scoped ? [siteId, visibleUserIds] : [siteId];

  const [kpi, docs, dist, trend, recent, queue, topExec, activity, myKyc] = await Promise.all([
    pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'CANCELLED' OR kyc_status = 'REJECTED')::int AS rejected,
              count(*) FILTER (WHERE (kyc_status = 'VERIFIED' OR status = 'CONFIRMED')
                               AND status <> 'CANCELLED' AND kyc_status <> 'REJECTED')::int AS verified,
              count(*) FILTER (WHERE booking_date >= now()::date)::int AS today,
              count(*) FILTER (WHERE booking_date >= now()::date - 6)::int AS this_week,
              count(*) FILTER (WHERE booking_date >= now()::date - 13
                               AND booking_date <  now()::date - 6)::int AS prev_week,
              count(*) FILTER (WHERE status NOT IN ('CANCELLED','CONFIRMED')
                               AND kyc_status NOT IN ('VERIFIED','REJECTED')
                               AND booking_date < now()::date - 3)::int AS stale,
              COALESCE(SUM(token_amount), 0)::float AS token_total,
              COALESCE(SUM(token_amount) FILTER (WHERE booking_date >= date_trunc('month', now())), 0)::float AS token_month,
              COALESCE(SUM(token_amount) FILTER (WHERE booking_date >= date_trunc('month', now()) - interval '1 month'
                                                 AND booking_date < date_trunc('month', now())), 0)::float AS token_prev_month
       FROM bookings b WHERE b.site_id = $1 ${bookingScope('b', 2)}`,
      kpiParams
    ),
    pool.query(
      `SELECT count(*)::int AS docs,
              count(*) FILTER (WHERE d.ocr_status = 'DONE')::int AS ocr_done,
              count(*) FILTER (WHERE d.ocr_status IN ('PENDING','PROCESSING'))::int AS ocr_pending,
              count(*) FILTER (WHERE d.ocr_status = 'FAILED')::int AS ocr_failed
       FROM documents d
       LEFT JOIN kyc_cases k ON k.id = d.kyc_case_id
       LEFT JOIN bookings  b ON b.id = k.booking_id
       WHERE d.site_id = $1 ${scoped ? `AND (k.created_by = ANY($2) OR b.agent_user_id = ANY($2) OR b.created_by = ANY($2))` : ''}`,
      docsParams
    ),
    pool.query(
      `SELECT COALESCE(kyc_status, 'NOT_STARTED') AS key, count(*)::int AS value
       FROM bookings b WHERE b.site_id = $1 ${bookingScope('b', 2)} GROUP BY 1`,
      distParams
    ),
    pool.query(
      `SELECT to_char(d, 'YYYY-MM-DD') AS key,
              count(b.id)::int AS submitted,
              count(b.id) FILTER (WHERE b.kyc_status = 'VERIFIED' OR b.status = 'CONFIRMED')::int AS verified,
              COALESCE(SUM(b.token_amount), 0)::float AS token
       FROM generate_series(now()::date - ($2::int - 1), now()::date, interval '1 day') AS d
       LEFT JOIN bookings b ON b.site_id = $1 AND b.booking_date::date = d::date ${bookingScope('b', 3)}
       GROUP BY d ORDER BY d`,
      trendParams
    ),
    pool.query(`${recentSelect} ORDER BY b.created_at DESC LIMIT 8`, listParams),
    pool.query(
      `${recentSelect}
         AND b.status NOT IN ('CANCELLED','CONFIRMED')
         AND b.kyc_status NOT IN ('VERIFIED','REJECTED')
       ORDER BY b.booking_date ASC NULLS LAST, b.created_at ASC LIMIT 5`,
      listParams
    ),
    // Site-wide leaderboard — admin only; meaningless once scoped to a single agent.
    scoped ? Promise.resolve({ rows: [] }) : pool.query(
      `SELECT booked_by AS name, count(*)::int AS bookings, COALESCE(SUM(token_amount), 0)::float AS token
       FROM bookings
       WHERE site_id = $1 AND booked_by IS NOT NULL AND booking_date >= date_trunc('month', now())
       GROUP BY booked_by ORDER BY bookings DESC, token DESC LIMIT 1`,
      [siteId]
    ),
    pool.query(
      `SELECT * FROM (
         SELECT 'CREATED' AS kind, b.created_at AS at, b.id, b.booking_no,
                m.full_name AS client_name, NULL AS detail
         FROM bookings b LEFT JOIN members m ON m.id = b.client_member_id
         WHERE b.site_id = $1 ${bookingScope('b', 2)}
         UNION ALL
         SELECT 'VERIFIED', k.verified_at, b.id, b.booking_no, m.full_name, NULL
         FROM kyc_cases k
         JOIN bookings b ON b.id = k.booking_id
         LEFT JOIN members m ON m.id = b.client_member_id
         WHERE b.site_id = $1 AND k.verified_at IS NOT NULL ${bookingScope('b', 2)}
         UNION ALL
         SELECT 'OCR_DONE', d.ocr_completed_at, b.id, b.booking_no, m.full_name, d.type
         FROM documents d
         JOIN kyc_cases k ON k.id = d.kyc_case_id
         JOIN bookings b ON b.id = k.booking_id
         LEFT JOIN members m ON m.id = b.client_member_id
         WHERE b.site_id = $1 AND d.ocr_status = 'DONE' AND d.ocr_completed_at IS NOT NULL ${bookingScope('b', 2)}
       ) ev
       WHERE ev.at IS NOT NULL
       ORDER BY ev.at DESC LIMIT 20`,
      activityParams
    ),
    // Member-first KYC pipeline (agent's primary workflow) — covers cases that have no
    // booking yet, which the booking-derived aggregates above never see.
    pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE k.status NOT IN ('VERIFIED','REJECTED'))::int AS pending,
              count(*) FILTER (WHERE k.status = 'VERIFIED')::int AS verified,
              count(*) FILTER (WHERE k.booking_id IS NULL)::int AS not_booked
       FROM kyc_cases k
       LEFT JOIN bookings b ON b.id = k.booking_id
       WHERE k.site_id = $1 ${kycScope('k', 'b', 2)}`,
      myKycParams
    ),
  ]);

  res.json({
    kpi: kpi.rows[0],
    docs: docs.rows[0],
    distribution: dist.rows,
    trend: trend.rows,
    recent: recent.rows,
    queue: queue.rows,
    top_executive: topExec.rows[0] || null,
    activity: activity.rows,
    my_kyc: myKyc.rows[0],
    scoped,
    days,
    generated_at: new Date().toISOString(),
  });
});

/** POST /bookings — admin roles only (agents do KYC; they never create bookings). */
export const createBooking = asyncHandler(async (req, res) => {
  if (!isAdminRole(req.user?.role)) {
    return res.status(403).json({ message: 'Only admins can create bookings. Agents handle KYC only.' });
  }

  const {
    site_id, plot_id, client_member_id,
    sale_price, token_amount, payment_plan,
    booking_date, buyer_name, notes, booking_agent_id, referral_code,
  } = req.body;

  if (!site_id) return res.status(400).json({ message: 'site_id is required' });
  if (!client_member_id) return res.status(400).json({ message: 'client_member_id is required' });

  // Optional token-payment capture fields (only what the form supplied; '' → null).
  const tokenData = {};
  for (const f of TOKEN_PAYMENT_FIELDS) {
    if (req.body[f] !== undefined) tokenData[f] = clean(req.body[f]);
  }

  // Referral attribution, strongest signal first:
  //  1. An explicit referral_code (printed on the customer's KYC form and OCR'd or
  //     typed at booking time) — PER-BOOKING attribution, so the same customer can be
  //     brought back by a different agent for their next plot.
  //  2. members.referred_by_user_id — the agent who first added this customer's number.
  //  3. members.created_by, when that creator is an agent (legacy rows).
  let ownership = {};
  let referral_source = null;
  if (referral_code) {
    const code = String(referral_code).trim().toUpperCase();
    const { rows } = await pool.query(
      'SELECT id, team_id, name, referral_code FROM users WHERE upper(referral_code) = $1 AND is_active = true',
      [code]
    );
    if (!rows[0]) {
      return res.status(400).json({ message: `Referral code ${code} does not match any active agent` });
    }
    ownership = { agent_user_id: rows[0].id, team_id: rows[0].team_id || null };
    referral_source = 'form';
  } else {
    const { rows: memberRows } = await pool.query(
      `SELECT m.referred_by_user_id, m.created_by,
              ru.id AS ref_id, ru.team_id AS ref_team, ru.role AS ref_role,
              cu.id AS cre_id, cu.team_id AS cre_team, cu.role AS cre_role
         FROM members m
         LEFT JOIN users ru ON ru.id = m.referred_by_user_id
         LEFT JOIN users cu ON cu.id = m.created_by
        WHERE m.id = $1`,
      [client_member_id]
    );
    const mem = memberRows[0];
    if (mem?.ref_id) {
      ownership = { agent_user_id: mem.ref_id, team_id: mem.ref_team || null };
      referral_source = 'member';
    } else if (mem?.cre_id && !isAdminRole(mem.cre_role)) {
      ownership = { agent_user_id: mem.cre_id, team_id: mem.cre_team || null };
      referral_source = 'member';
    }
  }

  const created = await bookingModel.create({
    site_id,
    plot_id: plot_id || null,
    client_member_id,
    ...ownership,
    sale_price: sale_price || 0,
    token_amount: token_amount || 0,
    payment_plan: payment_plan || 'FULL',
    booking_date: booking_date || new Date().toISOString().slice(0, 10),
    status: 'KYC_PENDING',
    kyc_status: 'NOT_STARTED',
    buyer_name: buyer_name || null,
    booked_by: req.user?.email || null,
    booking_agent_id: booking_agent_id ? parseInt(booking_agent_id) : null,
    notes: notes || null,
    created_by: req.user?.id || null,
    ...tokenData,
  }, pool);

  const booking_no = await bookingModel.generateBookingNo(created.id, created.booking_date, pool);

  // Adopt the customer's pre-existing KYC (member-anchored or stranded on CANCELLED
  // bookings) so a re-booking never restarts KYC from zero; opens a fresh case if none.
  const adoptedCount = await kycCaseModel.adoptForBooking(created, pool);

  // Propagate to the accounting plot ledger (BOOKED + buyer + Booking By + commission).
  // Fire-and-forget semantics: a sync failure must never fail the booking itself.
  let plot_sync = null;
  if (created.plot_id) {
    plot_sync = await syncPlotBookingToAccounting(created, pool);
  }

  // Mirror the token amount into the accounting plot_payments ledger (runs AFTER the
  // plot sync so plots.booking_by is populated for the payment's "Booked By").
  const token_sync = await syncTokenPayment(created, pool);

  // Re-read: the adoption rollup above may have advanced status/kyc_status.
  const fresh = adoptedCount ? await bookingModel.findById(created.id, pool) : created;
  res.status(201).json({ ...fresh, booking_no, plot_sync, token_sync, referral_source });
});

/** GET /bookings/:id  → booking + kyc cases + documents (with latest OCR result) */
export const getBooking = asyncHandler(async (req, res) => {
  const booking = await bookingModel.getDetail(req.params.id, pool);
  if (!booking) return res.status(404).json({ message: 'Booking not found' });

  // Network scoping: non-admins may only open bookings inside their own hierarchy.
  const visibleUserIds = await getVisibleUserIds(req.user);
  if (visibleUserIds && !visibleUserIds.includes(booking.agent_user_id) && !visibleUserIds.includes(booking.created_by)) {
    return res.status(403).json({ message: 'You are not authorised to view this booking' });
  }

  const cases = await kycCaseModel.findByBooking(booking.id, pool);
  for (const c of cases) {
    c.documents = await kycCaseModel.getDocumentsWithResults(c.id, pool);
    // Resolve a viewable URL per document (same helper the KYC endpoints use).
    for (const d of c.documents) {
      try { d.file_url = await getKycDocumentUrl(d.file_path); } catch { /* leave undefined */ }
    }
  }

  // Signed verify URL for the printed Booking / Agreement QR. Same scheme + secret as the
  // accounting receipts, so it validates on the public Defence Garden verify page. Mirrors
  // the PLOT receipt payload shape (plot.controller.js) — points at the token payment when
  // one exists, so the QR ties to the real plot_payments ledger entry.
  const verifyUrl = buildVerifyUrl({
    t: ReceiptType.PLOT,
    i: booking.token_payment_id || booking.id,
    pn: booking.client_name || booking.buyer_name || null,
    pl: [booking.plot_block, booking.plot_no].filter(Boolean).join(' ') || null,
    a: Number(booking.token_amount) || 0,
    d: booking.booking_date || null,
    pm: booking.token_payment_from || null,
    sn: booking.site_name || null,
    sy: booking.site_city || null,
    ss: booking.site_state || null,
  });

  res.json({ ...booking, kyc_cases: cases, verifyUrl });
});

/** PUT /bookings/:id — editable fields only. Admin roles only. */
export const updateBooking = asyncHandler(async (req, res) => {
  if (!isAdminRole(req.user?.role)) {
    return res.status(403).json({ message: 'Only admins can edit bookings' });
  }
  const allowed = ['plot_id', 'sale_price', 'token_amount', 'payment_plan', 'status', 'buyer_name', 'notes', 'booking_date', 'booking_agent_id', ...TOKEN_PAYMENT_FIELDS];
  const data = {};
  for (const k of allowed) if (req.body[k] !== undefined) data[k] = req.body[k];
  if (!Object.keys(data).length) return res.status(400).json({ message: 'No editable fields provided' });
  if (data.booking_agent_id !== undefined) data.booking_agent_id = data.booking_agent_id ? parseInt(data.booking_agent_id) : null;
  // Empty date string would violate the DATE column — normalise '' → null.
  for (const f of TOKEN_PAYMENT_FIELDS) if (data[f] === '') data[f] = null;

  const updated = await bookingModel.update(req.params.id, data, pool);
  if (!updated) return res.status(404).json({ message: 'Booking not found' });

  // Re-sync the accounting plot when a plot is assigned/changed or the agent override
  // changes (so assigning a plot later, or correcting the agent, books it accordingly).
  let plot_sync = null;
  const touchesSync = data.plot_id !== undefined || data.booking_agent_id !== undefined || data.booking_date !== undefined;
  if (updated.plot_id && updated.status !== 'CANCELLED' && touchesSync) {
    plot_sync = await syncPlotBookingToAccounting(updated, pool);
  }

  // Always reconcile the token payment — token-only edits don't trip touchesSync above,
  // and a CANCELLED/zeroed/plot-removed booking must drop its still-pending payment.
  const token_sync = await syncTokenPayment(updated, pool);

  res.json({ ...updated, plot_sync, token_sync });
});

/** POST /bookings/:id/cancel — status change only (no deletion). Admin roles only. */
export const cancelBooking = asyncHandler(async (req, res) => {
  if (!isAdminRole(req.user?.role)) {
    return res.status(403).json({ message: 'Only admins can cancel bookings' });
  }
  const updated = await bookingModel.update(req.params.id, { status: 'CANCELLED' }, pool);
  if (!updated) return res.status(404).json({ message: 'Booking not found' });
  // Drop the still-pending token payment (CANCELLED ⇒ removal path). Approved rows kept.
  const token_sync = await syncTokenPayment(updated, pool);
  // If this booking came from a draw allotment, free the allotment (draw → WINNER).
  const draw_reverted = await revertDrawAllotment(updated.id, req.user?.id);
  res.json({ ...updated, token_sync, draw_reverted });
});

/**
 * DELETE /bookings/:id — permanently delete a booking.
 * SAFE: only touches booking-module tables. The DB cascade removes this booking's
 * kyc_cases → documents → ocr_results; the linked member/plot are NOT affected
 * (those FKs are SET NULL/RESTRICT and point outward). Uploaded files are cleaned first.
 */
export const deleteBooking = asyncHandler(async (req, res) => {
  if (!isAdminRole(req.user?.role)) {
    return res.status(403).json({ message: 'Only admins can delete bookings' });
  }
  const { id } = req.params;
  const booking = await bookingModel.findById(id, pool);
  if (!booking) return res.status(404).json({ message: 'Booking not found' });

  // KYC belongs to the CUSTOMER, not the booking: detach the booking's cases (with
  // their documents intact) back to member-anchored cases instead of letting the FK
  // cascade destroy an agent's verified KYC. A future booking re-adopts them. Empty
  // OPEN shells (the auto-created case nobody uploaded to) cascade away with the
  // booking — detaching those would just pile up invisible orphans.
  const { rows: detached } = await pool.query(
    `UPDATE kyc_cases k SET booking_id = NULL, updated_at = now()
      WHERE k.booking_id = $1 AND k.client_member_id IS NOT NULL
        AND (k.status <> 'OPEN' OR EXISTS (SELECT 1 FROM documents d WHERE d.kyc_case_id = k.id))
      RETURNING k.id`,
    [id]
  );
  // Cases with no member to anchor on still cascade — clean their files first.
  const { rows: docs } = await pool.query(
    `SELECT d.file_path FROM documents d JOIN kyc_cases k ON k.id = d.kyc_case_id WHERE k.booking_id = $1`,
    [id]
  );
  for (const d of docs) {
    try { await deleteKycDocument(d.file_path); } catch { /* best-effort file cleanup */ }
  }

  // Remove the still-pending token payment first (approved rows are preserved + unlinked).
  // Forcing the removal path keeps the chosen lifecycle: a deleted booking takes its
  // pending ledger entry with it, but never touches money Accounting already approved.
  const token_sync = await syncTokenPayment({ ...booking, status: 'CANCELLED' }, pool);

  // Free a draw allotment BEFORE the delete — the FK would only null booking_id,
  // stranding the registration in ALLOTTED with no booking behind it.
  await revertDrawAllotment(booking.id, req.user?.id);

  await pool.query('DELETE FROM bookings WHERE id = $1', [id]);
  res.json({
    message: 'Booking deleted', id: Number(id),
    detachedKycCases: detached.length, removedDocuments: docs.length, token_sync,
  });
});

/** GET /clients/search?site_id=&q= — searches existing members (CLIENT).
 * Includes the referring agent (who added the number) + the latest KYC case status so
 * the booking form can show "KYC verified · referred by AGT-XXXXX" on selection. */
export const searchClients = asyncHandler(async (req, res) => {
  const { site_id, q } = req.query;
  const params = [];
  const where = [`m.member_type = 'CLIENT'`];
  if (site_id) { params.push(site_id); where.push(`m.site_id = $${params.length}`); }
  if (q) {
    params.push(`%${q}%`);
    where.push(`(m.full_name ILIKE $${params.length} OR m.phone ILIKE $${params.length} OR m.aadhar_no ILIKE $${params.length} OR m.pan_no ILIKE $${params.length})`);
  }
  // The LATERAL prefers the case a NEW booking would adopt (booking-less, or stranded
  // on a CANCELLED booking) so kyc_attachable tells the form whether "documents attach
  // automatically" is actually true; otherwise it falls back to the member's strongest
  // case for display.
  const { rows } = await pool.query(
    `SELECT m.id, m.full_name, m.phone, m.email, m.city, m.aadhar_no, m.pan_no, m.photo, m.occupation, m.father_name,
            u.name AS referred_by_name, u.referral_code AS referred_by_code,
            k.id AS kyc_case_id, k.status AS kyc_status, k.attachable AS kyc_attachable
     FROM members m
     LEFT JOIN users u ON u.id = m.referred_by_user_id
     LEFT JOIN LATERAL (
       SELECT kc.id, kc.status,
              (kc.booking_id IS NULL OR b.status = 'CANCELLED') AS attachable
         FROM kyc_cases kc
         LEFT JOIN bookings b ON b.id = kc.booking_id
        WHERE kc.client_member_id = m.id
        ORDER BY (kc.booking_id IS NULL OR b.status = 'CANCELLED') DESC,
                 (kc.status = 'VERIFIED') DESC, kc.id DESC
        LIMIT 1
     ) k ON true
     WHERE ${where.join(' AND ')} ORDER BY m.full_name ASC LIMIT 50`,
    params
  );
  res.json(rows);
});

/**
 * GET /agents/search?site_id=&q= — members who can EARN a commission (the "Booking By"
 * override). Excludes CLIENT/FARMER/VENDOR; returns brokers/members/partners/employees
 * at the site. Used by the booking form's optional "Booking Agent" picker.
 */
export const searchAgents = asyncHandler(async (req, res) => {
  const { site_id, q } = req.query;
  const params = [];
  const where = [`member_type NOT IN ('CLIENT','FARMER','VENDOR')`];
  if (site_id) { params.push(site_id); where.push(`site_id = $${params.length}`); }
  if (q) {
    params.push(`%${q}%`);
    where.push(`(full_name ILIKE $${params.length} OR phone ILIKE $${params.length})`);
  }
  const { rows } = await pool.query(
    `SELECT id, full_name, phone, member_type, photo
       FROM members WHERE ${where.join(' AND ')}
      ORDER BY full_name ASC LIMIT 100`,
    params
  );
  res.json(rows);
});

/** GET /clients/:id — full CLIENT member record (for the edit screen). */
export const getClient = asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM members WHERE id = $1 AND member_type = 'CLIENT'`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ message: 'Client not found' });
  res.json(rows[0]);
});

/** POST /clients — creates a new member of type CLIENT (reuses accounting members). */
export const createClient = asyncHandler(async (req, res) => {
  const { site_id } = req.body;
  if (!site_id || !req.body.full_name) {
    return res.status(400).json({ message: 'site_id and full_name are required' });
  }

  const cols = ['site_id', 'member_type', 'status', 'created_by'];
  const vals = [site_id, 'CLIENT', 'ACTIVE', req.user?.id || null];
  // A customer registered by an agent carries that agent as their referrer — bookings
  // created later auto-attach the agent from this column.
  if (!isAdminRole(req.user?.role)) {
    cols.push('referred_by_user_id');
    vals.push(req.user?.id || null);
  }
  for (const f of CLIENT_FIELDS) {
    if (req.body[f] !== undefined) { cols.push(f); vals.push(clean(req.body[f])); }
  }
  const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await pool.query(
    `INSERT INTO members (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`,
    vals
  );
  res.status(201).json(rows[0]);
});

/** PUT /clients/:id — update any of the supported CLIENT member fields. */
export const updateClient = asyncHandler(async (req, res) => {
  // members.gender has a DB CHECK (MALE/FEMALE/OTHER) — OCR/typed input arrives as
  // "Male"; coerce or skip instead of failing the whole update.
  if (req.body.gender !== undefined && req.body.gender !== '' && req.body.gender !== null) {
    const g = String(req.body.gender).trim().toUpperCase();
    if (['MALE', 'FEMALE', 'OTHER'].includes(g)) req.body.gender = g; else delete req.body.gender;
  }
  const sets = [];
  const vals = [];
  for (const f of CLIENT_FIELDS) {
    if (req.body[f] !== undefined) { vals.push(clean(req.body[f])); sets.push(`${f} = $${vals.length}`); }
  }
  if (!sets.length) return res.status(400).json({ message: 'No editable fields provided' });
  sets.push('updated_at = now()');
  vals.push(req.params.id);

  const { rows } = await pool.query(
    `UPDATE members SET ${sets.join(', ')} WHERE id = $${vals.length} AND member_type = 'CLIENT' RETURNING *`,
    vals
  );
  if (!rows[0]) return res.status(404).json({ message: 'Client not found' });
  res.json(rows[0]);
});

/**
 * GET /clients/:id/payments — payment transactions recorded against the plots this
 * member has booked. Read-only: joins the shared accounting `plot_payments` ledger
 * through the booking-module `bookings` table (bookings.plot_id → plot_payments.plot_id).
 * Returns one row per transaction with plot/site labels, newest first.
 */
export const getClientPayments = asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT pp.id, pp.plot_id, pp.site_id, pp.date, pp.amount,
            pp.payment_type, pp.payment_from, pp.bank_details, pp.bank_name, pp.branch,
            pp.cheque_no, pp.cheque_status, pp.received_by, pp.buyer_name, pp.narration, pp.status,
            p.plot_no, p.block AS plot_block,
            s.name AS site_name
       FROM plot_payments pp
       JOIN plots p ON p.id = pp.plot_id
       LEFT JOIN sites s ON s.id = pp.site_id
      WHERE pp.plot_id IN (
            SELECT DISTINCT plot_id FROM bookings
             WHERE client_member_id = $1 AND plot_id IS NOT NULL
      )
      ORDER BY pp.date DESC, pp.id DESC`,
    [req.params.id]
  );
  res.json(rows);
});

/** GET /plots/available?site_id= — read-only list of plots for booking selection. */
export const availablePlots = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  const params = [];
  const where = [];
  if (site_id) { params.push(site_id); where.push(`site_id = $${params.length}`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT id, plot_no, block, plot_size, sale_price, status FROM plots ${whereSql} ORDER BY plot_no ASC LIMIT 1000`,
    params
  );
  res.json(rows);
});

/** POST /clients/:id/photo — upload profile photo for a client. */
export const uploadClientPhoto = asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

  const { id } = req.params;
  const { rows: existing } = await pool.query(
    'SELECT * FROM members WHERE id = $1 AND member_type = \'CLIENT\'',
    [id]
  );
  if (!existing[0]) return res.status(404).json({ message: 'Client not found' });

  const storageKey = await uploadKycDocument(req.file.buffer, req.file.originalname, req.file.mimetype);
  const photoUrl = getPublicKycUrl(storageKey);

  const { rows } = await pool.query(
    'UPDATE members SET photo = $1, updated_at = now() WHERE id = $2 AND member_type = \'CLIENT\' RETURNING *',
    [photoUrl, id]
  );

  res.json(rows[0]);
});
