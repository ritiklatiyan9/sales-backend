import { ensureBookingCreditFields } from '../services/bookingDrawCredits.js';
import { syncTokenPayment } from '../services/tokenPaymentSync.js';
import crypto from 'crypto';
import { DEFAULT_DRAW_TERMS, money, openingDate, todayIST, validDate, validatePayment, validateWinner, workflowError } from '../services/drawWorkflow.js';
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
import { validateDrawInstallmentPlan } from '../services/drawInstallmentPlan.js';

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
  const totalPaid = payments.reduce((sum, p) => sum + Math.round(Number(p.amount || 0) * 100), 0) / 100;
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
    wait_days: row?.draw_wait_days || 10,
    opening_date: row?.draw_opening_date || '',
    terms: row?.draw_terms || DEFAULT_DRAW_TERMS,
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
  const amount = money(required_amount, 'Required amount');
  const previous = await getDrawSettings(siteId);
  const wait_days = Number(req.body.wait_days ?? previous?.draw_wait_days ?? 10);
  const opening_date = req.body.opening_date === undefined ? previous?.draw_opening_date : req.body.opening_date;
  const applyToExisting = req.body.apply_to_existing === true;
  if (req.body.apply_to_existing !== undefined && typeof req.body.apply_to_existing !== 'boolean') throw workflowError('Choose whether to update existing registrations');
  if (applyToExisting && !opening_date) throw workflowError('Choose a manual draw date before updating existing registrations');
  if (![10, 25].includes(wait_days)) throw workflowError('Choose a 10-day or 25-day draw period');
  openingDate(opening_date, wait_days);
  const terms = String(req.body.terms ?? previous?.draw_terms ?? DEFAULT_DRAW_TERMS).trim().replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n');
  if ((terms.match(/\n/g) || []).length > 24) throw workflowError('Use at most 25 lines of terms so the form fits on two pages');
  if (!terms || terms.length > 4500) throw workflowError('Terms must contain 1–4500 characters');
  // Upper bound keeps the value inside NUMERIC(15,2) instead of a raw pg overflow error.
  if (!amount || amount <= 0 || amount > 9_999_999_999_999) {
    return res.status(400).json({ message: 'required_amount (draw registration amount) must be greater than zero' });
  }
  const { rows: siteRows } = await pool.query('SELECT id FROM sites WHERE id = $1', [siteId]);
  if (!siteRows[0]) return res.status(404).json({ message: 'Site not found' });
  let row;
  let updatedRegistrations = 0;
  if (applyToExisting) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      row = await upsertDrawSettings(siteId, { required_amount: amount, scheme_name: clean(scheme_name), wait_days, opening_date, terms }, client);
      const { rows: registrations } = await client.query(
        `SELECT id, draw_opening_date FROM draw_registrations
         WHERE site_id = $1 AND status IN ('REGISTERED', 'ELIGIBLE', 'SLIP_ISSUED')
           AND draw_opening_date IS DISTINCT FROM $2::date
         FOR UPDATE`,
        [siteId, opening_date]
      );
      if (registrations.length) {
        await client.query(
          'UPDATE draw_registrations SET draw_opening_date = $1, updated_at = now() WHERE id = ANY($2::int[])',
          [opening_date, registrations.map((registration) => registration.id)]
        );
        for (const registration of registrations) {
          await drawModel.logEvent(registration.id, 'DRAW_SCHEDULED', { from: registration.draw_opening_date, to: opening_date }, req.user.id, client);
        }
      }
      updatedRegistrations = registrations.length;
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } else {
    row = await upsertDrawSettings(siteId, { required_amount: amount, scheme_name: clean(scheme_name), wait_days, opening_date, terms });
  }
  res.json({
    site_id: Number(row.site_id),
    required_amount: Number(row.draw_required_amount),
    scheme_name: row.draw_scheme_name,
    configured: true,
    wait_days: row.draw_wait_days,
    opening_date: row.draw_opening_date || '',
    updated_registrations: updatedRegistrations,
    terms: row.draw_terms,
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

  if (!Number.isInteger(Number(site_id)) || Number(site_id) <= 0) throw workflowError('A valid site_id is required');
  if (!client_member_id && !/^(?:91|0)?[6-9]\d{9}$/.test(String(phone || '').replace(/\D/g, ''))) throw workflowError('Enter a valid Indian mobile number');
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
  const firstAmount = hasFirstPayment ? validatePayment(req.body) : 0;
  if (hasFirstPayment && (!firstAmount || firstAmount <= 0)) {
    return res.status(400).json({ message: 'Initial payment amount must be greater than zero' });
  }

  const setting = await getDrawSettings(site_id);
  const required = Number(setting?.draw_required_amount || 0);
  if (!required || required <= 0) {
    return res.status(400).json({ message: 'The draw amount for this site has not been set — an Admin must configure it in Draw Settings first' });
  }

  const scheduledDate = openingDate(setting.draw_opening_date, req.body.wait_days ?? setting.draw_wait_days);
  if (!client_member_id && (!String(full_name || '').trim() || String(full_name).length > 255)) throw workflowError('Customer name is required (up to 255 characters)');
  const requestKey = req.body.request_key || null;
  if (requestKey && !/^[a-zA-Z0-9_-]{8,100}$/.test(requestKey)) throw workflowError('Invalid registration request key');

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

    if (requestKey) {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`draw_request:${req.user.id}:${requestKey}`]);
      const { rows } = await client.query('SELECT id FROM draw_registrations WHERE created_by = $1 AND request_key = $2', [req.user.id, requestKey]);
      if (rows[0]) {
        await client.query('COMMIT');
        return res.json(await buildDetail(rows[0].id));
      }
    }
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

    // Every Booking Payments customer must immediately appear in the KYC register.
    // Create/reuse the member-anchored case inside this transaction so registration
    // can never succeed without its matching KYC queue item.
    const { rows: members } = await client.query('SELECT site_id FROM members WHERE id = $1', [memberId]);
    if (!members[0] || Number(members[0].site_id) !== Number(site_id)) throw workflowError('Customer does not belong to the selected site');

    const visibleUserIds = await getVisibleUserIds(req.user);
    const kycCase = await kycCaseModel.getOrCreateForMember({
      memberId,
      siteId: site_id,
      createdBy: req.user?.id || null,
      visibleUserIds,
    }, client);

    const created = await drawModel.create({
      site_id,
      client_member_id: memberId,
      kyc_case_id: kycCase.id,
      ...ownership,
      scheme_name: clean(scheme_name) || setting?.draw_scheme_name || null,
      required_amount: required,
      status: 'REGISTERED',
      qr_token: crypto.randomBytes(16).toString('hex'),
      workflow_version: 1,
      draw_opening_date: scheduledDate,
      request_key: requestKey,
      notes: clean(notes) || null,
      created_by: req.user?.id || null,
    }, client);
    createdId = created.id;

    const registration_no = await drawModel.generateRegistrationNo(created.id, created.created_at, client);
    await drawModel.logEvent(created.id, 'REGISTERED', { registration_no, required_amount: required }, req.user?.id, client);
    await drawModel.logEvent(created.id, 'KYC_OPENED', { kyc_case_id: kycCase.id, automatic: true }, req.user?.id, client);


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
  const paymentAmount = validatePayment(req.body);
  const requestKey = req.body.request_key || null;
  if (requestKey && !/^[a-zA-Z0-9_-]{8,100}$/.test(requestKey)) throw workflowError('Invalid payment request key');
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
    if (requestKey) {
      const { rows: prior } = await client.query('SELECT id, amount, payment_from FROM draw_payments WHERE draw_registration_id = $1 AND request_key = $2', [registration.id, requestKey]);
      if (prior[0]) {
        if (Number(prior[0].amount) !== paymentAmount || prior[0].payment_from !== (req.body.payment_from || 'CASH')) throw workflowError('This payment request was already saved with different details. Refresh the ledger before entering a new payment.', 409);
        await client.query('COMMIT');
        return res.json(await buildDetail(registration.id));
      }
    }
    if (registration.status === 'CANCELLED') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'This draw registration is cancelled — payments are closed' });
    }
    if (registration.status === 'ALLOTTED') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Shop already allotted — further payments belong on the booking, not the draw ledger' });
    }

    const data = { draw_registration_id: registration.id, request_key: requestKey, amount: paymentAmount, created_by: req.user?.id || null };
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
    if (['ALLOTTED', 'CANCELLED'].includes(registration.status)) throw workflowError('This ledger is closed. Correct an allotted payment in Accounting.', 409);
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
 * ADMIN ONLY: the slip certifies that the ledger covers required_amount and the
 * draw date is configured. KYC may continue after document issue, but is enforced
 * before a physical result can be recorded or a property can be allotted.
 */
