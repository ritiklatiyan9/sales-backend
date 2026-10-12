import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

// Additive only: live plot/member/payment rows are changed solely by staff approval.
export async function migrateWebsiteBookings(db = pool) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TABLE IF NOT EXISTS website_booking_settings (
      site_id INTEGER PRIMARY KEY REFERENCES sites(id) ON DELETE RESTRICT,
      booking_enabled BOOLEAN NOT NULL DEFAULT false,
      status_display_enabled BOOLEAN NOT NULL DEFAULT true,
      booking_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (booking_amount >= 0 AND booking_amount <= 10000000),
      hold_minutes INTEGER NOT NULL DEFAULT 15 CHECK (hold_minutes BETWEEN 5 AND 60),
      terms TEXT NOT NULL DEFAULT 'Payment submits a booking request. Allotment is subject to payment verification, availability and approval by the company. Contact the office for cancellation and refund assistance.',
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS website_booking_requests (
      id BIGSERIAL PRIMARY KEY,
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
      plot_id INTEGER NOT NULL REFERENCES plots(id) ON DELETE RESTRICT,
      plot_number VARCHAR(40) NOT NULL,
      request_token_hash CHAR(64) NOT NULL UNIQUE,
      idempotency_key_hash CHAR(64) NOT NULL,
      payload_hash CHAR(64) NOT NULL,
      buyer_name VARCHAR(150) NOT NULL,
      buyer_phone VARCHAR(15) NOT NULL,
      buyer_email VARCHAR(254) NOT NULL,
      buyer_address VARCHAR(1000) NOT NULL,
      terms_snapshot TEXT NOT NULL,
      amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
      currency CHAR(3) NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
      status VARCHAR(30) NOT NULL DEFAULT 'ORDER_CREATING' CHECK (status IN ('ORDER_CREATING','AWAITING_PAYMENT','PAYMENT_REVIEW','PAYMENT_CONFLICT','APPROVED','REJECTED','EXPIRED','PAYMENT_FAILED')),
      hold_expires_at TIMESTAMPTZ NOT NULL,
      gateway_receipt VARCHAR(40) NOT NULL UNIQUE,
      razorpay_order_id VARCHAR(100) UNIQUE,
      razorpay_payment_id VARCHAR(100) UNIQUE,
      payment_verified_at TIMESTAMPTZ,
      payment_method VARCHAR(50),
      amount_refunded_paise BIGINT NOT NULL DEFAULT 0,
      refund_required BOOLEAN NOT NULL DEFAULT false,
      booking_id INTEGER UNIQUE REFERENCES bookings(id) ON DELETE RESTRICT,
      plot_payment_id INTEGER UNIQUE REFERENCES plot_payments(id) ON DELETE RESTRICT,
      reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at TIMESTAMPTZ,
      review_notes TEXT,
      gateway_error VARCHAR(100),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (site_id, idempotency_key_hash)
    )`);
    // At most one unpaid hold or paid request under review per plot. Expired holds
    // are explicitly released while the plot row is locked before another order.
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_website_active_plot
      ON website_booking_requests(plot_id) WHERE status IN ('ORDER_CREATING','AWAITING_PAYMENT','PAYMENT_REVIEW')`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_website_requests_site
      ON website_booking_requests(site_id, created_at DESC)`);
    await client.query(`CREATE TABLE IF NOT EXISTS website_booking_events (
      id BIGSERIAL PRIMARY KEY,
      request_id BIGINT REFERENCES website_booking_requests(id) ON DELETE RESTRICT,
      event_type VARCHAR(60) NOT NULL,
      actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      detail JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS website_payment_webhooks (
      event_id VARCHAR(150) PRIMARY KEY,
      event_type VARCHAR(60) NOT NULL,
      processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrateWebsiteBookings().then(() => console.log('Website booking tables ready (existing inventory unchanged).'))
    .catch((error) => { console.error('Website migration rolled back:', error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
