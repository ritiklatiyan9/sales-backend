import crypto from 'crypto';
import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import drawModel from '../models/Draw.model.js';
import bookingModel from '../models/Booking.model.js';
import kycCaseModel from '../models/KycCase.model.js';
import { syncPlotBookingToAccounting } from '../services/plotBookingSync.js';
import { syncDrawLedgerToPlot } from '../services/drawLedgerSync.js';
import { isAdminRole, getVisibleUserIds } from '../services/agentNetwork.service.js';
import { findOrCreateClientByPhone } from '../services/memberQuickAdd.service.js';
import { getDrawSettings, upsertDrawSettings } from '../models/ProjectSettings.model.js';

/**
 * Draw-based shop allotment module.
 *
 * Lifecycle: REGISTERED → ELIGIBLE (auto, when the Draw Payment Ledger total reaches
 * required_amount) → SLIP_ISSUED (official Draw Entry Slip / lottery coupon generated)
 * → WINNER (marked after the lottery) → ALLOTTED (QR scanned at the office; a real
 * booking is created and the accounting plot flips to BOOKED via plotBookingSync).
 *
 * Who does what (mirrors the KYC flow): dealers (role 'agent') ONLY register
 * customers and run their KYC — visibility is network-scoped exactly like bookings.
 * Money flow (ledger payments, slip issue, corrections, cancellation) is managed by
 * super_admin/admin/sub_admin. Deciding the draw money (required_amount), marking
 * winners and allotting shops is reserved for super_admin/admin.
 */

// Deciders: the subset of admins who set the draw money and award winners/shops.
const isDeciderRole = (role) => ['admin', 'super_admin'].includes(String(role || '').toLowerCase());

// Ledger capture fields shared by "create with first payment" and "add payment".
// Mirrors the booking token-payment capture fields so the UI vocabulary matches.
const DRAW_PAYMENT_FIELDS = [
  'payment_date', 'payment_from', 'bank_name', 'branch',
  'bank_details', 'cheque_no', 'narration', 'received_by',
];

// Normalise '' → null so optional date/number-ish columns don't choke on empty strings.
const clean = (v) => (v === '' ? null : v);

// The printed form's / slip's QR encodes this public URL; the page resolves the token
// against the LIVE row (draw status changes over time — stateless HMAC won't do).
const drawVerifyUrl = (qrToken) => {
  const base = process.env.DRAW_PUBLIC_VERIFY_URL || 'http://localhost:5173/verify/draw';
  return `${base}?token=${qrToken}`;
};

