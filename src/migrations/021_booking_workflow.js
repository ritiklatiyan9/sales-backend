import 'dotenv/config';
import pool from '../config/db.js';
import { pathToFileURL } from 'node:url';

// Additive, rerunnable. Existing registrations retain their KYC and issued documents.
export async function migrateBookingWorkflow(db = pool) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`ALTER TABLE project_settings
    ADD COLUMN IF NOT EXISTS draw_wait_days INTEGER NOT NULL DEFAULT 10 CHECK (draw_wait_days IN (10,25)),
    ADD COLUMN IF NOT EXISTS draw_opening_date DATE,
    ADD COLUMN IF NOT EXISTS draw_terms TEXT`);
    await client.query(`ALTER TABLE draw_registrations
    ADD COLUMN IF NOT EXISTS workflow_version INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS draw_opening_date DATE,
    ADD COLUMN IF NOT EXISTS terms_snapshot TEXT,
    ADD COLUMN IF NOT EXISTS request_key VARCHAR(100)`);
    await client.query(
      `ALTER TABLE draw_payments ADD COLUMN IF NOT EXISTS request_key VARCHAR(100)`,
    );
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_draw_registration_request ON draw_registrations(created_by, request_key) WHERE request_key IS NOT NULL`,
    );
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_draw_payment_request ON draw_payments(draw_registration_id, request_key) WHERE request_key IS NOT NULL`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_draw_workflow_site_created ON draw_registrations(site_id, created_at DESC, id DESC)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_draw_workflow_opening ON draw_registrations(site_id, draw_opening_date) WHERE status IN ('SLIP_ISSUED','WINNER')`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_draw_kyc_member_latest ON kyc_cases(client_member_id, id DESC)`,
    );
    await client.query(
      `UPDATE draw_registrations SET terms_snapshot = $1 WHERE slip_no IS NOT NULL AND terms_snapshot IS NULL`,
      [
        '1. This form registers the applicant for the draw-based shop/unit allotment scheme only; it does not by itself allot any unit.\n\n2. All payments made toward this registration are recorded in the applicant’s dedicated Draw Payment Ledger.\n\n3. The applicant becomes eligible for the draw only after the required registration amount is fully paid.\n\n4. The Official Draw Entry Slip is generated after eligibility; only slips presented with valid QR verification participate in the draw.\n\n5. Winners must present their draw slip at the office; allotment is completed only after QR verification by an authorised employee.\n\n6. The scheme is governed by company policy; taxes, stamp duty and registration charges are payable separately as applicable.',
      ],
    );
    await client.query('COMMIT');
    console.log(
      'Migration 021 complete: booking workflow, draw schedule, immutable terms, retry-safe receipts.',
    );
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  migrateBookingWorkflow()
    .catch((error) => {
      console.error('Migration 021 rolled back:', error.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
