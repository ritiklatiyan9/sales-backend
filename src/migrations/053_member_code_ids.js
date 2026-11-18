import { pathToFileURL } from 'node:url';
import pool, { memberCodeSchema, schemaHas } from '../config/db.js';

// Accounts migration 254 installs the same column and insert trigger. Both APIs
// use the same lock and migration record so either can start first.
const SHARED_VERSION = '254_member_code_ids';

export async function migrateMemberCodeIds(db = pool) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [SHARED_VERSION]);
    const ready = await schemaHas(memberCodeSchema, client);
    if (!ready) {
      await client.query('ALTER TABLE members ADD COLUMN IF NOT EXISTS code_id INTEGER');
      // Backfill the codes that were displayed before the migration.
      await client.query(`WITH phones AS (
        SELECT id, RIGHT(REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) AS phone_key
        FROM members
      ), codes AS (
        SELECT id, CASE WHEN LENGTH(phone_key) = 10 THEN MIN(id) OVER (PARTITION BY phone_key) ELSE id END AS code_id
        FROM phones
      )
      UPDATE members m SET code_id = codes.code_id FROM codes WHERE m.id = codes.id AND m.code_id IS NULL`);
      await client.query('ALTER TABLE members ALTER COLUMN code_id SET NOT NULL');

      await client.query(`CREATE OR REPLACE FUNCTION assign_member_code_id() RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE
          phone_key TEXT;
        BEGIN
          IF NEW.code_id IS NOT NULL THEN RETURN NEW; END IF;
          phone_key := RIGHT(REGEXP_REPLACE(COALESCE(NEW.phone, ''), '[^0-9]', '', 'g'), 10);
          IF LENGTH(phone_key) = 10 AND NULLIF(BTRIM(NEW.full_name), '') IS NOT NULL THEN
            SELECT MIN(m.code_id) INTO NEW.code_id
            FROM members m
            JOIN sites source_site ON source_site.id = m.site_id
            JOIN sites target_site ON target_site.id = NEW.site_id
              AND target_site.organization_id = source_site.organization_id
            WHERE RIGHT(REGEXP_REPLACE(COALESCE(m.phone, ''), '[^0-9]', '', 'g'), 10) = phone_key
              AND UPPER(BTRIM(m.full_name)) = UPPER(BTRIM(NEW.full_name))
            HAVING MIN(m.code_id) = MAX(m.code_id);
          END IF;
          NEW.code_id := COALESCE(NEW.code_id, NEW.id);
          RETURN NEW;
        END;
      $$`);
      await client.query('DROP TRIGGER IF EXISTS trg_member_stable_code ON members');
      await client.query(`CREATE TRIGGER trg_member_stable_code BEFORE INSERT ON members
        FOR EACH ROW EXECUTE FUNCTION assign_member_code_id()`);
      await client.query(`CREATE TABLE IF NOT EXISTS app_schema_migrations (
        version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      await client.query('INSERT INTO app_schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING', [SHARED_VERSION]);
    }
    await client.query('COMMIT');
    return !ready;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const applied = await migrateMemberCodeIds();
    console.log(applied ? 'Member codes saved' : 'Member code migration already installed');
  } catch (error) {
    console.error('Member code migration failed', error.code || 'MIGRATION_FAILED');
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