export const issueSlip = asyncHandler(async (req, res) => {
  if (!isAdminRole(req.user?.role)) {
    return res.status(403).json({ message: 'Only admins issue draw forms and slips' });
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

    // Re-verify eligibility from the ledger — the single source of truth.
    const total = await drawModel.getTotalPaid(registration.id, client);
    const required = Number(registration.required_amount || 0);
    if (required <= 0 || total < required) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        message: `Customer is not yet eligible: paid ₹${total} of the required ₹${required}`,
      });
    }

    if (!registration.draw_opening_date) throw workflowError('Set the draw opening date before issuing documents');
    const { rows: settings } = await client.query('SELECT draw_terms FROM project_settings WHERE site_id = $1', [registration.site_id]);
    const terms = settings[0]?.draw_terms || DEFAULT_DRAW_TERMS;

    const slipNo = `SLIP-${new Date(registration.created_at).getFullYear()}-${String(registration.id).padStart(6, '0')}`;
    await client.query(
      `UPDATE draw_registrations
          SET slip_no = $1, slip_issued_at = now(), slip_issued_by = $2,
              status = 'SLIP_ISSUED', terms_snapshot = $4, updated_at = now()
        WHERE id = $3`,
      [slipNo, req.user?.id || null, registration.id, terms]
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM draw_registrations WHERE id = $1 FOR UPDATE', [req.params.id]);
    const registration = rows[0];
    if (!registration) throw workflowError('Draw registration not found', 404);
    if (winner) {
      await client.query('SELECT id FROM kyc_cases WHERE client_member_id = $1 AND site_id = $2 FOR SHARE', [registration.client_member_id, registration.site_id]);
      const kyc = await drawModel.getDetail(registration.id, client);
      const total = await drawModel.getTotalPaid(registration.id, client);
      validateWinner(registration, { total, kycStatus: kyc.kyc_status, slipNumber: req.body.slip_no });
      await client.query(`UPDATE draw_registrations SET is_winner = TRUE, winner_marked_at = now(), winner_marked_by = $1, status = 'WINNER', updated_at = now() WHERE id = $2`, [req.user.id, registration.id]);
      await drawModel.logEvent(registration.id, 'WINNER_MARKED', { slip_no: registration.slip_no, method: 'PHYSICAL_BUCKET' }, req.user.id, client);
    } else {
      if (registration.status !== 'WINNER') throw workflowError('Only a winner awaiting allotment can be unmarked', 409);
      await client.query(`UPDATE draw_registrations SET is_winner = FALSE, winner_marked_at = NULL, winner_marked_by = NULL, status = 'SLIP_ISSUED', updated_at = now() WHERE id = $1`, [registration.id]);
      await drawModel.logEvent(registration.id, 'WINNER_UNMARKED', { slip_no: registration.slip_no }, req.user.id, client);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }

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
 * POST /draws/:id/allot — Admin only, WINNER only. Installment allotments include
 * the full dated schedule and Accounting plan settings.
 * Creates a REAL booking for the allotted shop (so agreements/KYC/ledgers flow through
 * the normal ERP), links it to the draw, then flips the accounting plot to BOOKED via
 * the existing plotBookingSync. Draw ledger stays the payment record for the draw.
 */
export async function allotDrawBooking({ registrationId, body, user }) {
  const req = { params: { id: registrationId }, body, user };
  if (!isDeciderRole(req.user?.role)) {
    throw workflowError('Only Admin / Super Admin can allot shops', 403);
  }
  const plotId = Number(req.body.plot_id);
  if (!Number.isInteger(plotId) || plotId <= 0) throw workflowError('A valid plot_id is required');
  if (!Number.isInteger(Number(registrationId)) || Number(registrationId) <= 0) throw workflowError('A valid draw registration is required');

  const paymentPlan = req.body.payment_plan || 'FULL';
  if (!['FULL', 'INSTALLMENT'].includes(paymentPlan)) throw workflowError('Select FULL or INSTALLMENT payment plan');
  await ensureBookingCreditFields();
  const extra = req.body.token_amount == null || req.body.token_amount === '' || Number(req.body.token_amount) === 0 ? 0 : money(req.body.token_amount, 'New payment');
  if (extra) validatePayment({ amount: extra, payment_date: req.body.token_payment_date, payment_from: req.body.token_payment_from, cheque_no: req.body.token_cheque_no, bank_details: req.body.token_bank_details });
  let creditAmount = 0;
  let token_sync = null;
  let bookingForSync = null;
  let ledger_sync;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: regRows } = await client.query(
      'SELECT * FROM draw_registrations WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    const registration = regRows[0];
    if (!registration) {
      throw workflowError('Draw registration not found', 404);
    }
    if ((body.site_id != null && Number(body.site_id) !== Number(registration.site_id)) || (body.client_member_id != null && Number(body.client_member_id) !== Number(registration.client_member_id))) throw workflowError('Draw payment does not belong to this customer and site', 409);
    if (registration.booking_id) throw workflowError('Draw payments are already applied to a booking', 409);
    const usedReceipts = await client.query('SELECT id FROM draw_payments WHERE draw_registration_id = $1 AND plot_payment_id IS NOT NULL LIMIT 1', [registration.id]);
    if (usedReceipts.rows.length) throw workflowError('Draw receipts are already transferred; resolve the existing allocation first', 409);
    if (registration.status !== 'WINNER' || !registration.is_winner) {
      throw workflowError(`Only verified winners can be allotted a shop (current status: ${registration.status})`, 400);
    }

    await client.query('SELECT id FROM kyc_cases WHERE client_member_id = $1 AND site_id = $2 FOR UPDATE', [registration.client_member_id, registration.site_id]);
    const liveKyc = await drawModel.getDetail(registration.id, client);
    if (liveKyc.kyc_status !== 'VERIFIED') throw workflowError('KYC must be verified before allotment', 409);
    // Already-selected legacy winners predate scheduling; do not strand their allotment.
    if ((registration.workflow_version > 0 && !registration.draw_opening_date) || registration.draw_opening_date > todayIST()) throw workflowError('The draw is not open yet', 409);

    // Belt-and-braces: the ledger must still cover the registration amount at the
    // moment of allotment (an admin may have corrected payments since the slip).
    const totalPaid = await drawModel.getTotalPaid(registration.id, client);
    if (totalPaid < Number(registration.required_amount || 0)) {
      throw workflowError(`Ledger no longer covers the registration amount (paid ₹${totalPaid} of ₹${registration.required_amount}) — resolve the ledger first`, 409);
    }

    if (body.expected_draw_credit_amount != null && Math.round(Number(body.expected_draw_credit_amount) * 100) !== Math.round(totalPaid * 100)) throw workflowError('Draw payments changed since this form was loaded. Review the refreshed receipts and retry.', 409);
    creditAmount = totalPaid;

    // FOR UPDATE: serialises concurrent allotments of the SAME shop — without it two
    // admins could allot one unit to two winners (plots.status only flips after commit).
    const { rows: plotRows } = await client.query(
      'SELECT id, site_id, plot_no, block, status, buyer_name, sale_price FROM plots WHERE id = $1 FOR UPDATE',
      [plotId]
    );
    const plot = plotRows[0];
    if (!plot) {
      throw workflowError('Plot/shop not found', 404);
    }
    if (parseInt(plot.site_id) !== parseInt(registration.site_id)) {
      throw workflowError('The selected shop belongs to a different site than this draw registration', 400);
    }
    // Same commitment guard as plotBookingSync (PROTECTED_STATUSES + BOOKED) —
    // never clobber a unit already committed to someone.
    const committed = new Set(['BOOKED', 'SOLD', 'REGISTRY', 'UNDER CANCELLATION', 'CANCELLED', 'TRANSFERRED']);
    if (committed.has(String(plot.status || '').toUpperCase())) {
      throw workflowError(`Shop ${[plot.block, plot.plot_no].filter(Boolean).join(' ')} is already ${plot.status} to ${plot.buyer_name}`, 409);
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
      throw workflowError(`Shop ${[plot.block, plot.plot_no].filter(Boolean).join(' ')} is already taken (${clash[0].other_draw || clash[0].other_booking})`, 409);
    }
    const priorPlan = await client.query('SELECT id FROM plot_installments WHERE plot_id = $1 LIMIT 1', [plot.id]);
    if (priorPlan.rows.length) throw workflowError('This unit already has an installment schedule in Accounting; resolve it before allotment', 409);
    const salePrice = money(req.body.sale_price ?? plot.sale_price, 'Unit sale price');
    const bookingDate = todayIST();
    const installmentPlan = paymentPlan === 'INSTALLMENT'
      ? validateDrawInstallmentPlan(salePrice, bookingDate, req.body.installments, req.body.installment_settings)
      : null;

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
      sale_price: salePrice,
      token_amount: extra, // Only NEW money; original draw receipts are transferred separately.
      first_installment_amount: installmentPlan?.firstInstallment || null,
      token_payment_from: req.body.token_payment_from || 'CASH',
      token_payment_date: req.body.token_payment_date || todayIST(),
      token_bank_name: clean(req.body.token_bank_name), token_branch: clean(req.body.token_branch),
      token_bank_details: clean(req.body.token_bank_details), token_cheque_no: clean(req.body.token_cheque_no),
      token_narration: clean(req.body.token_narration), token_received_by: clean(req.body.token_received_by),
      booking_agent_id: req.body.booking_agent_id || null,
      payment_plan: paymentPlan,
      booking_date: bookingDate,
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
              booking_id = $3, kyc_case_id = (SELECT id FROM kyc_cases WHERE booking_id = $3 ORDER BY id DESC LIMIT 1), status = 'ALLOTTED', updated_at = now()
        WHERE id = $4`,
      [plot.id, req.user.id, booking.id, registration.id]
    );
    await drawModel.logEvent(
      registration.id, 'ALLOTTED',
      { plot_id: plot.id, plot_no: plot.plot_no, block: plot.block, booking_id: booking.id, booking_no },
      req.user.id, client
    );
    const settings = installmentPlan?.settings;
    await client.query(
      `UPDATE plots SET status = 'BOOKED', buyer_name = (SELECT full_name FROM members WHERE id = $1),
         booking_date = $2, sale_price = $3, first_installment = $4,
         installments_enabled = $5, interest_enabled = $6, interest_rate = $7,
         interest_type = $8, grace_period_days = $9, penalty_enabled = $10,
         penalty_rate = $11, penalty_type = $12, free_to_sale_days = $13
       WHERE id = $14`,
      [registration.client_member_id, bookingDate, salePrice,
        installmentPlan?.firstInstallment || 0, !!settings,
        settings?.interest_enabled || false, settings?.interest_rate || 0,
        settings?.interest_type || 'per_month', settings?.grace_period_days ?? 15,
        settings?.penalty_enabled || false, settings?.penalty_rate || 0,
        settings?.penalty_type || 'per_day', settings?.free_to_sale_days || 0, plot.id]
    );
    if (installmentPlan) {
      const values = installmentPlan.rows.flatMap((row, index) => [plot.id, row.installment_name, row.amount, row.due_date, index + 1]);
      const placeholders = installmentPlan.rows.map((_, index) => {
        const n = index * 5;
        return `($${n + 1}, $${n + 2}, $${n + 3}, $${n + 4}, $${n + 5})`;
      });
      await client.query(
        `INSERT INTO plot_installments (plot_id, installment_name, amount, due_date, sort_order)
         VALUES ${placeholders.join(', ')}`,
        values
      );
    }
    ledger_sync = await syncDrawLedgerToPlot(registration.id, client);
    if (!ledger_sync.ok) throw workflowError('Payment transfer failed; allotment was rolled back. Retry after resolving the ledger issue.', 409);
    if (extra) {
      token_sync = await syncTokenPayment(booking, client);
      if (!token_sync.ok) throw workflowError('New payment could not be recorded; the booking was rolled back', 409);
    }
    await client.query('COMMIT');
    bookingForSync = { ...booking, booking_no };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // The unit and receipt ledger are already committed atomically. Complete existing
  // agent attribution/commission enrichment after commit; report its result to the UI.
  const plot_sync = await syncPlotBookingToAccounting(bookingForSync, pool);


  return { booking: bookingForSync, plot_sync, ledger_sync, token_sync, draw_credit_amount: creditAmount };
}

export const allotShop = asyncHandler(async (req, res) => {
  const result = await allotDrawBooking({ registrationId: req.params.id, body: req.body, user: req.user });
  const detail = await buildDetail(req.params.id, pool);
  res.json({ ...detail, plot_sync: result.plot_sync, ledger_sync: result.ledger_sync });
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
  const { required_amount, scheme_name, notes, draw_opening_date } = req.body;
  const hasAmount = required_amount !== undefined && required_amount !== null && required_amount !== '';
  const amount = hasAmount ? money(required_amount, 'Required amount') : null;
  if (draw_opening_date !== undefined && (!validDate(draw_opening_date) || draw_opening_date < todayIST())) throw workflowError('Select a current or future opening date');
  if (hasAmount && (!amount || amount <= 0)) {
    return res.status(400).json({ message: 'required_amount (draw registration amount) must be greater than zero' });
  }
  if (!hasAmount && scheme_name === undefined && notes === undefined && draw_opening_date === undefined) {
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

    if (draw_opening_date !== undefined && ['WINNER', 'ALLOTTED', 'CANCELLED'].includes(registration.status)) throw workflowError('Opening date is locked after selection or cancellation', 409);
    if (draw_opening_date !== undefined && draw_opening_date !== registration.draw_opening_date) await drawModel.logEvent(registration.id, 'DRAW_SCHEDULED', { from: registration.draw_opening_date, to: draw_opening_date }, req.user.id, client);
    const sets = [];
    const params = [];
    if (draw_opening_date !== undefined) { params.push(draw_opening_date); sets.push(`draw_opening_date = $${params.length}`); }
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
      'SELECT id, status, slip_no FROM draw_registrations WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    const registration = regRows[0];
    if (!registration) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Draw registration not found' });
    }
    if (registration.slip_no || await drawModel.getTotalPaid(registration.id, client) > 0) throw workflowError('Paid or issued registrations must be retained. Cancel instead of deleting.', 409);
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
    draw_opening_date: d.draw_opening_date,
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

/** A paginated front-desk queue, with the same network visibility as draw details. */
export const listWorkflow = asyncHandler(async (req, res) => {
  const siteId = Number(req.query.site_id);
  if (!Number.isInteger(siteId) || siteId <= 0) throw workflowError('Select a site');
  const stage = req.query.stage || null;
  if (stage && !['PAYMENT', 'KYC', 'DOCUMENTS', 'DRAW', 'ALLOTMENT', 'BOOKED', 'CANCELLED'].includes(stage)) throw workflowError('Invalid workflow stage');
  const page = Math.max(1, Math.min(100000, parseInt(req.query.page, 10) || 1));
  const visibleUserIds = await getVisibleUserIds(req.user);
  res.json(await drawModel.workflow({ siteId, stage, page, q: String(req.query.q || ''), visibleUserIds }, pool));
});

/** KYC is opened at registration; this remains an idempotent compatibility endpoint. */
export const startDrawKyc = asyncHandler(async (req, res) => {
  const visibleUserIds = await getVisibleUserIds(req.user);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM draw_registrations WHERE id = $1 FOR UPDATE', [req.params.id]);
    const registration = rows[0];
    if (!registration) throw workflowError('Registration not found', 404);
    if (visibleUserIds && !visibleUserIds.includes(registration.agent_user_id) && !visibleUserIds.includes(registration.created_by)) throw workflowError('This registration belongs to another network', 403);
    if (registration.status === 'CANCELLED') throw workflowError('Registration is cancelled', 409);
    const total = await drawModel.getTotalPaid(registration.id, client);
    if (Number(registration.required_amount) <= 0 || total < Number(registration.required_amount)) throw workflowError('Collect the full booking amount before starting KYC', 409);
    if (!registration.kyc_case_id) {
      const kycCase = await kycCaseModel.getOrCreateForMember({ memberId: registration.client_member_id, siteId: registration.site_id, createdBy: req.user.id, visibleUserIds }, client);
      await client.query('UPDATE draw_registrations SET kyc_case_id = $1, updated_at = now() WHERE id = $2', [kycCase.id, registration.id]);
      await drawModel.logEvent(registration.id, 'KYC_OPENED', { kyc_case_id: kycCase.id }, req.user.id, client);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
  res.json(await buildDetail(req.params.id));
});