/** Accepts a raw qr_token, a full verify URL, or a registration/slip number. */
const extractToken = (raw) => {
  const s = String(raw || '').trim();
  if (!s) return null;
  try {
    if (/^https?:\/\//i.test(s)) return new URL(s).searchParams.get('token');
  } catch { /* not a URL — fall through */ }
  return s;
};

/** Shared response shape: registration detail + ledger + events + computed rollups.
 * The three reads are independent — run them in PARALLEL: the DB is remote (Neon),
 * so sequential awaits pay the network latency three times over. */
const buildDetail = async (id, db = pool) => {
  const [registration, payments, events] = await Promise.all([
    drawModel.getDetail(id, db),
    drawModel.getPayments(id, db),
    drawModel.getEvents(id, db),
  ]);
  if (!registration) return null;
  const totalPaid = payments.reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const required = Number(registration.required_amount || 0);
  return {
    ...registration,
    payments,
    events,
    total_paid: totalPaid,
    balance_due: Math.max(0, required - totalPaid),
    is_eligible: totalPaid >= required && required > 0,
    verifyUrl: drawVerifyUrl(registration.qr_token),
  };
};

/**
 * Recompute the pre-slip status from the ledger inside a transaction.
 * Only ever moves between REGISTERED ↔ ELIGIBLE — later states are stage-gated
 * by their own endpoints and never regress from a ledger change.
 */
const reconcileEligibility = async (registration, actorId, db) => {
  if (!['REGISTERED', 'ELIGIBLE'].includes(registration.status)) return registration.status;
  const total = await drawModel.getTotalPaid(registration.id, db);
  const required = Number(registration.required_amount || 0);
  const next = required > 0 && total >= required ? 'ELIGIBLE' : 'REGISTERED';
  if (next !== registration.status) {
    await db.query('UPDATE draw_registrations SET status = $1, updated_at = now() WHERE id = $2', [next, registration.id]);
    await drawModel.logEvent(
      registration.id,
      next === 'ELIGIBLE' ? 'BECAME_ELIGIBLE' : 'ELIGIBILITY_REVOKED',
      { total_paid: total, required_amount: required },
      actorId,
      db
    );
  }
  return next;
};

/**
 * GET /draws/settings?site_id= — the per-site draw money (readable by every authed
 * user: the registration wizard shows it). Set only by Admin/Super Admin below.
 */
export const getDrawSettingsHandler = asyncHandler(async (req, res) => {
  const siteId = parseInt(req.query.site_id, 10);
  if (!siteId || siteId <= 0) return res.status(400).json({ message: 'A valid site_id is required' });
  const row = await getDrawSettings(siteId);
  const amount = Number(row?.draw_required_amount || 0);
  res.json({
    site_id: Number(siteId),
    required_amount: amount > 0 ? amount : null,
    scheme_name: row?.draw_scheme_name || null,
    configured: amount > 0,
  });
});

/**
 * PUT /draws/settings — Admin/Super Admin decide the draw money for a site. Every new
 * registration on the site snapshots this amount.
 */
export const setDrawSettings = asyncHandler(async (req, res) => {
  if (!isDeciderRole(req.user?.role)) {
    return res.status(403).json({ message: 'Only Admin / Super Admin decide the draw amount' });
  }
  const { required_amount, scheme_name } = req.body;
  const siteId = parseInt(req.body.site_id, 10);
  if (!siteId || siteId <= 0) return res.status(400).json({ message: 'A valid site_id is required' });
  const amount = Number(required_amount);
  // Upper bound keeps the value inside NUMERIC(15,2) instead of a raw pg overflow error.
  if (!amount || amount <= 0 || amount > 9_999_999_999_999) {
    return res.status(400).json({ message: 'required_amount (draw registration amount) must be greater than zero' });
  }
  const { rows: siteRows } = await pool.query('SELECT id FROM sites WHERE id = $1', [siteId]);
  if (!siteRows[0]) return res.status(404).json({ message: 'Site not found' });
  const row = await upsertDrawSettings(siteId, { required_amount: amount, scheme_name: clean(scheme_name) });
  res.json({
    site_id: Number(row.site_id),
    required_amount: Number(row.draw_required_amount),
    scheme_name: row.draw_scheme_name,
    configured: true,
  });
});

/**
 * POST /draws — Draw Registration Form submission. Open to dealers (agents) and admins.
 * Customer: { client_member_id } or { phone, full_name } — the phone path is the same
 * quick-add flow as POST /kyc/cases (find-or-create by number, referral claim).
 * The draw money is NEVER taken from the request: it snapshots the per-site amount
 * that Admin/Super Admin set in Draw Settings (PUT /draws/settings). Admins may still
 * adjust a single registration later via PATCH /draws/:id.
 * Optionally records the first ledger payment in the same request (admins only).
 */
export const createDraw = asyncHandler(async (req, res) => {
  const {
    site_id, client_member_id, phone, full_name, scheme_name, notes,
    referral_code, amount,
  } = req.body;

  if (!site_id) return res.status(400).json({ message: 'site_id is required' });
  if (!client_member_id && !phone) {
    return res.status(400).json({ message: 'client_member_id or phone is required' });
  }

  // Validate the optional first payment BEFORE anything else, so a bad request can
  // never leave an orphan registration behind. Money is admin-only — an agent
  // registration simply never carries a payment.
  const hasFirstPayment = amount !== undefined && amount !== null && amount !== '';
  if (hasFirstPayment && !isAdminRole(req.user?.role)) {
    return res.status(403).json({ message: 'Only admins record draw payments — register the customer and an admin will manage the ledger' });
  }
  const firstAmount = hasFirstPayment ? Number(amount) : 0;
  if (hasFirstPayment && (!firstAmount || firstAmount <= 0)) {
    return res.status(400).json({ message: 'Initial payment amount must be greater than zero' });
  }

  const setting = await getDrawSettings(site_id);
  const required = Number(setting?.draw_required_amount || 0);
  if (!required || required <= 0) {
    return res.status(400).json({ message: 'The draw amount for this site has not been set — an Admin must configure it in Draw Settings first' });
  }

  // An explicit referral code wins the ownership attribution — resolved up front so
  // a bad code fails before anything is created.
  let ownership = {};
  if (referral_code) {
    const code = String(referral_code).trim().toUpperCase();
    const { rows } = await pool.query(
      'SELECT id FROM users WHERE upper(referral_code) = $1 AND is_active = true',
      [code]
    );
    if (!rows[0]) {
      return res.status(400).json({ message: `Referral code ${code} does not match any active agent` });
    }
    ownership = { agent_user_id: rows[0].id };
  }

  // Customer resolution + registration + first payment + events are one atomic unit.
  let createdId;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let memberId = client_member_id;
    if (!memberId) {
      const member = await findOrCreateClientByPhone(
        { siteId: site_id, phone, fullName: full_name, user: req.user },
        client
      );
      memberId = member.id;
    }

    // Ownership attribution — same signal order as bookings: explicit referral code,
    // else the member's referring agent, else the creator when they are an agent.
    if (!referral_code) {
      const { rows: memberRows } = await client.query(
        `SELECT m.referred_by_user_id, m.created_by, cu.role AS creator_role
           FROM members m LEFT JOIN users cu ON cu.id = m.created_by
          WHERE m.id = $1`,
        [memberId]
      );
      const mem = memberRows[0];
      if (!mem) {
        await client.query('ROLLBACK');
        return res.status(404).json({ message: 'Client not found' });
      }
      if (mem.referred_by_user_id) ownership = { agent_user_id: mem.referred_by_user_id };
      else if (mem.created_by && !isAdminRole(mem.creator_role)) ownership = { agent_user_id: mem.created_by };
      else if (!isAdminRole(req.user?.role)) ownership = { agent_user_id: req.user.id };
    }

    // Register → KYC: the registration opens (or reuses) the customer's KYC case in
    // the same transaction, exactly like the agent "New KYC" quick-add. The wizard
    // then walks straight into document upload.
    const visibleUserIds = await getVisibleUserIds(req.user);
    const kycCase = await kycCaseModel.getOrCreateForMember(
      { memberId, siteId: site_id, createdBy: req.user?.id, visibleUserIds },
      client
    );

    const created = await drawModel.create({
      site_id,
      client_member_id: memberId,
      ...ownership,
      scheme_name: clean(scheme_name) || setting?.draw_scheme_name || null,
      required_amount: required,
      status: 'REGISTERED',
      qr_token: crypto.randomBytes(16).toString('hex'),
      kyc_case_id: kycCase.id,
      notes: clean(notes) || null,
      created_by: req.user?.id || null,
    }, client);
    createdId = created.id;

    const registration_no = await drawModel.generateRegistrationNo(created.id, created.created_at, client);
    await drawModel.logEvent(created.id, 'REGISTERED', { registration_no, required_amount: required }, req.user?.id, client);
    await drawModel.logEvent(created.id, 'KYC_OPENED', { kyc_case_id: kycCase.id, kyc_status: kycCase.status }, req.user?.id, client);

    if (hasFirstPayment) {
      const data = { draw_registration_id: created.id, amount: firstAmount, created_by: req.user?.id || null };
      for (const f of DRAW_PAYMENT_FIELDS) {
        if (req.body[f] === undefined) continue;
        const v = clean(req.body[f]);
        // payment_date is NOT NULL with a DEFAULT — omit rather than insert NULL.
        if (f === 'payment_date' && v === null) continue;
        data[f] = v;
      }
      const cols = Object.keys(data);
      const { rows } = await client.query(
        `INSERT INTO draw_payments (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
        Object.values(data)
      );
      await drawModel.generateReceiptNo(rows[0].id, client);
      await drawModel.logEvent(created.id, 'PAYMENT_ADDED', { amount: firstAmount, payment_id: rows[0].id }, req.user?.id, client);
      await reconcileEligibility({ ...created, status: 'REGISTERED' }, req.user?.id, client);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const detail = await buildDetail(createdId, pool);
  res.status(201).json(detail);
});

/** GET /draws?site_id=&status=&q=&client_member_id= — network-scoped like bookings. */
export const listDraws = asyncHandler(async (req, res) => {
  const { site_id, status, q, client_member_id } = req.query;
  const visibleUserIds = await getVisibleUserIds(req.user); // null = unrestricted
  const rows = await drawModel.list(
    { siteId: site_id, status, q, clientMemberId: client_member_id, visibleUserIds },
    pool
  );
  res.json(rows);
});

/** GET /draws/:id — registration + Draw Payment Ledger + audit events + rollups. */
export const getDraw = asyncHandler(async (req, res) => {
  const [detail, visibleUserIds] = await Promise.all([
    buildDetail(req.params.id, pool),
    getVisibleUserIds(req.user),
  ]);
  if (!detail) return res.status(404).json({ message: 'Draw registration not found' });
  if (visibleUserIds
      && !visibleUserIds.includes(detail.agent_user_id)
      && !visibleUserIds.includes(detail.created_by)) {
    return res.status(403).json({ message: 'You are not authorised to view this draw registration' });
  }
  res.json(detail);
});

/**
 * POST /draws/:id/payments — record a payment in the customer's Draw Payment Ledger.
 * ADMIN ONLY (money flow belongs to super_admin/admin/sub_admin — agents register
 * and run KYC). Runs in a transaction with the row locked so concurrent payments
 * can't both skip the ELIGIBLE flip. Eligibility is recomputed after every entry.
 */
export const addDrawPayment = asyncHandler(async (req, res) => {
  if (!isAdminRole(req.user?.role)) {
    return res.status(403).json({ message: 'Only admins record draw payments — agents register customers and complete their KYC' });
  }
  const paymentAmount = Number(req.body.amount);
  if (!paymentAmount || paymentAmount <= 0) {
    return res.status(400).json({ message: 'amount must be greater than zero' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: regRows } = await client.query(
      'SELECT * FROM draw_registrations WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    const registration = regRows[0];
    if (!registration) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Draw registration not found' });
    }
    if (registration.status === 'CANCELLED') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'This draw registration is cancelled — payments are closed' });
    }
    if (registration.status === 'ALLOTTED') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Shop already allotted — further payments belong on the booking, not the draw ledger' });
    }

    const data = { draw_registration_id: registration.id, amount: paymentAmount, created_by: req.user?.id || null };
    for (const f of DRAW_PAYMENT_FIELDS) {
      if (req.body[f] === undefined) continue;
      const v = clean(req.body[f]);
      // payment_date is NOT NULL with a DEFAULT — omit rather than insert NULL.
      if (f === 'payment_date' && v === null) continue;
      data[f] = v;
    }
    const cols = Object.keys(data);
    const { rows } = await client.query(
      `INSERT INTO draw_payments (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      Object.values(data)
    );
    const payment = rows[0];
    await drawModel.generateReceiptNo(payment.id, client);
    await drawModel.logEvent(registration.id, 'PAYMENT_ADDED', { amount: paymentAmount, payment_id: payment.id }, req.user?.id, client);
    await reconcileEligibility(registration, req.user?.id, client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const detail = await buildDetail(req.params.id, pool);
  res.status(201).json(detail);
});

/** DELETE /draws/:id/payments/:paymentId — ledger correction. Admin only. */
export const deleteDrawPayment = asyncHandler(async (req, res) => {
  if (!isAdminRole(req.user?.role)) {
    return res.status(403).json({ message: 'Only admins can remove ledger entries' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: regRows } = await client.query(
      'SELECT * FROM draw_registrations WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    const registration = regRows[0];
    if (!registration) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Draw registration not found' });
    }
    const { rows: deleted } = await client.query(
      'DELETE FROM draw_payments WHERE id = $1 AND draw_registration_id = $2 RETURNING id, amount',
      [req.params.paymentId, registration.id]
    );
    if (!deleted[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Payment not found on this registration' });
    }

    // Past the slip stage the entry is already in (or through) the lottery — never
    // let a ledger correction silently strand an ineligible slip in the draw pool.
    if (!['REGISTERED', 'ELIGIBLE'].includes(registration.status)) {
      const remaining = await drawModel.getTotalPaid(registration.id, client);
      if (remaining < Number(registration.required_amount || 0)) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          message: `Removing this entry would drop the ledger below the required amount while the slip is already issued (status ${registration.status}). Cancel the registration instead.`,
        });
      }
    }

    await drawModel.logEvent(registration.id, 'PAYMENT_DELETED', { amount: Number(deleted[0].amount), payment_id: deleted[0].id }, req.user?.id, client);
    await reconcileEligibility(registration, req.user?.id, client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const detail = await buildDetail(req.params.id, pool);
  res.json(detail);
});

/**
 * POST /draws/:id/issue-slip — generate the Official Draw Entry Slip (lottery coupon).
 * ADMIN ONLY: the slip certifies the money side (ledger covers required_amount) and
 * the KYC side (customer VERIFIED) — both re-verified inside the lock, never trusted
 * from the client. Flow: Register → KYC → payments → slip.
 */
export const issueSlip = asyncHandler(async (req, res) => {
  if (!isAdminRole(req.user?.role)) {
    return res.status(403).json({ message: 'Only admins issue draw slips — agents register customers and complete their KYC' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: regRows } = await client.query(
      'SELECT * FROM draw_registrations WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    const registration = regRows[0];
    if (!registration) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Draw registration not found' });
    }
    if (registration.slip_no) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: `Draw slip ${registration.slip_no} was already issued` });
    }
    if (!['REGISTERED', 'ELIGIBLE'].includes(registration.status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: `Cannot issue a slip while status is ${registration.status}` });
    }

    // Flow gate: no official slip without the customer's KYC verified. Resolved the
    // same way the model does — the linked case, falling back to the member's newest.
    const { rows: kycRows } = await client.query(
      `SELECT kc.status FROM kyc_cases kc
        WHERE kc.id = $1::int OR kc.client_member_id = $2
        ORDER BY (kc.id = $1::int) DESC NULLS LAST, kc.id DESC
        LIMIT 1`,
      [registration.kyc_case_id, registration.client_member_id]
    );
    if (kycRows[0]?.status !== 'VERIFIED') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        message: `Customer KYC is ${kycRows[0]?.status ? `still ${kycRows[0].status}` : 'not started'} — the draw slip can only be issued after KYC is verified`,
      });
    }

    // Re-verify eligibility from the ledger — the single source of truth.
    const total = await drawModel.getTotalPaid(registration.id, client);
    const required = Number(registration.required_amount || 0);
    if (required <= 0 || total < required) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        message: `Customer is not yet eligible: paid ₹${total} of the required ₹${required}`,
      });
    }

    const slipNo = `SLIP-${new Date(registration.created_at).getFullYear()}-${String(registration.id).padStart(6, '0')}`;
    await client.query(
      `UPDATE draw_registrations
          SET slip_no = $1, slip_issued_at = now(), slip_issued_by = $2,
              status = 'SLIP_ISSUED', updated_at = now()
        WHERE id = $3`,
      [slipNo, req.user?.id || null, registration.id]
    );
    await drawModel.logEvent(registration.id, 'SLIP_ISSUED', { slip_no: slipNo, total_paid: total }, req.user?.id, client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const detail = await buildDetail(req.params.id, pool);
  res.json(detail);
});

