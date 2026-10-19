import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

/**
 * Migration 038 — dealer teams built from Members brokers (BRK codes), not logins.
 *
 * team_dealers: one row per dealer (keyed by the canonical broker id behind
 * BRK-xxxxx), in exactly one team. parent_broker_id NULL = the Team Head (main
 * dealer); everyone else hangs under another dealer of the SAME team, any depth.
 * The composite FK keeps parents inside the team, the partial unique index allows
 * one head per team. draw_registrations gains the broker who brought the client.
 *
 * SAFETY: additive, booking-owned tables only; re-runnable.
 */
export async function migrateDealerTeams(db = pool) {
  await db.query(`CREATE TABLE IF NOT EXISTS team_dealers (
    broker_id INTEGER PRIMARY KEY,
    member_id INTEGER NOT NULL,
    team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    parent_broker_id INTEGER,
    added_by INTEGER,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (broker_id, team_id),
    FOREIGN KEY (parent_broker_id, team_id) REFERENCES team_dealers(broker_id, team_id)
  )`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS team_dealers_one_head ON team_dealers(team_id) WHERE parent_broker_id IS NULL`);
  await db.query(`CREATE INDEX IF NOT EXISTS team_dealers_parent ON team_dealers(parent_broker_id)`);
  await db.query(`ALTER TABLE draw_registrations ADD COLUMN IF NOT EXISTS broker_id INTEGER`);
  await db.query(`ALTER TABLE draw_registrations ADD COLUMN IF NOT EXISTS broker_member_id INTEGER`);
  await db.query(`ALTER TABLE draw_registrations ADD COLUMN IF NOT EXISTS broker_code VARCHAR(20)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_draw_registrations_broker ON draw_registrations(site_id, broker_id)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await migrateDealerTeams(); console.log('Migration 038_dealer_teams complete'); }
  catch (e) { console.error('Migration 038_dealer_teams failed:', e.message); process.exitCode = 1; }
  finally { await pool.end(); }
}
