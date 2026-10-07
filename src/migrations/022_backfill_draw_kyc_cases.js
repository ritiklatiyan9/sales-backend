import 'dotenv/config';
import pool from '../config/db.js';
import { pathToFileURL } from 'node:url';

/**
 * Ensure every active Booking Payments registration has a real KYC case.
 *
 * Existing member KYC is reused when available. Otherwise one OPEN case is
 * created per customer/site, then every unlinked active registration is linked
 * to that case. The transaction-level lock makes the migration safe to rerun.
 */
export async function backfillDrawKycCases(db = pool) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('022_backfill_draw_kyc_cases'))");

    const { rowCount: createdCases } = await client.query(`
      INSERT INTO kyc_cases
        (booking_id, client_member_id, site_id, mode, status, created_by)
      SELECT DISTINCT ON (r.client_member_id, r.site_id)
             NULL, r.client_member_id, r.site_id, 'MANUAL_OCR', 'OPEN',
             COALESCE(r.agent_user_id, r.created_by)
        FROM draw_registrations r
       WHERE r.kyc_case_id IS NULL
         AND r.status <> 'CANCELLED'
         AND NOT EXISTS (
           SELECT 1
             FROM kyc_cases k
            WHERE k.client_member_id = r.client_member_id
              AND k.site_id = r.site_id
         )
       ORDER BY r.client_member_id, r.site_id, r.created_at, r.id
    `);

    const { rowCount: linkedRegistrations } = await client.query(`
      UPDATE draw_registrations r
         SET kyc_case_id = (
               SELECT k.id
                 FROM kyc_cases k
                WHERE k.client_member_id = r.client_member_id
                  AND k.site_id = r.site_id
                ORDER BY (k.booking_id IS NULL) DESC,
                         CASE k.status
                           WHEN 'VERIFIED' THEN 4
                           WHEN 'OCR_DONE' THEN 3
                           WHEN 'OCR_PENDING' THEN 2
                           WHEN 'OPEN' THEN 1
                           ELSE 0
                         END DESC,
                         k.id DESC
                LIMIT 1
             ),
             updated_at = now()
       WHERE r.kyc_case_id IS NULL
         AND r.status <> 'CANCELLED'
         AND EXISTS (
           SELECT 1
             FROM kyc_cases k
            WHERE k.client_member_id = r.client_member_id
              AND k.site_id = r.site_id
         )
    `);

    await client.query('COMMIT');
    return { createdCases, linkedRegistrations };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  backfillDrawKycCases()
    .then(({ createdCases, linkedRegistrations }) => {
      console.log(`Migration 022 complete: created ${createdCases} KYC case(s), linked ${linkedRegistrations} booking registration(s).`);
    })
    .catch((error) => {
      console.error('Migration 022 rolled back:', error.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
