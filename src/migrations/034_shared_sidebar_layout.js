import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';
import { DEFAULT_SIDEBAR_LAYOUT } from '../services/sidebarLayout.js';

export async function migrateSharedSidebarLayout(db = pool) {
  await db.query(`CREATE TABLE IF NOT EXISTS booking_sidebar_layout (
    id SMALLINT PRIMARY KEY CHECK (id=1),
    layout JSONB NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision>=0),
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await db.query(`INSERT INTO booking_sidebar_layout(id,layout) VALUES(1,$1::jsonb)
    ON CONFLICT(id) DO NOTHING`, [JSON.stringify(DEFAULT_SIDEBAR_LAYOUT)]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await migrateSharedSidebarLayout(client); await client.query('COMMIT');
    console.log('Shared Booking sidebar layout ready. Existing data retained.');
  } catch (error) { await client.query('ROLLBACK'); console.error(error.message); process.exitCode=1; }
  finally { client.release(); await pool.end(); }
}
