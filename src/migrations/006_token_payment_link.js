import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 006 — Token-payment link + capture fields.
 *
 * SAFETY: 100% additive. Adds nullable columns to the booking-module `bookings`
 * table only. Touches no accounting tables. Re-runnable (ADD COLUMN IF NOT EXISTS).
 *
 * Why: a booking's `token_amount` was stored only on the booking and never became
 * a real ledger entry. We now mirror it into the shared accounting `plot_payments`
 * table (see services/tokenPaymentSync.js) so it shows on /plot-payments/:id.
 *   • token_payment_id  → the plot_payments row we created (idempotency link; a
 *                          re-sync UPDATEs that row instead of inserting a duplicate).
 *   • token_payment_*    → the "how was it paid" fields captured on the booking form,
 *                          matching the accounting plot-payment taking fields. They are
 *                          persisted so an edit can re-render and re-sync the same txn.
 *
 * The FK is ON DELETE SET NULL so deleting a plot_payment (e.g. from Accounting) can
 * never cascade into / break a booking — it only clears the link.
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: ref } = await client.query(`
      SELECT to_regclass('public.bookings')      IS NOT NULL AS has_bookings,
             to_regclass('public.plot_payments') IS NOT NULL AS has_plot_payments
    `);
    if (!ref[0].has_bookings || !ref[0].has_plot_payments) {
      throw new Error(`Required tables missing: ${JSON.stringify(ref[0])} — aborting (no changes made).`);
    }

    await client.query(`
      ALTER TABLE bookings
        ADD COLUMN IF NOT EXISTS token_payment_id   INTEGER REFERENCES plot_payments(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS token_payment_from VARCHAR(100) DEFAULT 'CASH',
        ADD COLUMN IF NOT EXISTS token_payment_date DATE,
        ADD COLUMN IF NOT EXISTS token_bank_name    VARCHAR(150),
        ADD COLUMN IF NOT EXISTS token_branch       VARCHAR(150),
        ADD COLUMN IF NOT EXISTS token_bank_details VARCHAR(255),
        ADD COLUMN IF NOT EXISTS token_cheque_no    VARCHAR(50),
        ADD COLUMN IF NOT EXISTS token_narration    TEXT,
        ADD COLUMN IF NOT EXISTS token_received_by  VARCHAR(255)
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bookings_token_payment ON bookings(token_payment_id)`);

    await client.query('COMMIT');
    console.log('Migration 006_token_payment_link complete (bookings.token_payment_id + token_* capture fields)');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 006_token_payment_link failed (rolled back, no changes):', err.message);
    throw err;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
