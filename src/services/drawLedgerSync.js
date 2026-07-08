import pool from '../config/db.js';
import { derivePaymentType, up } from './tokenPaymentSync.js';

/**
 * Draw Payment Ledger → accounting plot-payment sync.
 *
 * On shop allotment the customer's draw payments ARE the booking money received, so
 * every ledger receipt is mirrored into the SHARED plot_payments table (status
 * 'pending', one row per receipt with its real date/mode/bank details) — the booking's
 * /bookings/:id/payments page and Accounting then both show the amounts, and the
 * existing cashflow/daybook triggers + approval flow work unchanged.
 *
 * Design (mirrors tokenPaymentSync):
 *   - Fully defensive: failures are logged + swallowed, an allotment is never voided.
 *   - Idempotent via draw_payments.plot_payment_id — re-running skips receipts whose
 *     mirrored row still exists; a dangling link (row deleted in Accounting) re-inserts.
 *   - Never touches mirrored rows after insert — Accounting owns them from there.
 */
export const syncDrawLedgerToPlot = async (registrationId, db = pool) => {
  try {
    const { rows: regRows } = await db.query(
      `SELECT r.id, r.registration_no, r.status, r.allotted_plot_id, r.client_member_id,
              p.site_id AS plot_site_id, p.booking_by,
              m.full_name AS buyer_name
         FROM draw_registrations r
         LEFT JOIN plots   p ON p.id = r.allotted_plot_id
         LEFT JOIN members m ON m.id = r.client_member_id
        WHERE r.id = $1`,
      [registrationId]
    );
    const reg = regRows[0];
    if (!reg) return { ok: false, reason: 'registration_not_found' };
    if (reg.status !== 'ALLOTTED' || !reg.allotted_plot_id) {
      return { ok: false, reason: 'not_allotted' };
    }

    const { rows: payments } = await db.query(
      'SELECT * FROM draw_payments WHERE draw_registration_id = $1 ORDER BY id',
      [registrationId]
    );

    let created = 0;
    let skipped = 0;
    let total = 0;
    for (const pay of payments) {
      // Idempotency: skip receipts whose mirrored row still exists.
      if (pay.plot_payment_id) {
        const { rows } = await db.query('SELECT id FROM plot_payments WHERE id = $1', [pay.plot_payment_id]);
        if (rows[0]) { skipped += 1; continue; }
      }

      const paymentFrom = up(pay.payment_from) || 'CASH';
      const paymentType = derivePaymentType(paymentFrom);
      const isBankish = paymentType === 'BANK' || paymentType === 'CHEQUE';
      const narration = up(
        [pay.narration, `DRAW ${reg.registration_no}${pay.receipt_no ? ` · ${pay.receipt_no}` : ''}`]
          .filter(Boolean).join(' · ')
      );

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
          reg.allotted_plot_id, reg.plot_site_id, pay.payment_date, paymentFrom, paymentType,
          up(pay.bank_details), isBankish ? up(pay.bank_name) : null,
          isBankish ? up(pay.branch) : null, narration, up(pay.received_by),
          Number(pay.amount), pay.created_by || null,
          paymentFrom === 'CHEQUE' ? (pay.cheque_no ? String(pay.cheque_no).trim() : null) : null,
          paymentType === 'CHEQUE' ? 'PENDING' : null,
          up(reg.buyer_name), up(reg.booking_by),
        ]
      );
      const plotPaymentId = ins.rows[0]?.id;
      if (plotPaymentId) {
        await db.query('UPDATE draw_payments SET plot_payment_id = $1 WHERE id = $2', [plotPaymentId, pay.id]);
        created += 1;
        total += Number(pay.amount);
      }
    }
    return { ok: true, created, skipped, total_synced: total, receipts: payments.length };
  } catch (err) {
    if (err?.code === '42P01' || err?.code === '42703') return { ok: false, reason: 'table_or_column_missing' };
    console.error('[drawLedgerSync] failed for registration', registrationId, '-', err.message);
    return { ok: false, reason: 'error', error: err.message };
  }
};

export default syncDrawLedgerToPlot;
