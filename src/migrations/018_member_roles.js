import 'dotenv/config';
import pool from '../config/db.js';
import { MEMBER_TYPES } from '../services/memberRoles.service.js';

/**
 * Migration 018 — role-aware KYC registration in the shared Accounting database.
 *
 * SAFETY:
 *  - transactional and idempotent;
 *  - preserves every existing member row and member type;
 *  - widens (never narrows) the known members.member_type check with SUPERVISOR;
 *  - registers Supervisor in Accounting's member_categories lookup;
 *  - adds only a non-unique lookup index for normalized mobile matching.
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: refs } = await client.query(`
      SELECT to_regclass('public.members') IS NOT NULL AS has_members,
             to_regclass('public.member_categories') IS NOT NULL AS has_categories
    `);
    if (!refs[0]?.has_members) {
      throw new Error('Shared Accounting members table is missing — aborting without changes.');
    }

    // Capture current values for the no-existing-constraint fallback below.
    const { rows: currentTypes } = await client.query(
      `SELECT DISTINCT member_type FROM members WHERE member_type IS NOT NULL ORDER BY member_type`
    );

    const { rows: checks } = await client.query(`
      SELECT c.conname, pg_get_constraintdef(c.oid) AS definition
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = 'public'
         AND t.relname = 'members'
         AND c.contype = 'c'
         AND pg_get_constraintdef(c.oid) ILIKE '%member_type%'
    `);

    const alreadyAllowsSupervisor = checks.length > 0 && checks.every((check) =>
      String(check.definition || '').toUpperCase().includes('SUPERVISOR')
    );
    if (!alreadyAllowsSupervisor) {
      // The Accounting schema owns one member_type check. Drop only checks that
      // explicitly mention that column, then restore the exact former rule OR
      // SUPERVISOR. Reusing pg_get_constraintdef means a newer Accounting deployment
      // can add categories without this migration narrowing them back down.
      const priorExpressions = checks.map((check) => {
        const definition = String(check.definition || '').trim();
        const match = definition.match(/^CHECK\s*\(([\s\S]*)\)$/i);
        if (!match) {
          throw new Error(`Cannot safely widen member type constraint ${check.conname}`);
        }
        return `(${match[1]})`;
      });
      for (const check of checks) {
        const safeName = String(check.conname).replace(/"/g, '""');
        await client.query(`ALTER TABLE members DROP CONSTRAINT "${safeName}"`);
      }
      const fallbackTypes = [...new Set([
        ...MEMBER_TYPES,
        ...currentTypes.map((row) => String(row.member_type || '').trim().toUpperCase()).filter(Boolean),
      ])];
      const previousRule = priorExpressions.length
        ? priorExpressions.join(' AND ')
        : `member_type IN (${fallbackTypes.map((type) => `'${type.replace(/'/g, "''")}'`).join(', ')})`;
      await client.query(`
        ALTER TABLE members
          ADD CONSTRAINT members_member_type_check
          CHECK (member_type = 'SUPERVISOR' OR (${previousRule}))
      `);
    }

    if (refs[0].has_categories) {
      await client.query(`
        INSERT INTO member_categories
          (name, slug, description, is_predefined, icon, color, created_at, updated_at)
        VALUES
          ('Supervisor', 'SUPERVISOR', 'Site supervisors and field supervisors',
           true, 'UserCog', 'teal', now(), now())
        ON CONFLICT (slug) DO UPDATE SET
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          is_predefined = true,
          icon = EXCLUDED.icon,
          color = EXCLUDED.color,
          updated_at = now()
      `);
    }

    // Speeds role-aware quick-add without making assumptions about legacy duplicate
    // phone rows. Matching uses the trailing 10 digits to absorb +91/0 prefixes.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_members_site_phone_normalized
        ON members (
          site_id,
          RIGHT(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g'), 10)
        )
        WHERE regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') <> ''
    `);

    const { rows: bookingTables } = await client.query(`
      SELECT to_regclass('public.kyc_cases') IS NOT NULL AS has_cases,
             to_regclass('public.documents') IS NOT NULL AS has_documents,
             EXISTS (
               SELECT 1
                 FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'documents'
                  AND column_name = 'member_document_field'
             ) AS has_member_document_field
    `);
    if (bookingTables[0]?.has_cases) {
      // Covers member-first reuse/adoption (`client_member_id` + nullable booking)
      // while retaining newest-case ordering without a separate sort.
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_kyc_cases_member_booking_id
          ON kyc_cases (client_member_id, booking_id, id DESC)
      `);
    }
    if (bookingTables[0]?.has_documents && bookingTables[0]?.has_member_document_field) {
      // Used by two-sided document replacement/lookups. Existing Accounting installs
      // already have this exact partial index, so CREATE IF NOT EXISTS is a no-op.
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_documents_case_member_field
          ON documents (kyc_case_id, member_document_field, id DESC)
          WHERE member_document_field IS NOT NULL
      `);
    }

    await client.query('COMMIT');
    console.log(
      'Migration 018_member_roles complete ' +
      '(SUPERVISOR member type/category + role/KYC lookup indexes)'
    );
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Migration 018_member_roles failed (rolled back):', error.message);
    throw error;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
