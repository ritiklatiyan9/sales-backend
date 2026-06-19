import pool from '../config/db.js';

/**
 * Token-amount → accounting plot-payment sync.
 *
 * When a booking carries a `token_amount` AND has a plot assigned, mirror it into the
 * SHARED accounting `plot_payments` ledger as ONE transaction (status 'pending'),
 * exactly like a payment entered from the accounting /plot-payments screen. It then
 * shows under its site + plot, fires the existing cashflow/daybook DB triggers, and
 * can be approved + receipt-printed in Accounting — the accounting flow is unchanged.
 *
 * Design notes (mirrors services/plotBookingSync.js):
 *   - Writes directly to the shared DB (no HTTP coupling) — same additive pattern.
 *   - Fully defensive: any failure is logged + swallowed so it can NEVER break a
 *     booking create/update. Missing tables (42P01) are ignored.
 *   - Idempotent via bookings.token_payment_id: a re-sync UPDATEs the same row rather
 *     than inserting a duplicate.
 *   - SAFE lifecycle: the linked row is only touched while it is still 'pending'. Once
 *     Accounting approves it, Booking never overwrites or deletes it (Accounting is the
 *     source of truth). token_amount ≤ 0 / CANCELLED status removes a still-pending row.
 */

// FROM modes that count as a BANK payment type — copied from the accounting frontend
// (Frontend/src/pages/PlotPayments.jsx) so the derivation matches 1:1.
const BANK_TYPE_FROMS = ['BANK', 'TRANSFER', 'CHEQUE', 'UPI', 'NEFT', 'RTGS', 'IMPS'];
const derivePaymentType = (from) =>
  from === 'CHEQUE' ? 'CHEQUE' : BANK_TYPE_FROMS.includes(from) ? 'BANK' : 'CASH';

// Normalise a text field the way the accounting createPayment does: trim + UPPER, '' → null.
const up = (v) => {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t ? t.toUpperCase() : null;
};

const todayISO = () => new Date().toISOString().slice(0, 10);

/** Delete the linked plot_payment IFF it still exists and is 'pending'; clear the link. */
const removePendingTokenPayment = async (booking, db) => {
  if (!booking.token_payment_id) return { ok: true, skipped: 'no_link' };
  const { rows } = await db.query(
    `SELECT id, status FROM plot_payments WHERE id = $1`,
    [parseInt(booking.token_payment_id)]
  );
  const row = rows[0];
  if (!row) {
    await db.query(`UPDATE bookings SET token_payment_id = NULL WHERE id = $1`, [booking.id]);
    return { ok: true, action: 'link_cleared', reason: 'payment_already_gone' };
  }
  if (String(row.status || '').toLowerCase() !== 'pending') {
    // Approved/rejected — Accounting owns it now. Leave it; just drop our link so we
    // stop trying to manage it.
    await db.query(`UPDATE bookings SET token_payment_id = NULL WHERE id = $1`, [booking.id]);
    return { ok: true, action: 'link_cleared', reason: 'approved_locked', payment_id: row.id };
  }
  await db.query(`DELETE FROM plot_payments WHERE id = $1`, [row.id]);
  await db.query(`UPDATE bookings SET token_payment_id = NULL WHERE id = $1`, [booking.id]);
  return { ok: true, action: 'deleted', payment_id: row.id };
};

/**
 * Main entry. `booking` must carry: id, plot_id, site_id, client_member_id, status,
 * booking_date, created_by, token_amount, and the token_* capture fields.
 * Returns a summary object; never throws.
 */
