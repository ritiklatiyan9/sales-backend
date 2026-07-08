import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 015 — link draw ledger receipts to the shared accounting plot ledger.
 *
 * When a draw winner is allotted a shop, every payment in the Draw Payment Ledger is
 * mirrored into the SHARED plot_payments table (status 'pending') so the booking's
 * payments page and Accounting both see the money received. This column stores the
 * mirrored row's id per receipt — the idempotency link, exactly like
 * bookings.token_payment_id (plain INTEGER, no FK into the shared table).
 *
 * SAFETY: 100% additive on the booking-owned draw_payments table, re-runnable.
 */
const migrate = async () => {
  try {
    await pool.query(`ALTER TABLE draw_payments ADD COLUMN IF NOT EXISTS plot_payment_id INTEGER`);
    console.log('Migration 015_draw_payment_link complete (draw_payments.plot_payment_id)');
  } catch (err) {
    console.error('Migration 015_draw_payment_link failed:', err.message);
    throw err;
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
