import 'dotenv/config';
import pool from '../config/db.js';
import { ensureTable } from '../models/ProjectSettings.model.js';

/**
 * Migration 003 — project_settings (Company + Payment details per site).
 *
 * SAFETY: 100% additive. Creates only the NEW project_settings table; its single FK
 * to sites uses ON DELETE CASCADE so it can never affect accounting data. Idempotent
 * (CREATE TABLE IF NOT EXISTS via the model's ensureTable). The booking-api also
 * self-creates this table on first use, so running this migration is optional.
 */
const migrate = async () => {
  try {
    await ensureTable();
    console.log('Migration 003_project_settings complete — project_settings ready');
  } catch (err) {
    console.error('Migration 003_project_settings failed:', err.message);
    throw err;
  } finally {
    await pool.end().catch(() => {});
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