export const syncTokenPayment = async (booking, db = pool) => {
  try {
    const tokenAmount = parseFloat(booking?.token_amount) || 0;
    const isCancelled = String(booking?.status || '').toUpperCase() === 'CANCELLED';

    // ── Removal path ── no plot to attach to, nothing owed, or booking cancelled.
    if (!booking?.plot_id || tokenAmount <= 0 || isCancelled) {
      return await removePendingTokenPayment(booking, db);
    }

    // ── Upsert path ── load the accounting plot + client buyer name.
    const plotRes = await db.query(
      `SELECT id, site_id, booking_by FROM plots WHERE id = $1`,
      [parseInt(booking.plot_id)]
    );
    const plot = plotRes.rows[0];
    if (!plot) return { ok: false, reason: 'plot_not_found' };

    const clientRes = await db.query(
      `SELECT full_name FROM members WHERE id = $1`,
      [parseInt(booking.client_member_id)]
    );
    const buyerName = up(clientRes.rows[0]?.full_name);

    const paymentFrom = up(booking.token_payment_from) || 'CASH';
    const paymentType = derivePaymentType(paymentFrom);
    const isBankish = paymentType === 'BANK' || paymentType === 'CHEQUE';
    const paymentDate = booking.token_payment_date || booking.booking_date || todayISO();

    // Column → value map shared by INSERT and UPDATE so the two paths can't drift.
    const fields = {
      plot_id: plot.id,
      site_id: plot.site_id,
      date: paymentDate,
      payment_from: paymentFrom,
      payment_type: paymentType,
      bank_details: up(booking.token_bank_details),
      bank_name: isBankish ? up(booking.token_bank_name) : null,
      branch: isBankish ? up(booking.token_branch) : null,
      narration: up(booking.token_narration),
      received_by: up(booking.token_received_by),
      amount: tokenAmount,
      cheque_no: paymentFrom === 'CHEQUE' ? (booking.token_cheque_no ? String(booking.token_cheque_no).trim() : null) : null,
      cheque_status: paymentType === 'CHEQUE' ? 'PENDING' : null,
      buyer_name: buyerName,
      booked_by: up(plot.booking_by),
    };

    // If a linked payment already exists, decide update vs. locked.
    if (booking.token_payment_id) {
      const { rows } = await db.query(
        `SELECT id, status FROM plot_payments WHERE id = $1`,
        [parseInt(booking.token_payment_id)]
      );
      const existing = rows[0];
      if (existing) {
        if (String(existing.status || '').toLowerCase() !== 'pending') {
          // Accounting approved/rejected this — never overwrite. Source of truth = Accounting.
          return { ok: true, skipped: 'approved_locked', payment_id: existing.id, status: existing.status };
        }
        await db.query(
          `UPDATE plot_payments SET
              date = $1, payment_from = $2, payment_type = $3, bank_details = $4,
              bank_name = $5, branch = $6, narration = $7, received_by = $8,
              amount = $9::numeric, cheque_no = $10, cheque_status = $11,
              buyer_name = $12, booked_by = $13, updated_at = NOW()
            WHERE id = $14`,
          [
            fields.date, fields.payment_from, fields.payment_type, fields.bank_details,
            fields.bank_name, fields.branch, fields.narration, fields.received_by,
            fields.amount, fields.cheque_no, fields.cheque_status,
            fields.buyer_name, fields.booked_by, existing.id,
          ]
        );
        return { ok: true, action: 'updated', payment_id: existing.id, amount: fields.amount };
      }
      // Link points at a row that no longer exists → fall through and insert a fresh one.
    }

    // INSERT a new pending payment, then store its id on the booking (idempotency link).
    const ins = await db.query(
      `INSERT INTO plot_payments (
         plot_id, site_id, date, payment_from, payment_type, bank_details, bank_name,
         branch, narration, received_by, amount, created_by, status,
         cheque_no, cheque_status, buyer_name, booked_by
       ) VALUES (
         $1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10, $11::numeric, $12, 'pending',
         $13, $14, $15, $16
       ) RETURNING id`,
      [
        fields.plot_id, fields.site_id, fields.date, fields.payment_from, fields.payment_type,
        fields.bank_details, fields.bank_name, fields.branch, fields.narration, fields.received_by,
        fields.amount, booking.created_by ? parseInt(booking.created_by) : null,
        fields.cheque_no, fields.cheque_status, fields.buyer_name, fields.booked_by,
      ]
    );
    const paymentId = ins.rows[0]?.id;
    if (paymentId) {
      await db.query(`UPDATE bookings SET token_payment_id = $1 WHERE id = $2`, [paymentId, booking.id]);
    }
    return { ok: true, action: 'created', payment_id: paymentId, amount: fields.amount };
  } catch (err) {
    if (err?.code === '42P01') return { ok: false, reason: 'table_missing' };
    console.error('[tokenPaymentSync] failed for booking', booking?.id, '-', err.message);
    return { ok: false, reason: 'error', error: err.message };
  }
};

export default syncTokenPayment;
