import 'dotenv/config';
import pool from '../config/db.js';
import { syncPlotBookingToAccounting } from '../services/plotBookingSync.js';

/**
 * One-time backfill: for every existing booking that already has a plot assigned and
 * is not cancelled, run the same accounting sync that now fires on create/update —
 * flipping the plot to BOOKED and auto-creating the commission. Safe to re-run
 * (the sync is idempotent: it won't duplicate commissions or clobber other buyers).
 *
 * Usage:  npm run backfill:plot-bookings
 */
const main = async () => {
  const { rows: bookings } = await pool.query(
    `SELECT id, site_id, plot_id, client_member_id, created_by, booking_date, booking_agent_id
       FROM bookings
      WHERE plot_id IS NOT NULL AND status <> 'CANCELLED'
      ORDER BY id ASC`
  );

  console.log(`Found ${bookings.length} booking(s) with a plot to sync.\n`);
  let booked = 0, commissions = 0, skipped = 0;

  for (const b of bookings) {
    const r = await syncPlotBookingToAccounting(b, pool);
    if (r.ok && r.plot_id) {
      booked++;
      if (r.commission?.created) commissions++;
      console.log(
        `  ✔ booking #${b.id} → plot ${r.plot_no} BOOKED to ${r.buyer_name} | ` +
        `booking_by=${r.booking_by || '—'} | commission=${
          r.commission?.created ? `₹${r.commission.total_commission} created` : (r.commission?.reason || 'n/a')
        }`
      );
    } else {
      skipped++;
      console.log(`  ⚠ booking #${b.id} skipped: ${r.reason || JSON.stringify(r)}`);
    }
  }

  console.log(`\nDone. Plots booked: ${booked}, commissions created: ${commissions}, skipped: ${skipped}.`);
  await pool.end();
};

main().catch((e) => { console.error(e); process.exit(1); });
