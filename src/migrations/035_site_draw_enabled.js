import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

// Existing configured draw sites stay enabled. Sites without a configured amount
// are still unavailable for enrollment until an administrator sets their rules.
export async function migrateSiteDrawEnabled(db = pool) {
  await db.query('ALTER TABLE project_settings ADD COLUMN IF NOT EXISTS draw_enabled BOOLEAN NOT NULL DEFAULT true');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await migrateSiteDrawEnabled();
    console.log('Site draw availability ready. Existing settings retained.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { await pool.end(); }
}
