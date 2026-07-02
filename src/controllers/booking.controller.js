import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import bookingModel from '../models/Booking.model.js';
import kycCaseModel from '../models/KycCase.model.js';
import { deleteKycDocument, getKycDocumentUrl, uploadKycDocument, getPublicKycUrl } from '../utils/s3.js';
import { syncPlotBookingToAccounting } from '../services/plotBookingSync.js';
import { syncTokenPayment } from '../services/tokenPaymentSync.js';
import { buildVerifyUrl, ReceiptType } from '../utils/receiptToken.js';

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
 * that the printable booking form renders editable from the Members screen.
 */
const CLIENT_FIELDS = [
  'full_name', 'father_name', 'mother_name', 'spouse_name', 'gender', 'date_of_birth',
  'nationality', 'religion', 'marital_status', 'qualification', 'occupation', 'company_name',
  'phone', 'alt_phone', 'whatsapp', 'email', 'address', 'city', 'state', 'pincode',
  'aadhar_no', 'pan_no', 'voter_id', 'passport_no', 'driving_license_no', 'gst_no',
  'bank_name', 'account_no', 'ifsc_code', 'branch',
  'nominee_name', 'nominee_relation', 'nominee_phone', 'reference', 'notes', 'photo',
];

// Normalise '' → null so optional date/number-ish columns don't choke on empty strings.
const clean = (v) => (v === '' ? null : v);

