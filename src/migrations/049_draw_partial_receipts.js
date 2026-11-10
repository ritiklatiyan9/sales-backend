import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

export async function migrateDrawPartialReceipts(db = pool) {
  await db.query('ALTER TABLE project_settings ADD COLUMN IF NOT EXISTS draw_allow_partial_receipts BOOLEAN NOT NULL DEFAULT false');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await migrateDrawPartialReceipts();
    console.log('Draw receipt printing rules ready. Existing preferences retained.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { await pool.end(); }
}