/** POST /draws/:id/winner — body { winner: boolean }. Admin/super_admin only, after the lottery. */
export const markWinner = asyncHandler(async (req, res) => {
  if (!isDeciderRole(req.user?.role)) {
    return res.status(403).json({ message: 'Only Admin / Super Admin can mark draw winners' });
  }
  const winner = req.body.winner !== false;
  const registration = await drawModel.findById(req.params.id, pool);
  if (!registration) return res.status(404).json({ message: 'Draw registration not found' });

  // Status preconditions are re-checked INSIDE the UPDATE so a concurrent
  // allot/cancel can never be overwritten by a stale read (check-then-act race).
  if (winner) {
    const { rows: updated } = await pool.query(
      `UPDATE draw_registrations
          SET is_winner = TRUE, winner_marked_at = now(), winner_marked_by = $1,
              status = 'WINNER', updated_at = now()
        WHERE id = $2 AND status = 'SLIP_ISSUED'
        RETURNING id`,
      [req.user.id, registration.id]
    );
    if (!updated[0]) {
      return res.status(400).json({ message: `Only entries with an issued slip can win (current status: ${registration.status})` });
    }
    await drawModel.logEvent(registration.id, 'WINNER_MARKED', { slip_no: registration.slip_no }, req.user.id, pool).catch(() => {});
  } else {
    const { rows: updated } = await pool.query(
      `UPDATE draw_registrations
          SET is_winner = FALSE, winner_marked_at = NULL, winner_marked_by = NULL,
              status = CASE WHEN status = 'WINNER' THEN 'SLIP_ISSUED' ELSE status END,
              updated_at = now()
        WHERE id = $1 AND status <> 'ALLOTTED'
        RETURNING id`,
      [registration.id]
    );
    if (!updated[0]) {
      return res.status(400).json({ message: 'Cannot unmark a winner after the shop has been allotted' });
    }
    await drawModel.logEvent(registration.id, 'WINNER_UNMARKED', { slip_no: registration.slip_no }, req.user.id, pool).catch(() => {});
  }

  const detail = await buildDetail(req.params.id, pool);
  res.json(detail);
});

