import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { bootSchemaReady } from './db.js';
import { migrateMemberBookingName } from '../migrations/051_member_booking_name.js';
import { migrateBookingAccountsLoginAccess } from '../migrations/047_booking_accounts_login_access.js';
import { migrateBrokerMobilePush } from '../migrations/048_broker_mobile_push.js';

// Isolated PostgreSQL engine; never connects to the configured/live database.
test('boot probe is false while any object of 051/047/048 is missing and true once they ran', async () => {
  const pg = new PGlite();
  const db = { query: (sql, values) => pg.query(sql, values), connect: async () => ({ query: (sql, values) => pg.query(sql, values), release() {} }) };
  const migrate = async () => { await migrateMemberBookingName(db); await migrateBookingAccountsLoginAccess(db); await migrateBrokerMobilePush(db); };
  try {
    await pg.exec('CREATE TABLE users (id SERIAL PRIMARY KEY); CREATE TABLE members (id SERIAL PRIMARY KEY); CREATE TABLE booking_broker_mobile_accounts (id SERIAL PRIMARY KEY)');
    assert.equal(await bootSchemaReady(db), false, 'fresh database');
    await migrate();
    assert.equal(await bootSchemaReady(db), true, 'after the three migrations');
    for (const drop of [
      'ALTER TABLE members DROP COLUMN booking_name',
      'ALTER TABLE users DROP COLUMN can_login_accounts',
      'ALTER TABLE users DROP COLUMN can_login_booking',
      'ALTER TABLE users DROP COLUMN can_login_booking_accounts',
      'ALTER TABLE login_otps DROP COLUMN app_context',
      'DROP TABLE login_otps',
      'DROP TABLE booking_broker_push_deliveries',
      'DROP TABLE booking_broker_push_events CASCADE',
      'DROP TABLE booking_broker_push_devices CASCADE',
      'DROP INDEX booking_broker_push_devices_account_idx',
      'DROP INDEX booking_broker_push_event_pending_idx',
      'DROP INDEX booking_broker_push_delivery_pending_idx',
    ]) {
      await pg.exec(drop);
      assert.equal(await bootSchemaReady(db), false, drop);
      await migrate();
      assert.equal(await bootSchemaReady(db), true, `re-migrated after ${drop}`);
    }
  } finally { await pg.close(); }
});
