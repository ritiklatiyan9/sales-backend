import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 037 — remember which company bank account received a draw payment.
 *
 * The draw payment dialog now picks the bank from the site's Accounting bank master
 * (bank_accounts). Storing its id lets drawLedgerSync map the transferred plot payment
 * to that bank in Accounting (cash_flow_entries.bank_account_id) at allotment.
 * Plain INTEGER, no FK into the shared accounting table — same as plot_payment_id (015).
 *
 * SAFETY: 100% additive on the booking-owned draw_payments table, re-runnable.
 */
const migrate = async () => {
  try {
    await pool.query(`ALTER TABLE draw_payments ADD COLUMN IF NOT EXISTS bank_account_id INTEGER`);
    console.log('Migration 037_draw_payment_bank_account complete (draw_payments.bank_account_id)');
  } catch (err) {
    console.error('Migration 037_draw_payment_bank_account failed:', err.message);
    throw err;
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