/**
 * POST /draws/scan — office verification. Body { token } where token is the scanned
 * QR content (verify URL or raw token) or a typed registration/slip number.
 * Read-only: returns the live registration with a scan verdict; allotment is the
 * separate admin-only POST /draws/:id/allot.
 */
export const scanDraw = asyncHandler(async (req, res) => {
  const token = extractToken(req.body.token);
  if (!token) return res.status(400).json({ message: 'Scan token is required' });

  // ONE indexed lookup covers all three shapes (qr_token / registration_no / slip_no)
  // — the scan desk is latency-sensitive and the DB is remote.
  const { rows } = await pool.query(
    'SELECT id FROM draw_registrations WHERE qr_token = $1 OR registration_no = $2 OR slip_no = $2 LIMIT 1',
    [token, token.toUpperCase()]
  );
  const hit = rows[0];
  if (!hit) {
    return res.status(404).json({ valid: false, message: 'No draw registration matches this code — the slip is not genuine or was revoked' });
  }

  // Detail + network scoping are independent — fetch in parallel.
  const [detail, visibleUserIds] = await Promise.all([
    buildDetail(hit.id, pool),
    getVisibleUserIds(req.user),
  ]);

  // Same network scoping as GET /draws/:id — registration/slip numbers are
  // sequential and guessable, so without this check any agent could enumerate
  // every customer's ledger, Aadhaar/PAN and live qr_token through this endpoint.
  if (visibleUserIds
      && !visibleUserIds.includes(detail.agent_user_id)
      && !visibleUserIds.includes(detail.created_by)) {
    return res.status(403).json({ valid: false, message: 'This slip belongs to another network — ask an admin to verify it' });
  }

  // Best-effort audit — never holds the response back.
  drawModel.logEvent(hit.id, 'SCANNED', { by_role: req.user.role }, req.user.id, pool).catch(() => {});

  res.json({
    valid: true,
    can_allot: detail.status === 'WINNER' && isDeciderRole(req.user.role),
    verdict:
      detail.status === 'ALLOTTED' ? 'Shop already allotted against this slip'
        : detail.status === 'WINNER' ? 'Verified winner — ready for shop allotment'
          : detail.status === 'SLIP_ISSUED' ? 'Genuine slip, but not marked as a winner'
            : detail.status === 'CANCELLED' ? 'Registration was cancelled'
              : 'Genuine registration — draw slip not issued yet',
    registration: detail,
  });
});

