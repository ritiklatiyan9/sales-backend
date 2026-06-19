import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 004 — Booking agent override (for plot-booking → accounting sync).
 *
 * SAFETY: 100% additive. Adds ONE nullable column to the booking-module `bookings`
 * table. Touches no accounting tables. Re-runnable (ADD COLUMN IF NOT EXISTS).
 *
 * Why: when a KYC booking is created with a plot, the accounting `plots` row is
 * flipped to BOOKED and a commission is auto-created for the "Booking By" person.
 * By default that person is the logged-in KYC user, but `booking_agent_id` lets the
 * booker explicitly pick the site member/broker who should EARN the commission
 * (the "agent override"). NULL ⇒ fall back to the logged-in user's name.
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: ref } = await client.query(`
      SELECT to_regclass('public.bookings') IS NOT NULL AS has_bookings,
             to_regclass('public.members')  IS NOT NULL AS has_members
    `);
    if (!ref[0].has_bookings || !ref[0].has_members) {
      throw new Error(`Required tables missing: ${JSON.stringify(ref[0])} — aborting (no changes made).`);
    }

    await client.query(`
      ALTER TABLE bookings
        ADD COLUMN IF NOT EXISTS booking_agent_id INTEGER REFERENCES members(id) ON DELETE SET NULL
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bookings_agent ON bookings(booking_agent_id)`);

    await client.query('COMMIT');
    console.log('Migration 004_booking_agent complete (bookings.booking_agent_id)');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 004_booking_agent failed (rolled back, no changes):', err.message);
    throw err;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
