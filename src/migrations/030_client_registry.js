import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

/**
 * Preserve legacy identities and documents. Reject only NEW duplicate phones or
 * changes to another person's phone; unchanged legacy duplicates remain editable.
 * An expression index serves exact lookup, phone prefixes and the duplicate guard.
 */
export async function migrateClientRegistry(db = pool) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE INDEX IF NOT EXISTS idx_members_registry_phone
      ON members (site_id, (RIGHT(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g'), 10)) text_pattern_ops, id DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_members_registry_name
      ON members (site_id, (lower(full_name)) text_pattern_ops)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_members_registry_directory
      ON members (site_id, member_type, id DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_users_registry_referral
      ON users ((upper(referral_code))) WHERE is_active = true`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_kyc_registry_member
      ON kyc_cases (client_member_id, site_id, id DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_documents_registry_member
      ON documents (client_member_id, id DESC)`);
    await client.query(`CREATE OR REPLACE FUNCTION guard_member_registry_phone() RETURNS trigger AS $$
      DECLARE normalized TEXT;
      BEGIN
        normalized := RIGHT(regexp_replace(COALESCE(NEW.phone, ''), '\\D', '', 'g'), 10);
        IF normalized = '' OR NEW.site_id IS NULL THEN RETURN NEW; END IF;
        IF TG_OP = 'UPDATE' THEN
          IF NEW.site_id IS NOT DISTINCT FROM OLD.site_id
             AND normalized = RIGHT(regexp_replace(COALESCE(OLD.phone, ''), '\\D', '', 'g'), 10)
          THEN RETURN NEW; END IF;
        END IF;
        PERFORM pg_advisory_xact_lock(hashtext('member_quick_add:' || NEW.site_id || ':' || normalized));
        IF EXISTS (SELECT 1 FROM members m WHERE m.site_id = NEW.site_id AND m.id IS DISTINCT FROM NEW.id
          AND RIGHT(regexp_replace(COALESCE(m.phone, ''), '\\D', '', 'g'), 10) = normalized) THEN
          RAISE EXCEPTION 'This mobile number is already registered at this site'
            USING ERRCODE = '23505', CONSTRAINT = 'members_site_phone_registry_uq';
        END IF;
        RETURN NEW;
      END;
    $$ LANGUAGE plpgsql`);
    await client.query('DROP TRIGGER IF EXISTS trg_member_registry_phone ON members');
    await client.query(`CREATE TRIGGER trg_member_registry_phone
      BEFORE INSERT OR UPDATE OF phone, site_id ON members
      FOR EACH ROW EXECUTE FUNCTION guard_member_registry_phone()`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrateClientRegistry()
    .then(() => console.log('Migration 030 complete: indexed client registry and duplicate phone guard.'))
    .catch((error) => { console.error('Migration 030 rolled back:', error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