/**
 * POST /draws/:id/allot — body { plot_id }. Admin only, WINNER only.
 * Creates a REAL booking for the allotted shop (so agreements/KYC/ledgers flow through
 * the normal ERP), links it to the draw, then flips the accounting plot to BOOKED via
 * the existing plotBookingSync. Draw ledger stays the payment record for the draw.
 */
export const allotShop = asyncHandler(async (req, res) => {
  if (!isDeciderRole(req.user?.role)) {
    return res.status(403).json({ message: 'Only Admin / Super Admin can allot shops' });
  }
  const plotId = parseInt(req.body.plot_id);
  if (!plotId) return res.status(400).json({ message: 'plot_id is required' });

  let bookingForSync = null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: regRows } = await client.query(
      'SELECT * FROM draw_registrations WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    const registration = regRows[0];
    if (!registration) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Draw registration not found' });
    }
    if (registration.status !== 'WINNER' || !registration.is_winner) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: `Only verified winners can be allotted a shop (current status: ${registration.status})` });
    }

    // Belt-and-braces: the ledger must still cover the registration amount at the
    // moment of allotment (an admin may have corrected payments since the slip).
    const totalPaid = await drawModel.getTotalPaid(registration.id, client);
    if (totalPaid < Number(registration.required_amount || 0)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: `Ledger no longer covers the registration amount (paid ₹${totalPaid} of ₹${registration.required_amount}) — resolve the ledger first` });
    }

    // FOR UPDATE: serialises concurrent allotments of the SAME shop — without it two
    // admins could allot one unit to two winners (plots.status only flips after commit).
    const { rows: plotRows } = await client.query(
      'SELECT id, site_id, plot_no, block, status, buyer_name, sale_price FROM plots WHERE id = $1 FOR UPDATE',
      [plotId]
    );
    const plot = plotRows[0];
    if (!plot) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Plot/shop not found' });
    }
    if (parseInt(plot.site_id) !== parseInt(registration.site_id)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'The selected shop belongs to a different site than this draw registration' });
    }
    // Same commitment guard as plotBookingSync (PROTECTED_STATUSES + BOOKED) —
    // never clobber a unit already committed to someone.
    const committed = new Set(['BOOKED', 'SOLD', 'REGISTRY', 'UNDER CANCELLATION', 'CANCELLED', 'TRANSFERRED']);
    if (committed.has(String(plot.status || '').toUpperCase()) && plot.buyer_name) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: `Shop ${[plot.block, plot.plot_no].filter(Boolean).join(' ')} is already ${plot.status} to ${plot.buyer_name}` });
    }
    // The accounting flip is post-commit and fire-and-forget, so plots.status can
    // lag reality — check our OWN records too: another ALLOTTED draw or an active
    // booking on this unit blocks the allotment even if the sync never ran.
    const { rows: clash } = await client.query(
      `SELECT (SELECT r2.registration_no FROM draw_registrations r2
                WHERE r2.allotted_plot_id = $1 AND r2.status = 'ALLOTTED' LIMIT 1) AS other_draw,
              (SELECT b.booking_no FROM bookings b
                WHERE b.plot_id = $1 AND b.status <> 'CANCELLED' LIMIT 1) AS other_booking`,
      [plot.id]
    );
    if (clash[0].other_draw || clash[0].other_booking) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        message: `Shop ${[plot.block, plot.plot_no].filter(Boolean).join(' ')} is already taken (${clash[0].other_draw || clash[0].other_booking})`,
      });
    }

    // Team attribution mirrors createBooking: the owning agent's team rides along.
    let teamId = null;
    if (registration.agent_user_id) {
      const { rows: agentRows } = await client.query('SELECT team_id FROM users WHERE id = $1', [registration.agent_user_id]);
      teamId = agentRows[0]?.team_id || null;
    }

    // The allotment becomes a real booking so every downstream ERP flow (agreement
    // form, KYC dossier, plot ledger) works unchanged for draw winners.
    const booking = await bookingModel.create({
      site_id: registration.site_id,
      plot_id: plot.id,
      client_member_id: registration.client_member_id,
      agent_user_id: registration.agent_user_id || null,
      team_id: teamId,
      sale_price: Number(plot.sale_price) || 0,
      token_amount: 0, // draw payments live in the separate Draw Payment Ledger
      payment_plan: 'FULL',
      booking_date: new Date().toISOString().slice(0, 10),
      status: 'CONFIRMED',
      kyc_status: 'NOT_STARTED',
      booked_by: req.user?.email || null,
      notes: `Allotted via lucky draw ${registration.registration_no} (slip ${registration.slip_no})`,
      created_by: req.user?.id || null,
    }, client);
    const booking_no = await bookingModel.generateBookingNo(booking.id, booking.booking_date, client);
    await kycCaseModel.adoptForBooking(booking, client);

    await client.query(
      `UPDATE draw_registrations
          SET allotted_plot_id = $1, allotted_at = now(), allotted_by = $2,
              booking_id = $3, status = 'ALLOTTED', updated_at = now()
        WHERE id = $4`,
      [plot.id, req.user.id, booking.id, registration.id]
    );
    await drawModel.logEvent(
      registration.id, 'ALLOTTED',
      { plot_id: plot.id, plot_no: plot.plot_no, block: plot.block, booking_id: booking.id, booking_no },
      req.user.id, client
    );
    await client.query('COMMIT');
    bookingForSync = { ...booking, booking_no };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Propagate to the accounting plots ledger (BOOKED + buyer + commission) after
  // commit — fire-and-forget, a sync failure never voids the allotment itself.
  const plot_sync = await syncPlotBookingToAccounting(bookingForSync, pool);
  // Mirror every Draw Payment Ledger receipt into the shared plot_payments so the
  // booking's payments page shows the money received (pending, Accounting approves).
  const ledger_sync = await syncDrawLedgerToPlot(req.params.id, pool);

  const detail = await buildDetail(req.params.id, pool);
  res.json({ ...detail, plot_sync, ledger_sync });
});

