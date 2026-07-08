import 'dotenv/config';
import pool from '../config/db.js';
import { syncDrawLedgerToPlot } from '../services/drawLedgerSync.js';

/**
 * One-off, re-runnable backfill: mirror the Draw Payment Ledger of every ALREADY
 * ALLOTTED registration into the shared plot_payments ledger (rows created before
 * the allot-time sync existed). Idempotent — receipts already mirrored are skipped
 * via draw_payments.plot_payment_id.
 *
 * Run: npm run backfill:draw-plot-payments
 */
const main = async () => {
  const { rows } = await pool.query(
    `SELECT id, registration_no FROM draw_registrations WHERE status = 'ALLOTTED' ORDER BY id`
  );
  console.log(`${rows.length} allotted registration(s) to check`);
  for (const r of rows) {
    const res = await syncDrawLedgerToPlot(r.id, pool);
    console.log(`${r.registration_no}:`, JSON.stringify(res));
  }
  await pool.end();
};

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