/** GET /bookings?site_id=&status=&kyc_status=&q=&client_member_id= */
export const listBookings = asyncHandler(async (req, res) => {
  const { site_id, status, kyc_status, q, client_member_id } = req.query;
  const rows = await bookingModel.list(
    { siteId: site_id, status, kycStatus: kyc_status, q, clientMemberId: client_member_id },
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
 */
export const getDashboard = asyncHandler(async (req, res) => {
  const siteId = Number(req.query.site_id);
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });
  const days = Math.min(90, Math.max(7, Number(req.query.days) || 14));

  const recentSelect = `
    SELECT b.id, b.booking_no, b.status, b.kyc_status, b.booking_date, b.created_at,
           b.token_amount, b.booked_by, b.buyer_name,
           m.full_name AS client_name, m.photo AS client_photo,
           p.plot_no, p.block AS plot_block
    FROM bookings b
    LEFT JOIN members m ON m.id = b.client_member_id
    LEFT JOIN plots   p ON p.id = b.plot_id
    WHERE b.site_id = $1`;

  const [kpi, docs, dist, trend, recent, queue, topExec, activity] = await Promise.all([
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
       FROM bookings WHERE site_id = $1`,
      [siteId]
    ),
    pool.query(
      `SELECT count(*)::int AS docs,
              count(*) FILTER (WHERE ocr_status = 'DONE')::int AS ocr_done,
              count(*) FILTER (WHERE ocr_status IN ('PENDING','PROCESSING'))::int AS ocr_pending,
              count(*) FILTER (WHERE ocr_status = 'FAILED')::int AS ocr_failed
       FROM documents WHERE site_id = $1`,
      [siteId]
    ),
    pool.query(
      `SELECT COALESCE(kyc_status, 'NOT_STARTED') AS key, count(*)::int AS value
       FROM bookings WHERE site_id = $1 GROUP BY 1`,
      [siteId]
    ),
    pool.query(
      `SELECT to_char(d, 'YYYY-MM-DD') AS key,
              count(b.id)::int AS submitted,
              count(b.id) FILTER (WHERE b.kyc_status = 'VERIFIED' OR b.status = 'CONFIRMED')::int AS verified,
              COALESCE(SUM(b.token_amount), 0)::float AS token
       FROM generate_series(now()::date - ($2::int - 1), now()::date, interval '1 day') AS d
       LEFT JOIN bookings b ON b.site_id = $1 AND b.booking_date::date = d::date
       GROUP BY d ORDER BY d`,
      [siteId, days]
    ),
    pool.query(`${recentSelect} ORDER BY b.created_at DESC LIMIT 8`, [siteId]),
    pool.query(
      `${recentSelect}
         AND b.status NOT IN ('CANCELLED','CONFIRMED')
         AND b.kyc_status NOT IN ('VERIFIED','REJECTED')
       ORDER BY b.booking_date ASC NULLS LAST, b.created_at ASC LIMIT 5`,
      [siteId]
    ),
    pool.query(
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
         WHERE b.site_id = $1
         UNION ALL
         SELECT 'VERIFIED', k.verified_at, b.id, b.booking_no, m.full_name, NULL
         FROM kyc_cases k
         JOIN bookings b ON b.id = k.booking_id
         LEFT JOIN members m ON m.id = b.client_member_id
         WHERE b.site_id = $1 AND k.verified_at IS NOT NULL
         UNION ALL
         SELECT 'OCR_DONE', d.ocr_completed_at, b.id, b.booking_no, m.full_name, d.type
         FROM documents d
         JOIN kyc_cases k ON k.id = d.kyc_case_id
         JOIN bookings b ON b.id = k.booking_id
         LEFT JOIN members m ON m.id = b.client_member_id
         WHERE b.site_id = $1 AND d.ocr_status = 'DONE' AND d.ocr_completed_at IS NOT NULL
       ) ev
       WHERE ev.at IS NOT NULL
       ORDER BY ev.at DESC LIMIT 20`,
      [siteId]
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
    days,
    generated_at: new Date().toISOString(),
  });
});

/** POST /bookings */
export const createBooking = asyncHandler(async (req, res) => {
  const {
    site_id, plot_id, client_member_id,
    sale_price, token_amount, payment_plan,
    booking_date, buyer_name, notes, booking_agent_id,
  } = req.body;

  if (!site_id) return res.status(400).json({ message: 'site_id is required' });
  if (!client_member_id) return res.status(400).json({ message: 'client_member_id is required' });

  // Optional token-payment capture fields (only what the form supplied; '' → null).
  const tokenData = {};
  for (const f of TOKEN_PAYMENT_FIELDS) {
    if (req.body[f] !== undefined) tokenData[f] = clean(req.body[f]);
  }

  const created = await bookingModel.create({
    site_id,
    plot_id: plot_id || null,
    client_member_id,
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
  // Open a KYC case up front so the UI can immediately accept uploads.
  await kycCaseModel.getOrCreateForBooking(created, pool);

  // Propagate to the accounting plot ledger (BOOKED + buyer + Booking By + commission).
  // Fire-and-forget semantics: a sync failure must never fail the booking itself.
  let plot_sync = null;
  if (created.plot_id) {
    plot_sync = await syncPlotBookingToAccounting(created, pool);
  }

  // Mirror the token amount into the accounting plot_payments ledger (runs AFTER the
  // plot sync so plots.booking_by is populated for the payment's "Booked By").
  const token_sync = await syncTokenPayment(created, pool);

  res.status(201).json({ ...created, booking_no, plot_sync, token_sync });
});

/** GET /bookings/:id  → booking + kyc cases + documents (with latest OCR result) */
export const getBooking = asyncHandler(async (req, res) => {
  const booking = await bookingModel.getDetail(req.params.id, pool);
  if (!booking) return res.status(404).json({ message: 'Booking not found' });

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

/** PUT /bookings/:id — editable fields only. */
export const updateBooking = asyncHandler(async (req, res) => {
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

/** POST /bookings/:id/cancel — status change only (no deletion). */
export const cancelBooking = asyncHandler(async (req, res) => {
  const updated = await bookingModel.update(req.params.id, { status: 'CANCELLED' }, pool);
  if (!updated) return res.status(404).json({ message: 'Booking not found' });
  // Drop the still-pending token payment (CANCELLED ⇒ removal path). Approved rows kept.
  const token_sync = await syncTokenPayment(updated, pool);
  res.json({ ...updated, token_sync });
});

/**
 * DELETE /bookings/:id — permanently delete a booking.
 * SAFE: only touches booking-module tables. The DB cascade removes this booking's
 * kyc_cases → documents → ocr_results; the linked member/plot are NOT affected
 * (those FKs are SET NULL/RESTRICT and point outward). Uploaded files are cleaned first.
 */
export const deleteBooking = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const booking = await bookingModel.findById(id, pool);
  if (!booking) return res.status(404).json({ message: 'Booking not found' });

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

  await pool.query('DELETE FROM bookings WHERE id = $1', [id]);
  res.json({ message: 'Booking deleted', id: Number(id), removedDocuments: docs.length, token_sync });
});

/** GET /clients/search?site_id=&q= — searches existing members (CLIENT). */
export const searchClients = asyncHandler(async (req, res) => {
  const { site_id, q } = req.query;
  const params = [];
  const where = [`member_type = 'CLIENT'`];
  if (site_id) { params.push(site_id); where.push(`site_id = $${params.length}`); }
  if (q) {
    params.push(`%${q}%`);
    where.push(`(full_name ILIKE $${params.length} OR phone ILIKE $${params.length} OR aadhar_no ILIKE $${params.length} OR pan_no ILIKE $${params.length})`);
  }
  const { rows } = await pool.query(
    `SELECT id, full_name, phone, email, city, aadhar_no, pan_no, photo, occupation, father_name
     FROM members WHERE ${where.join(' AND ')} ORDER BY full_name ASC LIMIT 50`,
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
