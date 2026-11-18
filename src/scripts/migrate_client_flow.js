import pool from '../config/db.js';
import { migrateStaffIdentity } from '../migrations/029_staff_identity.js';
import { migrateClientRegistry } from '../migrations/030_client_registry.js';
import { migrateDrawEnrollment } from '../migrations/031_draw_enrollment.js';
import { migrateKycLoginIdentity } from '../migrations/032_kyc_login_identity.js';
import { migrateClientPortal } from '../migrations/033_client_portal.js';
import { migrateMemberCodeIds } from '../migrations/053_member_code_ids.js';

// Additive and repeatable; each migration commits atomically. Existing client,
// draw, KYC and financial records are retained.
try {
  for (const [name, migrate] of [
    ['029 staff identity', migrateStaffIdentity],
    ['030 client registry', migrateClientRegistry],
    ['031 draw enrollment', migrateDrawEnrollment],
    ['032 KYC login identity', migrateKycLoginIdentity],
    ['033 client portal', migrateClientPortal],
    ['053 member code IDs', migrateMemberCodeIds],
  ]) {
    await migrate(pool);
    console.log(`Applied ${name}`);
  }
} catch (error) {
  console.error('Client flow migration stopped:', error.message);
  process.exitCode = 1;
} finally { await pool.end(); }
