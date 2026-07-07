import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 011 — Draw-based shop allotment module.
 *
 * SAFETY: 100% additive. Creates three NEW booking-module tables; touches no
 * accounting tables (only outward FKs with SET NULL / RESTRICT, same as bookings).
 * Re-runnable (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS).
 *
 * Flow the tables support:
 *   draw_registrations — one row per customer draw entry. A dealer registers the
 *     customer; payments accumulate until required_amount is reached (ELIGIBLE),
 *     then an official Draw Entry Slip is issued (SLIP_ISSUED). After the lottery,
 *     winners are marked (WINNER) and, on QR-scan verification at the office, a
 *     shop/plot is allotted (ALLOTTED) — which also creates a real booking and
 *     flips the accounting plot to BOOKED via the existing plotBookingSync.
 *     `qr_token` is an unguessable 128-bit hex id embedded in the printed form's
 *     and slip's QR code; the public verify page and the office scanner both
 *     resolve it against the LIVE row (unlike the stateless receipt HMAC, draw
 *     status changes over time, so verification must be DB-backed).
 *   draw_payments — the customer's dedicated Draw Payment Ledger.
 *   draw_events — append-only audit trail of every lifecycle transition.
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: ref } = await client.query(`
      SELECT to_regclass('public.sites')    IS NOT NULL AS has_sites,
             to_regclass('public.members')  IS NOT NULL AS has_members,
             to_regclass('public.users')    IS NOT NULL AS has_users,
             to_regclass('public.plots')    IS NOT NULL AS has_plots,
             to_regclass('public.bookings') IS NOT NULL AS has_bookings
    `);
    const missing = Object.entries(ref[0]).filter(([, ok]) => !ok).map(([k]) => k);
    if (missing.length) {
      throw new Error(`Required tables missing: ${missing.join(', ')} — aborting (no changes made).`);
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS draw_registrations (
        id                SERIAL PRIMARY KEY,
        registration_no   VARCHAR(40) UNIQUE,
        site_id           INTEGER NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
        client_member_id  INTEGER NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
        scheme_name       VARCHAR(150),
        required_amount   NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (required_amount >= 0),
        status            VARCHAR(20) NOT NULL DEFAULT 'REGISTERED'
                          CHECK (status IN ('REGISTERED','ELIGIBLE','SLIP_ISSUED','WINNER','ALLOTTED','CANCELLED')),
        qr_token          VARCHAR(64) NOT NULL UNIQUE,
        slip_no           VARCHAR(40) UNIQUE,
        slip_issued_at    TIMESTAMPTZ,
        slip_issued_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        is_winner         BOOLEAN NOT NULL DEFAULT FALSE,
        winner_marked_at  TIMESTAMPTZ,
        winner_marked_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
        allotted_plot_id  INTEGER REFERENCES plots(id) ON DELETE SET NULL,
        allotted_at       TIMESTAMPTZ,
        allotted_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
        booking_id        INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
        agent_user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
        notes             TEXT,
        created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS draw_payments (
        id                    SERIAL PRIMARY KEY,
        draw_registration_id  INTEGER NOT NULL REFERENCES draw_registrations(id) ON DELETE CASCADE,
        receipt_no            VARCHAR(40) UNIQUE,
        amount                NUMERIC(15,2) NOT NULL CHECK (amount > 0),
        payment_date          DATE NOT NULL DEFAULT CURRENT_DATE,
        payment_from          VARCHAR(100) DEFAULT 'CASH',
        bank_name             VARCHAR(150),
        branch                VARCHAR(150),
        bank_details          VARCHAR(255),
        cheque_no             VARCHAR(50),
        narration             TEXT,
        received_by           VARCHAR(255),
        created_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS draw_events (
        id                    SERIAL PRIMARY KEY,
        draw_registration_id  INTEGER NOT NULL REFERENCES draw_registrations(id) ON DELETE CASCADE,
        event_type            VARCHAR(40) NOT NULL,
        detail                JSONB,
        actor_user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // DB backstop against double allotment: at most ONE live allotment per shop,
    // no matter what races the application layer might lose.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_draw_reg_allotted_plot
        ON draw_registrations(allotted_plot_id) WHERE status = 'ALLOTTED'
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_draw_reg_site      ON draw_registrations(site_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_draw_reg_status    ON draw_registrations(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_draw_reg_client    ON draw_registrations(client_member_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_draw_reg_agent     ON draw_registrations(agent_user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_draw_payments_reg  ON draw_payments(draw_registration_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_draw_events_reg    ON draw_events(draw_registration_id)`);

    await client.query('COMMIT');
    console.log('Migration 011_draw_module complete (draw_registrations, draw_payments, draw_events)');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 011_draw_module failed (rolled back, no changes):', err.message);
    throw err;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
