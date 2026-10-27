import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

// Broker-app credentials are independent from users/staff web credentials.
// Aadhaar is never copied into these tables: only its keyed identity digest.
export async function migrateBrokerMobileAuth(db = pool) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TABLE IF NOT EXISTS booking_broker_mobile_accounts (
      id SERIAL PRIMARY KEY,
      phone VARCHAR(10) NOT NULL CHECK (phone ~ '^[6-9][0-9]{9}$'),
      identity_key CHAR(64) NOT NULL CHECK (identity_key ~ '^[a-f0-9]{64}$'),
      password_hash TEXT NOT NULL,
      password_changed BOOLEAN NOT NULL DEFAULT false,
      token_version INTEGER NOT NULL DEFAULT 0 CHECK (token_version >= 0),
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(phone, identity_key)
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS booking_broker_mobile_members (
      account_id INTEGER NOT NULL REFERENCES booking_broker_mobile_accounts(id) ON DELETE CASCADE,
      member_id INTEGER NOT NULL UNIQUE REFERENCES members(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(account_id, member_id)
    )`);
    // These identifiers intentionally survive deletion/unlinking of a staff
    // account. Losing a historical enrollment must not restore member-only access.
    await client.query(`CREATE TABLE IF NOT EXISTS booking_broker_mobile_user_bindings (
      account_id INTEGER NOT NULL REFERENCES booking_broker_mobile_accounts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      member_id INTEGER NOT NULL,
      kyc_case_id INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(account_id, user_id)
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS booking_broker_mobile_resets (
      id SERIAL PRIMARY KEY,
      token_hash CHAR(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
      account_id INTEGER NOT NULL REFERENCES booking_broker_mobile_accounts(id) ON DELETE CASCADE,
      account_version INTEGER NOT NULL,
      identity_key CHAR(64) NOT NULL CHECK (identity_key ~ '^[a-f0-9]{64}$'),
      scope_fingerprint CHAR(64) NOT NULL CHECK (scope_fingerprint ~ '^[a-f0-9]{64}$'),
      email_snapshot TEXT NOT NULL,
      code_hash CHAR(64) NOT NULL CHECK (code_hash ~ '^[a-f0-9]{64}$'),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_broker_mobile_resets_account_created
      ON booking_broker_mobile_resets(account_id, created_at DESC)`);
    // Remember a staff enrollment even if it is removed before the next app
    // request. An unlinked/disabled staff account cannot regain member-only
    // access by deleting its current enrollment link.
    await client.query(`CREATE OR REPLACE FUNCTION remember_broker_mobile_user_binding(
      linked_user INTEGER, linked_member INTEGER, linked_case INTEGER)
      RETURNS VOID LANGUAGE SQL AS $$
        INSERT INTO booking_broker_mobile_user_bindings(account_id,user_id,member_id,kyc_case_id)
          SELECT DISTINCT a.id,linked_user,linked_member,linked_case
          FROM members incoming
          JOIN booking_broker_mobile_accounts a
            ON a.phone=right(regexp_replace(COALESCE(incoming.phone,''),'[[:space:]()+-]','','g'),10)
          JOIN booking_broker_mobile_members bm ON bm.account_id=a.id
          JOIN members anchor ON anchor.id=bm.member_id
          WHERE incoming.id=linked_member AND linked_case IS NOT NULL AND linked_user IS NOT NULL
            AND 'BROKER'=ANY(COALESCE(incoming.member_types,ARRAY[incoming.member_type]))
            AND 'BROKER'=ANY(COALESCE(anchor.member_types,ARRAY[anchor.member_type]))
            AND regexp_replace(COALESCE(incoming.phone,''),'[[:space:]()+-]','','g') ~ '^(0091|91|0)?[6-9][0-9]{9}$'
            AND regexp_replace(COALESCE(anchor.phone,''),'[[:space:]()+-]','','g') ~ '^(0091|91|0)?[6-9][0-9]{9}$'
            AND right(regexp_replace(COALESCE(anchor.phone,''),'[[:space:]()+-]','','g'),10)=a.phone
            AND regexp_replace(COALESCE(incoming.aadhar_no,''),'[[:space:]-]','','g') ~ '^[2-9][0-9]{11}$'
            AND regexp_replace(COALESCE(incoming.aadhar_no,''),'[[:space:]-]','','g')
              =regexp_replace(COALESCE(anchor.aadhar_no,''),'[[:space:]-]','','g')
          ON CONFLICT(account_id,user_id) DO NOTHING;
      $$`);
    await client.query(`CREATE OR REPLACE FUNCTION capture_broker_mobile_user_binding()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='UPDATE' THEN
          PERFORM remember_broker_mobile_user_binding(OLD.user_id,OLD.member_id,OLD.kyc_case_id);
        END IF;
        PERFORM remember_broker_mobile_user_binding(NEW.user_id,NEW.member_id,NEW.kyc_case_id);
        RETURN NEW;
      END;
      $$`);
    await client.query(`DROP TRIGGER IF EXISTS trg_capture_broker_mobile_user_binding ON booking_user_kyc_links`);
    await client.query(`CREATE TRIGGER trg_capture_broker_mobile_user_binding
      AFTER INSERT OR UPDATE OF user_id,member_id,kyc_case_id ON booking_user_kyc_links
      FOR EACH ROW EXECUTE FUNCTION capture_broker_mobile_user_binding()`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrateBrokerMobileAuth().then(() => console.log('Broker mobile credential and recovery schema ready.'))
    .catch(error => {
      console.error('Broker mobile auth migration failed:', error.code || 'MIGRATION_FAILED');
      process.exitCode = 1;
    }).finally(() => pool.end());
}
