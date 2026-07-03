import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 007 — Agent Network, Teams, Referrals & Agent Ledger.
 *
 * SAFETY: 100% additive & idempotent. Existing auth/roles keep working untouched:
 *  - users gains OPTIONAL hierarchy columns (parent_user_id / referral_code /
 *    designation / agent_status / team_id / can_register_agents). Existing rows are
 *    unaffected (roots of the tree) and every user is back-filled a referral code.
 *  - Unlimited hierarchy = adjacency list + recursive CTEs (no hardcoded levels).
 *  - teams / team_members (multiple heads supported via is_head).
 *  - agent_ledger_entries: future-commission-ready (typed entries + JSONB meta) so
 *    direct/team/matching/leadership/level/royalty/reward/performance entries need
 *    NO schema change later. No commission is calculated anywhere yet.
 *  - agent_activity_log: audit trail of network actions.
 *  - bookings gains OPTIONAL ownership columns agent_user_id / team_id.
 */
const SQL = `
  -- Allow the new 'agent' role. The users_role_check constraint originally permits
  -- only super_admin/admin/sub_admin; widen it (drop + re-add is idempotent).
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
  ALTER TABLE users ADD CONSTRAINT users_role_check
    CHECK (role IN ('super_admin', 'admin', 'sub_admin', 'agent'));

  ALTER TABLE users ADD COLUMN IF NOT EXISTS parent_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS designation TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS agent_status TEXT NOT NULL DEFAULT 'ACTIVE';
  ALTER TABLE users ADD COLUMN IF NOT EXISTS team_id INTEGER;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS can_register_agents BOOLEAN NOT NULL DEFAULT false;

  CREATE UNIQUE INDEX IF NOT EXISTS users_referral_code_uq ON users (referral_code) WHERE referral_code IS NOT NULL;
  CREATE INDEX IF NOT EXISTS users_parent_idx ON users (parent_user_id);
  CREATE INDEX IF NOT EXISTS users_team_idx ON users (team_id);

  CREATE TABLE IF NOT EXISTS teams (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS team_members (
    team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    is_head BOOLEAN NOT NULL DEFAULT false,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS team_members_user_idx ON team_members (user_id);

  CREATE TABLE IF NOT EXISTS agent_ledger_entries (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entry_type TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('CREDIT','DEBIT')),
    amount NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
    status TEXT NOT NULL DEFAULT 'PENDING',
    booking_id INTEGER,
    plot_id INTEGER,
    site_id INTEGER,
    narration TEXT,
    meta JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS agent_ledger_user_idx ON agent_ledger_entries (user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS agent_ledger_type_idx ON agent_ledger_entries (entry_type, status);

  CREATE TABLE IF NOT EXISTS agent_activity_log (
    id SERIAL PRIMARY KEY,
    actor_user_id INTEGER,
    target_user_id INTEGER,
    action TEXT NOT NULL,
    detail JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS agent_activity_target_idx ON agent_activity_log (target_user_id, created_at DESC);

  ALTER TABLE bookings ADD COLUMN IF NOT EXISTS agent_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
  ALTER TABLE bookings ADD COLUMN IF NOT EXISTS team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL;
  CREATE INDEX IF NOT EXISTS bookings_agent_user_idx ON bookings (agent_user_id);
  CREATE INDEX IF NOT EXISTS bookings_team_idx ON bookings (team_id);
`;

// Unambiguous alphabet (no 0/O/1/I) — permanent, indexed, human-friendly codes.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const genCode = () =>
  'AGT-' + Array.from({ length: 5 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');

const migrate = async () => {
  try {
    await pool.query(SQL);

    // Back-fill a permanent referral code for every user that lacks one.
    const { rows } = await pool.query('SELECT id FROM users WHERE referral_code IS NULL');
    for (const u of rows) {
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          await pool.query('UPDATE users SET referral_code = $1 WHERE id = $2', [genCode(), u.id]);
          break;
        } catch (e) {
          if (!String(e.message).includes('users_referral_code_uq')) throw e; // collision → retry
        }
      }
    }
    console.log(`Migration 007_agent_network complete — ${rows.length} referral code(s) back-filled`);
  } catch (err) {
    console.error('Migration 007_agent_network failed:', err.message);
    throw err;
  } finally {
    await pool.end().catch(() => {});
  }
};

migrate().then(() => process.exit(0)).catch(() => process.exit(1));