/**
 * PATCH /draws/:id — Admin/super_admin decide the draw money (required_amount) and
 * may correct scheme_name/notes. The amount is locked once the slip exists: the
 * printed coupon certifies a specific figure, and later stages never regress.
 */
export const updateDraw = asyncHandler(async (req, res) => {
  if (!isDeciderRole(req.user?.role)) {
    return res.status(403).json({ message: 'Only Admin / Super Admin decide the draw amount' });
  }
  const { required_amount, scheme_name, notes } = req.body;
  const hasAmount = required_amount !== undefined && required_amount !== null && required_amount !== '';
  const amount = hasAmount ? Number(required_amount) : null;
  if (hasAmount && (!amount || amount <= 0)) {
    return res.status(400).json({ message: 'required_amount (draw registration amount) must be greater than zero' });
  }
  if (!hasAmount && scheme_name === undefined && notes === undefined) {
    return res.status(400).json({ message: 'Nothing to update' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: regRows } = await client.query(
      'SELECT * FROM draw_registrations WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    const registration = regRows[0];
    if (!registration) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Draw registration not found' });
    }
    if (hasAmount && !['REGISTERED', 'ELIGIBLE'].includes(registration.status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: `The draw amount is locked once the slip is issued (current status: ${registration.status})` });
    }

    const sets = [];
    const params = [];
    if (hasAmount) { params.push(amount); sets.push(`required_amount = $${params.length}`); }
    if (scheme_name !== undefined) { params.push(clean(scheme_name)); sets.push(`scheme_name = $${params.length}`); }
    if (notes !== undefined) { params.push(clean(notes)); sets.push(`notes = $${params.length}`); }
    params.push(registration.id);
    await client.query(
      `UPDATE draw_registrations SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}`,
      params
    );
    if (hasAmount && amount !== Number(registration.required_amount)) {
      await drawModel.logEvent(
        registration.id, 'AMOUNT_SET',
        { from: Number(registration.required_amount), to: amount },
        req.user?.id, client
      );
      // The new amount may flip eligibility either way — recompute from the ledger.
      await reconcileEligibility({ ...registration, required_amount: amount }, req.user?.id, client);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const detail = await buildDetail(req.params.id, pool);
  res.json(detail);
});

/** POST /draws/:id/cancel — admin only; a cancelled entry leaves the lottery pool. */
export const cancelDraw = asyncHandler(async (req, res) => {
  if (!isAdminRole(req.user?.role)) {
    return res.status(403).json({ message: 'Only admins can cancel draw registrations' });
  }
  const registration = await drawModel.findById(req.params.id, pool);
  if (!registration) return res.status(404).json({ message: 'Draw registration not found' });
  // Condition inside the UPDATE — a concurrent allotment can never be clobbered.
  const { rows: updated } = await pool.query(
    `UPDATE draw_registrations SET status = 'CANCELLED', updated_at = now()
      WHERE id = $1 AND status <> 'ALLOTTED' RETURNING id`,
    [registration.id]
  );
  if (!updated[0]) {
    return res.status(400).json({ message: 'Cannot cancel after allotment — cancel the linked booking instead' });
  }
  await drawModel.logEvent(registration.id, 'CANCELLED', null, req.user.id, pool).catch(() => {});
  const detail = await buildDetail(req.params.id, pool);
  res.json(detail);
});

/**
 * DELETE /draws/:id — hard-delete a registration (admin only).
 * Allowed only before the entry reaches the lottery pool (slip issued or later
 * must use cancel instead — deleting them would corrupt the draw history).
 */
export const deleteDraw = asyncHandler(async (req, res) => {
  if (!isAdminRole(req.user?.role)) {
    return res.status(403).json({ message: 'Only admins can delete draw registrations' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: regRows } = await client.query(
      'SELECT id, status FROM draw_registrations WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    const registration = regRows[0];
    if (!registration) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Draw registration not found' });
    }
    if (!['REGISTERED', 'ELIGIBLE', 'CANCELLED'].includes(registration.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        message: `Cannot delete a registration with status ${registration.status} — it is already in the lottery. Cancel it instead.`,
      });
    }
    await client.query('DELETE FROM draw_payments WHERE draw_registration_id = $1', [registration.id]);
    await client.query('DELETE FROM draw_events WHERE draw_registration_id = $1', [registration.id]);
    await client.query('DELETE FROM draw_registrations WHERE id = $1', [registration.id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.json({ ok: true, id: Number(req.params.id) });
});

/**
 * GET /public/draws/verify?token= — UNAUTHENTICATED verification page data.
 * Resolved against the live row (the QR token is an unguessable 128-bit value).
 * Exposes only what the printed form/slip already shows, plus live status — including
 * whether a booking (and therefore an agreement form) exists after allotment.
 */
export const publicVerifyDraw = asyncHandler(async (req, res) => {
  const token = extractToken(req.query.token);
  if (!token) return res.status(400).json({ valid: false, reason: 'Missing token' });

  const hit = await drawModel.findByQrToken(token, pool);
  if (!hit) return res.json({ valid: false, reason: 'Invalid or tampered draw code' });

  const d = await buildDetail(hit.id, pool);

  // Public-safe milestone timeline (no actor names, no ledger line items).
  const MILESTONES = new Set(['REGISTERED', 'BECAME_ELIGIBLE', 'SLIP_ISSUED', 'WINNER_MARKED', 'ALLOTTED', 'CANCELLED']);
  const timeline = d.events
    .filter((e) => MILESTONES.has(e.event_type))
    .map((e) => ({ event: e.event_type, at: e.created_at }));

  res.json({
    valid: true,
    registration_no: d.registration_no,
    slip_no: d.slip_no,
    status: d.status,
    is_winner: d.is_winner,
    scheme_name: d.scheme_name,
    site_name: d.site_name,
    customer_name: d.client_name,
    customer_photo: d.client_photo,
    registered_at: d.created_at,
    required_amount: Number(d.required_amount) || 0,
    total_paid: d.total_paid,
    is_eligible: d.is_eligible,
    slip_issued_at: d.slip_issued_at,
    allotment: d.status === 'ALLOTTED' ? {
      plot_no: d.allotted_plot_no,
      block: d.allotted_plot_block,
      allotted_at: d.allotted_at,
      booking_no: d.booking_no,
      booking_form: d.booking_no ? 'AVAILABLE' : 'PENDING',
      agreement_form: d.booking_no ? 'AVAILABLE' : 'PENDING',
      booking_kyc_status: d.booking_kyc_status,
    } : null,
    timeline,
  });
});
