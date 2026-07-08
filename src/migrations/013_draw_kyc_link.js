import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 013 — link draw registrations to the customer's KYC case.
 *
 * The draw flow mirrors bookings: Register → KYC → payments (admin) → slip →
 * winner → allotment. The registration remembers which kyc_case it opened so the
 * UI can deep-link the workspace and the slip endpoint can require KYC VERIFIED.
 *
 * SAFETY: 100% additive (ADD COLUMN IF NOT EXISTS on a booking-module table),
 * re-runnable, touches no accounting tables. ON DELETE SET NULL because
 * adoptForBooking may fold duplicate kyc_cases and delete the losers — readers
 * fall back to the member's newest case.
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      ALTER TABLE draw_registrations
        ADD COLUMN IF NOT EXISTS kyc_case_id INTEGER REFERENCES kyc_cases(id) ON DELETE SET NULL
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_draw_reg_kyc ON draw_registrations(kyc_case_id)`);
    await client.query('COMMIT');
    console.log('Migration 013_draw_kyc_link complete (draw_registrations.kyc_case_id)');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 013_draw_kyc_link failed (rolled back, no changes):', err.message);
    throw err;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
