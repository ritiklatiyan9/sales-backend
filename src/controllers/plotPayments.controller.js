import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { isAdminRole } from '../services/agentNetwork.service.js';
import { buildVerifyUrl, ReceiptType } from '../utils/receiptToken.js';
import { derivePaymentType, up } from '../services/tokenPaymentSync.js';

/**
 * Plot Payments — the booking-side window onto the SHARED accounting `plot_payments`
 * ledger (the same table the accounting /plot-payments module manages).
 *
 * Read: the ledger LISTS non-cash instruments only (payment_type BANK/CHEQUE) — cash
 * entries live in the accounting cash ledger — but the rollups cover everything so
 * balances match the accounting screen. BOUNCED/RETURNED cheques are excluded from
 * every total (mirroring the accounting model) yet still returned in the list so the
 * UI can show them struck through.
 *
 * Write: inserts a 'pending' row with exactly the column set tokenPaymentSync uses
 * (proven against the accounting cashflow DB triggers). Approval, receipts numbering
 * and corrections remain Accounting's job — source of truth is unchanged.
 */

// Same PLT receipt payload as the accounting plot.controller + getBooking, signed with
// the shared RECEIPT_VERIFY_SECRET so the QR validates on the public verify page.
const plotVerifyUrl = (pay, plot) => buildVerifyUrl({
  t: ReceiptType.PLOT,
  i: pay.id,
  pn: pay.buyer_name || plot.buyer_name || null,
  pl: [plot.block, plot.plot_no].filter(Boolean).join(' ') || null,
  a: Number(pay.amount) || 0,
  d: pay.date || null,
  pm: pay.payment_from || pay.payment_type || null,
  sn: plot.site_name || null,
  sy: plot.site_city || null,
  ss: plot.site_state || null,
});

/** GET /plot-payments?plot_id= — plot + rollups + full ledger (cash included). Admin roles only. */
export const listPlotPayments = asyncHandler(async (req, res) => {
  if (!isAdminRole(req.user?.role)) {
    return res.status(403).json({ message: 'Only admins can view the plot payment ledger' });
  }
  const plotId = parseInt(req.query.plot_id);
  if (!plotId) return res.status(400).json({ message: 'plot_id is required' });

  const { rows: plotRows } = await pool.query(
    `SELECT p.id, p.plot_no, p.block, p.plot_size, p.sale_price, p.status, p.buyer_name,
            p.site_id, s.name AS site_name, s.city AS site_city, s.state AS site_state,
            COALESCE(t.total_received, 0)::numeric AS total_received,
            COALESCE(t.received_bank, 0)::numeric  AS received_bank,
            COALESCE(t.received_cash, 0)::numeric  AS received_cash,
            COALESCE(t.payment_count, 0)::int      AS payment_count
       FROM plots p
       LEFT JOIN sites s ON s.id = p.site_id
       LEFT JOIN (
            SELECT plot_id,
                   SUM(amount) AS total_received,
                   SUM(amount) FILTER (WHERE payment_type IN ('BANK','CHEQUE')) AS received_bank,
                   SUM(amount) FILTER (WHERE payment_type = 'CASH') AS received_cash,
                   COUNT(*) AS payment_count
              FROM plot_payments
             WHERE COALESCE(cheque_status, '') NOT IN ('BOUNCED', 'RETURNED')
             GROUP BY plot_id
       ) t ON t.plot_id = p.id
      WHERE p.id = $1`,
    [plotId]
  );
  const plot = plotRows[0];
  if (!plot) return res.status(404).json({ message: 'Plot not found' });

  // ALL payment types listed — cash rows included (e.g. draw registration amounts paid
  // in cash) so the booking page shows every rupee received; the accounting cash
  // ledger remains the approval/receipt authority for CASH exactly as before.
  const { rows: payments } = await pool.query(
    `SELECT id, plot_id, site_id, date, amount, payment_from, payment_type,
            bank_name, branch, bank_details, cheque_no, cheque_status,
            narration, received_by, buyer_name, booked_by, status, created_at
       FROM plot_payments
      WHERE plot_id = $1
      ORDER BY date ASC, created_at ASC, id ASC`,
    [plotId]
  );

  res.json({
    plot,
    payments: payments.map((p) => ({ ...p, verifyUrl: plotVerifyUrl(p, plot) })),
  });
});

/**
 * POST /plot-payments — record a payment (CASH or BANK/CHEQUE/UPI/…) against ANY plot,
 * exactly like the accounting add-payment screen. Admin roles only.
 * Body: { plot_id, date, amount, payment_from, bank_name, branch, bank_details,
 *         cheque_no, narration, received_by }.
 */
export const createPlotPayment = asyncHandler(async (req, res) => {
  if (!isAdminRole(req.user?.role)) {
    return res.status(403).json({ message: 'Only admins can record plot payments' });
  }
  const {
    plot_id, date, amount, payment_from, bank_name, branch, bank_details,
    cheque_no, narration, received_by,
  } = req.body;
  const plotId = parseInt(plot_id);
  if (!plotId) return res.status(400).json({ message: 'plot_id is required' });
  const amt = Number(amount);
  if (!amt || amt <= 0) return res.status(400).json({ message: 'amount must be greater than zero' });

  const { rows: plotRows } = await pool.query(
    `SELECT p.id, p.site_id, p.plot_no, p.block, p.buyer_name, p.booking_by,
            s.name AS site_name, s.city AS site_city, s.state AS site_state
       FROM plots p
       LEFT JOIN sites s ON s.id = p.site_id
      WHERE p.id = $1`,
    [plotId]
  );
  const plot = plotRows[0];
  if (!plot) return res.status(404).json({ message: 'Plot not found' });

  const paymentFrom = up(payment_from) || 'CASH';
  const paymentType = derivePaymentType(paymentFrom);
  const isBankish = paymentType === 'BANK' || paymentType === 'CHEQUE';

  const { rows } = await pool.query(
    `INSERT INTO plot_payments (
       plot_id, site_id, date, payment_from, payment_type, bank_details, bank_name,
       branch, narration, received_by, amount, created_by, status,
       cheque_no, cheque_status, buyer_name, booked_by
     ) VALUES (
       $1, $2, COALESCE($3::date, CURRENT_DATE), $4, $5, $6, $7, $8, $9, $10,
       $11::numeric, $12, 'pending', $13, $14, $15, $16
     ) RETURNING *`,
    [
      plot.id, plot.site_id, date || null, paymentFrom, paymentType,
      up(bank_details), isBankish ? up(bank_name) : null, isBankish ? up(branch) : null,
      up(narration), up(received_by), amt, req.user?.id || null,
      paymentFrom === 'CHEQUE' ? (cheque_no ? String(cheque_no).trim() : null) : null,
      paymentType === 'CHEQUE' ? 'PENDING' : null,
      up(plot.buyer_name), up(plot.booking_by),
    ]
  );
  const payment = rows[0];
  res.status(201).json({ payment: { ...payment, verifyUrl: plotVerifyUrl(payment, plot) } });
});
