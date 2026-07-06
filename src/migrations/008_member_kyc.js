import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 008 — Member-first KYC (agent flow).
 *
 * SAFETY: 100% additive & idempotent. No accounting table loses anything; the only
 * relaxation is dropping the NOT NULL on kyc_cases.booking_id so a KYC case can now
 * exist for a member BEFORE any booking exists (the agent "New KYC" flow). Every
 * existing case keeps its booking; the FK + ON DELETE CASCADE stay untouched.
 *
 *  - kyc_cases.booking_id       → nullable (member-anchored cases have no booking yet)
 *  - kyc_cases.created_by       → users.id of whoever opened the case (agent scoping)
 *  - members.referred_by_user_id→ users.id of the agent who added this customer; the
 *    booking module stamps bookings.agent_user_id from this at booking time so the
 *    referring agent is attached automatically.
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: ref } = await client.query(`
      SELECT to_regclass('public.kyc_cases') IS NOT NULL AS has_cases,
             to_regclass('public.members')   IS NOT NULL AS has_members,
             to_regclass('public.users')     IS NOT NULL AS has_users
    `);
    if (!ref[0].has_cases || !ref[0].has_members || !ref[0].has_users) {
      throw new Error(`Required tables missing: ${JSON.stringify(ref[0])} — aborting (no changes made).`);
    }

    await client.query(`ALTER TABLE kyc_cases ALTER COLUMN booking_id DROP NOT NULL`);
    await client.query(`
      ALTER TABLE kyc_cases
        ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_kyc_cases_member     ON kyc_cases(client_member_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_kyc_cases_created_by ON kyc_cases(created_by)`);

    await client.query(`
      ALTER TABLE members
        ADD COLUMN IF NOT EXISTS referred_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_members_referred_by ON members(referred_by_user_id)`);

    await client.query('COMMIT');
    console.log('Migration 008_member_kyc complete (nullable kyc_cases.booking_id, kyc_cases.created_by, members.referred_by_user_id)');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 008_member_kyc failed (rolled back, no changes):', err.message);
    throw err;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
