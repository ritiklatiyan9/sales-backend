import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 009 — Home screen layout (per-user launcher grid: icon positions + groups).
 *
 * SAFETY: 100% additive. One new table, no existing tables touched. Layout is a JSONB
 * blob (an ordered array of icon tiles and folder tiles) — free-form on purpose, since
 * the shape is UI-owned and evolves with the launcher, not a relational structure.
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: ref } = await client.query(`
      SELECT to_regclass('public.users') IS NOT NULL AS has_users
    `);
    if (!ref[0].has_users) {
      throw new Error('Required table missing: users — aborting (no changes made).');
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_home_layouts (
        user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        layout      JSONB NOT NULL DEFAULT '[]'::jsonb,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await client.query('COMMIT');
    console.log('Migration 009_home_layout complete (user_home_layouts)');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 009_home_layout failed (rolled back, no changes):', err.message);
    throw err;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
