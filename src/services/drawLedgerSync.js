import pool from '../config/db.js';
import { derivePaymentType, up } from './tokenPaymentSync.js';

async function recordedDrawReceipts(db, registrationId) {
  const { rows: [schema] } = await db.query("SELECT to_regclass('public.pool_money_receipts') IS NOT NULL AS has_pool");
  if (!schema.has_pool) return new Map();
  const { rows } = await db.query(`SELECT r.id, r.source_id, r.plot_payment_id, c.id AS ledger_id,
      c.site_id, c.credit, c.debit, c.status, c.cheque_status, c.approved_by, c.approved_at
    FROM pool_money_receipts r
    LEFT JOIN LATERAL (SELECT * FROM cash_flow_entries
      WHERE source_module='pool_money_receipts' AND source_id=r.id FOR UPDATE) c ON true
    WHERE r.source_kind='draw' AND r.owner_id=$1 ORDER BY r.id FOR UPDATE OF r`, [registrationId]);
  return new Map(rows.map(row => [row.source_id, row]));
}

/**
 * Draw Payment Ledger → accounting plot-payment sync.
 *
 * On shop allotment the customer's draw payments ARE the booking money received, so
 * Each receipt becomes one shared plot payment with its original date and payment mode.
 * Captured Pool Money keeps its posting and approval. Legacy receipts enter as pending.
 *
 * Design (mirrors tokenPaymentSync):
 *   - Returns an explicit result; the allotment caller rolls back if transfer fails.
 *   - Idempotent via draw_payments.plot_payment_id — re-running skips receipts whose
 *     mirrored row still exists; a dangling link (row deleted in Accounting) re-inserts.
 *   - Never touches mirrored rows after insert — Accounting owns them from there.
 */
export const syncDrawLedgerToPlot = async (registrationId, db = pool, { requireAvailableCredit = false } = {}) => {
  if (db === pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await syncDrawLedgerToPlot(registrationId, client, { requireAvailableCredit });
      await client.query(result.ok ? 'COMMIT' : 'ROLLBACK');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally { client.release(); }
  }
  try {
    // All callers lock the registration, including retry/backfill jobs.
    await db.query('SELECT id FROM draw_registrations WHERE id = $1 FOR UPDATE', [registrationId]);
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
      'SELECT * FROM draw_payments WHERE draw_registration_id = $1 ORDER BY id FOR UPDATE',
      [registrationId]
    );
    const recorded = await recordedDrawReceipts(db, registrationId);

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
      const posting = recorded.get(pay.id);
      if (posting && (!posting.ledger_id || posting.plot_payment_id || posting.site_id !== reg.plot_site_id ||
          Number(posting.credit) !== Number(pay.amount) || Number(posting.debit) !== 0)) {
        return { ok: false, message: 'A Pool Money receipt differs from its Accounts entry. Review the receipt before booking.' };
      }
      const status = posting?.status || 'pending';
      const chequeStatus = posting?.cheque_status ?? (paymentType === 'CHEQUE' ? 'PENDING' : null);
      // A pending cheque can reserve the shop. Accounts determines when the payment posts.
      const usableCheque = paymentType !== 'CHEQUE' || chequeStatus === 'CLEARED'
        || (chequeStatus === 'PENDING' && status === 'pending');
      if (requireAvailableCredit && (!['pending', 'approved'].includes(status) || !usableCheque)) {
        return { ok: false, message: `Receipt ${pay.receipt_no || pay.id} is rejected or has an ineligible cheque status. Review it in Accounts.` };
      }
      const isBankish = paymentType === 'BANK' || paymentType === 'CHEQUE';
      const receiptText = posting || requireAvailableCredit ? value => value ?? null : up;
      const narration = receiptText(
        [pay.narration, `DRAW ${reg.registration_no}${pay.receipt_no ? ` · ${pay.receipt_no}` : ''}`]
          .filter(Boolean).join(' · ')
      );

      const ins = await db.query(
        `INSERT INTO plot_payments (
           plot_id, site_id, date, payment_from, payment_type, bank_details, bank_name,
           branch, narration, received_by, amount, created_by, status,
           cheque_no, cheque_status, buyer_name, booked_by, created_at${posting ? ', approved_by, approved_at' : ''}
         ) VALUES (
           $1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10, $11::numeric, $12, $13,
           $14, $15, $16, $17, COALESCE($18::timestamptz, now())${posting ? ', $19, $20' : ''}
         ) RETURNING id`,
        [
          reg.allotted_plot_id, reg.plot_site_id, pay.payment_date, paymentFrom, paymentType,
          isBankish ? receiptText(pay.bank_details) : null, isBankish ? receiptText(pay.bank_name) : null,
          isBankish ? receiptText(pay.branch) : null, narration, receiptText(pay.received_by),
          Number(pay.amount), pay.created_by || null, status,
          paymentFrom === 'CHEQUE' ? (pay.cheque_no ? String(pay.cheque_no).trim() : null) : null,
          chequeStatus, up(reg.buyer_name), up(reg.booking_by), pay.created_at,
          ...(posting ? [posting.approved_by, posting.approved_at] : []),
        ]
      );
      const plotPaymentId = ins.rows[0]?.id;
      // Same link Accounting's "map to bank" writes on the trigger-made ledger mirror,
      // so the receipt sits under the chosen bank in the Day Book (approval keeps it).
      if (plotPaymentId && isBankish && pay.bank_account_id && !posting) {
        await db.query(
          `UPDATE cash_flow_entries SET bank_account_id = $1, updated_at = NOW()
            WHERE source_module = 'plot_payments' AND source_id = $2 AND site_id = $3
              AND EXISTS (SELECT 1 FROM bank_accounts WHERE id = $1 AND site_id = $3)`,
          [pay.bank_account_id, plotPaymentId, reg.plot_site_id]
        );
      }
      if (plotPaymentId) {
        // The pool trigger moves the original cash-flow entry and deletes the temporary mirror.
        // A temporary projection must not become a restorable financial transaction.
        const oldSetting = posting && (await db.query("SELECT current_setting('app.recycle_bin_skip',true) AS value")).rows[0].value;
        if (posting) await db.query("SELECT set_config('app.recycle_bin_skip','on',true)");
        await db.query('UPDATE draw_payments SET plot_payment_id = $1 WHERE id = $2', [plotPaymentId, pay.id]);
        if (posting) {
          await db.query("SELECT set_config('app.recycle_bin_skip',$1,true)", [oldSetting || '']);
          const linked = await db.query(`SELECT 1 FROM pool_money_receipts r JOIN cash_flow_entries c
            ON c.id=$2 AND c.source_module='plot_payments' AND c.source_id=r.plot_payment_id
            WHERE r.id=$1 AND r.plot_payment_id=$3`, [posting.id, posting.ledger_id, plotPaymentId]);
          if (!linked.rows.length) return { ok: false, message: 'Accounts could not link the original Pool Money entry to the shop.' };
        }
        created += 1;
        total += Number(pay.amount);
      }
    }
    return { ok: true, created, skipped, total_synced: total, receipts: payments.length };
  } catch (err) {
    if (err.constraint === 'pool_money_period_locked') return { ok: false, message: 'This receipt belongs to a locked accounting period.' };
    if (err?.code === '42P01' || err?.code === '42703') return { ok: false, reason: 'table_or_column_missing' };
    console.error('[drawLedgerSync] failed for registration', registrationId, '-', err.message);
    return { ok: false, reason: 'error', error: err.message };
  }
};

export default syncDrawLedgerToPlot;
