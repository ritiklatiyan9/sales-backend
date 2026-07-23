import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 001 — Booking & KYC core tables.
 *
 * SAFETY: 100% additive. Creates only NEW tables (bookings, kyc_cases, documents,
 * ocr_results). It NEVER alters/drops existing accounting tables. FKs that point at
 * existing tables (sites, plots, members, users) use ON DELETE SET NULL / RESTRICT so
 * deleting a booking can never cascade into accounting data. Cascades only flow
 * downward inside the new tables. Re-runnable (CREATE TABLE IF NOT EXISTS).
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Confirm the existing tables we reference are present (fail loud, change nothing).
    const { rows: ref } = await client.query(`
      SELECT
        to_regclass('public.sites')   IS NOT NULL AS has_sites,
        to_regclass('public.plots')   IS NOT NULL AS has_plots,
        to_regclass('public.members') IS NOT NULL AS has_members,
        to_regclass('public.users')   IS NOT NULL AS has_users
    `);
    const r = ref[0];
    if (!r.has_sites || !r.has_plots || !r.has_members || !r.has_users) {
      throw new Error(`Expected accounting tables missing: ${JSON.stringify(r)} — aborting (no changes made).`);
    }

    // ── bookings ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS bookings (
        id                SERIAL PRIMARY KEY,
        site_id           INTEGER NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
        plot_id           INTEGER REFERENCES plots(id) ON DELETE SET NULL,
        client_member_id  INTEGER REFERENCES members(id) ON DELETE RESTRICT,
        booking_no        VARCHAR(40) UNIQUE,
        booking_date      DATE NOT NULL DEFAULT CURRENT_DATE,
        sale_price        NUMERIC(15,2) NOT NULL DEFAULT 0,
        token_amount      NUMERIC(15,2) NOT NULL DEFAULT 0,
        payment_plan      VARCHAR(20) NOT NULL DEFAULT 'FULL'
                            CHECK (payment_plan IN ('FULL','INSTALLMENT')),
        status            VARCHAR(20) NOT NULL DEFAULT 'DRAFT'
                            CHECK (status IN ('DRAFT','KYC_PENDING','KYC_DONE','CONFIRMED','CANCELLED')),
        kyc_status        VARCHAR(20) NOT NULL DEFAULT 'NOT_STARTED'
                            CHECK (kyc_status IN ('NOT_STARTED','OCR_PENDING','OCR_DONE','VERIFIED','REJECTED')),
        buyer_name        VARCHAR(255),
        booked_by         VARCHAR(255),
        notes             TEXT,
        created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at        TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at        TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bookings_site_id    ON bookings(site_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bookings_plot_id    ON bookings(plot_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bookings_client     ON bookings(client_member_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bookings_status     ON bookings(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bookings_kyc_status ON bookings(kyc_status)`);

    // ── kyc_cases ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS kyc_cases (
        id                SERIAL PRIMARY KEY,
        booking_id        INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
        client_member_id  INTEGER REFERENCES members(id) ON DELETE SET NULL,
        site_id           INTEGER REFERENCES sites(id) ON DELETE SET NULL,
        mode              VARCHAR(20) NOT NULL DEFAULT 'MANUAL_OCR'
                            CHECK (mode IN ('MANUAL_OCR','AADHAAR_EKYC')),
        status            VARCHAR(20) NOT NULL DEFAULT 'OPEN'
                            CHECK (status IN ('OPEN','OCR_PENDING','OCR_DONE','VERIFIED','REJECTED')),
        verified_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
        verified_at       TIMESTAMP WITH TIME ZONE,
        created_at        TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at        TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_kyc_cases_booking ON kyc_cases(booking_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_kyc_cases_status  ON kyc_cases(status)`);

    // ── documents ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS documents (
        id                SERIAL PRIMARY KEY,
        kyc_case_id       INTEGER NOT NULL REFERENCES kyc_cases(id) ON DELETE CASCADE,
        client_member_id  INTEGER REFERENCES members(id) ON DELETE SET NULL,
        site_id           INTEGER REFERENCES sites(id) ON DELETE SET NULL,
        type              VARCHAR(20) NOT NULL DEFAULT 'OTHER'
                            CHECK (type IN ('AADHAAR','PAN','PHOTO','CHEQUE','VOTER_ID','PASSPORT','DL','OTHER')),
        member_document_field VARCHAR(80),
        file_path         TEXT NOT NULL,
        file_hash         VARCHAR(80),
        mime_type         VARCHAR(120),
        file_size         INTEGER,
        ocr_status        VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                            CHECK (ocr_status IN ('PENDING','PROCESSING','DONE','FAILED')),
        ocr_job_id        VARCHAR(120),
        ocr_engine        VARCHAR(40),
        ocr_error         TEXT,
        ocr_started_at    TIMESTAMP WITH TIME ZONE,
        ocr_completed_at  TIMESTAMP WITH TIME ZONE,
        created_at        TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at        TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_documents_case       ON documents(kyc_case_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_documents_ocr_status ON documents(ocr_status)`);

    // ── ocr_results (one row per OCR run → re-runs preserve history) ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS ocr_results (
        id                  SERIAL PRIMARY KEY,
        document_id         INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        raw_text            JSONB,
        extracted_fields    JSONB,
        confidence_overall  NUMERIC(6,3),
        confidence_map      JSONB,
        engine              VARCHAR(40),
        processed_at        TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        created_at          TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ocr_results_document ON ocr_results(document_id)`);

    await client.query('COMMIT');
    console.log('Migration 001_booking_core complete (bookings, kyc_cases, documents, ocr_results)');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 001_booking_core failed (rolled back, no changes):', err.message);
    throw err;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
