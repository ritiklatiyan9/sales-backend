import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

export async function migrateDocumentSettings(db = pool) {
  await db.query("ALTER TABLE project_settings ADD COLUMN IF NOT EXISTS document_config JSONB NOT NULL DEFAULT '{}'::jsonb");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await migrateDocumentSettings(); console.log('Document settings migration complete.'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { await pool.end(); }
}
