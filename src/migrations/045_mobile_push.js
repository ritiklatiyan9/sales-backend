import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

// Additive tables and transaction-bound triggers on the shared Accounts ledger.
export async function migrateMobilePush(db = pool) {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    await c.query(`CREATE TABLE IF NOT EXISTS booking_mobile_push_devices (
      token_hash CHAR(64) PRIMARY KEY, token TEXT NOT NULL, platform VARCHAR(10) NOT NULL,
      account_id INTEGER NOT NULL REFERENCES booking_client_accounts(id) ON DELETE CASCADE,
      account_version INTEGER NOT NULL, registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await c.query(`CREATE INDEX IF NOT EXISTS booking_mobile_push_devices_account_idx ON booking_mobile_push_devices(account_id)`);
    await c.query(`CREATE TABLE IF NOT EXISTS booking_mobile_push_events (
      id BIGSERIAL PRIMARY KEY, plot_id INTEGER NOT NULL, source TEXT NOT NULL,
      source_id TEXT NOT NULL, kind TEXT NOT NULL, account_id INTEGER,
      reminder_date DATE, reminder_offset INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expanded_at TIMESTAMPTZ, lease_until TIMESTAMPTZ,
      CONSTRAINT mobile_push_event_kind CHECK(kind IN ('payment','refund','payment_update','installment'))
    )`);
    await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS booking_mobile_push_reminder_unique
      ON booking_mobile_push_events(account_id,plot_id,source_id,reminder_date,reminder_offset)
      WHERE kind='installment'`);
    await c.query(`CREATE INDEX IF NOT EXISTS booking_mobile_push_event_pending_idx ON booking_mobile_push_events(id) WHERE expanded_at IS NULL`);
    await c.query(`CREATE TABLE IF NOT EXISTS booking_mobile_push_deliveries (
      event_id BIGINT NOT NULL REFERENCES booking_mobile_push_events(id) ON DELETE CASCADE,
      token_hash CHAR(64) NOT NULL REFERENCES booking_mobile_push_devices(token_hash) ON DELETE CASCADE,
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sent','skipped','failed')),
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt TIMESTAMPTZ NOT NULL DEFAULT now(),
      lease_until TIMESTAMPTZ, PRIMARY KEY(event_id,token_hash)
    )`);
    await c.query(`CREATE INDEX IF NOT EXISTS booking_mobile_push_delivery_pending_idx ON booking_mobile_push_deliveries(next_attempt,event_id) WHERE state='pending'`);
    // Enqueue changes only if visible under the same posting policy as the app.
    // Conversion to JSON handles columns that may be absent in older ledgers.
    await c.query(`CREATE OR REPLACE FUNCTION booking_mobile_push_capture_payment() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE n jsonb; o jsonb; posted boolean := false; old_posted boolean := false;
        mode text; old_mode text; v_amount numeric; v_old_amount numeric; v_date date; old_date date;
      BEGIN
        IF TG_OP <> 'DELETE' THEN
          n := to_jsonb(NEW); v_amount := COALESCE((n->>'amount')::numeric,0);
          mode := COALESCE(n->>'payment_type',n->>'payment_mode','');
          v_date := COALESCE(n->>'date',n->>'payment_date')::date;
          posted := COALESCE(v_amount <> 0 AND v_date BETWEEN DATE '1900-01-01' AND DATE '2100-12-31'
            AND financial_transaction_posts(CASE WHEN v_amount < 0 THEN 'debit' ELSE 'credit' END,n->>'status',mode,n->>'cheque_status'),false);
        END IF;
        IF TG_OP <> 'INSERT' THEN
          o := to_jsonb(OLD); v_old_amount := COALESCE((o->>'amount')::numeric,0);
          old_mode := COALESCE(o->>'payment_type',o->>'payment_mode','');
          old_date := COALESCE(o->>'date',o->>'payment_date')::date;
          old_posted := COALESCE(v_old_amount <> 0 AND old_date BETWEEN DATE '1900-01-01' AND DATE '2100-12-31'
            AND financial_transaction_posts(CASE WHEN v_old_amount < 0 THEN 'debit' ELSE 'credit' END,o->>'status',old_mode,o->>'cheque_status'),false);
        END IF;
        IF posted AND NOT old_posted THEN
          INSERT INTO booking_mobile_push_events(plot_id,source,source_id,kind)
            VALUES ((n->>'plot_id')::integer,TG_TABLE_NAME,n->>'id',CASE WHEN v_amount < 0 THEN 'refund' ELSE 'payment' END);
        ELSIF old_posted AND (TG_OP='DELETE' OR NOT posted OR
          (n->>'amount',n->>'plot_id',n->>'status',n->>'cheque_status',mode,v_date) IS DISTINCT FROM
          (o->>'amount',o->>'plot_id',o->>'status',o->>'cheque_status',old_mode,old_date)) THEN
          IF posted AND (n->>'plot_id') IS NOT DISTINCT FROM (o->>'plot_id')
             AND (v_amount < 0) IS DISTINCT FROM (v_old_amount < 0) THEN
            INSERT INTO booking_mobile_push_events(plot_id,source,source_id,kind)
              VALUES ((n->>'plot_id')::integer,TG_TABLE_NAME,n->>'id',CASE WHEN v_amount < 0 THEN 'refund' ELSE 'payment' END);
          ELSE
            INSERT INTO booking_mobile_push_events(plot_id,source,source_id,kind)
              VALUES ((o->>'plot_id')::integer,TG_TABLE_NAME,o->>'id','payment_update');
            IF posted AND (n->>'plot_id') IS DISTINCT FROM (o->>'plot_id') THEN
              INSERT INTO booking_mobile_push_events(plot_id,source,source_id,kind)
                VALUES ((n->>'plot_id')::integer,TG_TABLE_NAME,n->>'id',CASE WHEN v_amount < 0 THEN 'refund' ELSE 'payment' END);
            END IF;
          END IF;
        END IF;
        IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      EXCEPTION WHEN OTHERS THEN
        -- Notifications are secondary to financial posting. Roll back only
        -- this trigger's attempted outbox changes, emit an operator-visible
        -- warning without transaction data, and preserve the ledger write.
        RAISE WARNING 'My Real Assets push capture failed (SQLSTATE %); ledger write preserved', SQLSTATE;
        IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END $$`);
    for (const table of ['plot_payments', 'plot_installment_payments']) {
      await c.query(`DROP TRIGGER IF EXISTS booking_mobile_push_capture ON ${table}`);
      await c.query(`CREATE TRIGGER booking_mobile_push_capture AFTER INSERT OR UPDATE OR DELETE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION booking_mobile_push_capture_payment()`);
    }
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrateMobilePush().then(() => console.log('Mobile push tables and triggers ready.'))
    .catch(e => { console.error('Mobile push migration failed:', e.code || 'MIGRATION_FAILED'); process.exitCode = 1; })
    .finally(() => pool.end());
}
