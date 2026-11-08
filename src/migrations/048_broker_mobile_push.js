import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

// Broker and client IDs occupy independent authentication realms. Never share
// their token registrations or notification outboxes, even in one FCM project.
export async function migrateBrokerMobilePush(db = pool) {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    await c.query(`CREATE TABLE IF NOT EXISTS booking_broker_push_devices (
      token_hash CHAR(64) PRIMARY KEY, token TEXT NOT NULL, platform VARCHAR(10) NOT NULL CHECK(platform IN ('android','ios')),
      account_id INTEGER NOT NULL REFERENCES booking_broker_mobile_accounts(id) ON DELETE CASCADE,
      account_version INTEGER NOT NULL, account_identity CHAR(64) NOT NULL,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await c.query(`CREATE INDEX IF NOT EXISTS booking_broker_push_devices_account_idx ON booking_broker_push_devices(account_id)`);
    await c.query(`CREATE TABLE IF NOT EXISTS booking_broker_push_events (
      id BIGSERIAL PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES booking_broker_mobile_accounts(id) ON DELETE CASCADE,
      account_version INTEGER NOT NULL, account_identity CHAR(64) NOT NULL,
      client_ref TEXT NOT NULL, plot_ref TEXT NOT NULL, installment_ref TEXT NOT NULL,
      due_date DATE NOT NULL, reminder_day DATE NOT NULL, reminder_offset INTEGER NOT NULL CHECK(reminder_offset IN (3,1,0)),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), expanded_at TIMESTAMPTZ, lease_until TIMESTAMPTZ,
      UNIQUE(account_id,client_ref,plot_ref,installment_ref,reminder_day)
    )`);
    await c.query(`CREATE INDEX IF NOT EXISTS booking_broker_push_event_pending_idx ON booking_broker_push_events(id) WHERE expanded_at IS NULL`);
    await c.query(`CREATE TABLE IF NOT EXISTS booking_broker_push_deliveries (
      event_id BIGINT NOT NULL REFERENCES booking_broker_push_events(id) ON DELETE CASCADE,
      token_hash CHAR(64) NOT NULL REFERENCES booking_broker_push_devices(token_hash) ON DELETE CASCADE,
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sent','skipped','failed')),
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt TIMESTAMPTZ NOT NULL DEFAULT now(), lease_until TIMESTAMPTZ,
      PRIMARY KEY(event_id,token_hash)
    )`);
    await c.query(`CREATE INDEX IF NOT EXISTS booking_broker_push_delivery_pending_idx ON booking_broker_push_deliveries(next_attempt,event_id) WHERE state='pending'`);
    await c.query('COMMIT');
  } catch (error) { await c.query('ROLLBACK'); throw error; } finally { c.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrateBrokerMobilePush().then(() => console.log('Partner installment notification schema ready.'))
    .catch(error => { console.error('Partner push migration failed:', error.code || 'MIGRATION_FAILED'); process.exitCode = 1; })
    .finally(() => pool.end());
}
