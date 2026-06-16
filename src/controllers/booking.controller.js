import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import bookingModel from '../models/Booking.model.js';
import kycCaseModel from '../models/KycCase.model.js';
import { deleteKycDocument, getKycDocumentUrl, uploadKycDocument, getPublicKycUrl } from '../utils/s3.js';

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

/** POST /bookings */
export const createBooking = asyncHandler(async (req, res) => {
  const {
    site_id, plot_id, client_member_id,
    sale_price, token_amount, payment_plan,
    booking_date, buyer_name, notes,
  } = req.body;

  if (!site_id) return res.status(400).json({ message: 'site_id is required' });
  if (!client_member_id) return res.status(400).json({ message: 'client_member_id is required' });

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
    notes: notes || null,
    created_by: req.user?.id || null,
  }, pool);

  const booking_no = await bookingModel.generateBookingNo(created.id, created.booking_date, pool);
  // Open a KYC case up front so the UI can immediately accept uploads.
  await kycCaseModel.getOrCreateForBooking(created, pool);

  res.status(201).json({ ...created, booking_no });
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
  res.json({ ...booking, kyc_cases: cases });
});

/** PUT /bookings/:id — editable fields only. */
export const updateBooking = asyncHandler(async (req, res) => {
  const allowed = ['plot_id', 'sale_price', 'token_amount', 'payment_plan', 'status', 'buyer_name', 'notes', 'booking_date'];
  const data = {};
  for (const k of allowed) if (req.body[k] !== undefined) data[k] = req.body[k];
  if (!Object.keys(data).length) return res.status(400).json({ message: 'No editable fields provided' });

  const updated = await bookingModel.update(req.params.id, data, pool);
  if (!updated) return res.status(404).json({ message: 'Booking not found' });
  res.json(updated);
});

/** POST /bookings/:id/cancel — status change only (no deletion). */
export const cancelBooking = asyncHandler(async (req, res) => {
  const updated = await bookingModel.update(req.params.id, { status: 'CANCELLED' }, pool);
  if (!updated) return res.status(404).json({ message: 'Booking not found' });
  res.json(updated);
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

  await pool.query('DELETE FROM bookings WHERE id = $1', [id]);
  res.json({ message: 'Booking deleted', id: Number(id), removedDocuments: docs.length });
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
            pp.payment_type, pp.payment_from, pp.bank_details, pp.bank_name,
            pp.cheque_no, pp.cheque_status, pp.received_by, pp.narration, pp.status,
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
