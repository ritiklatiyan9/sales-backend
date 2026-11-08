import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { postingPolicySql } from '../test/mobilePostingPolicy.fixture.mjs';
import { createBrokerBookingProgressReader, projectBrokerBookingProgress } from './brokerBookingProgress.service.js';

const now = () => Date.parse('2026-11-08T12:00:00Z');
const plot = { id: 1, site_id: 1, client_id: 10, current_client_name: 'Current Buyer', status: 'BOOKED', balanceAmount: 100 };
const step = (result, code) => result.milestones.find(item => item.code === code);

async function fixture({ optional = true } = {}) {
  const db = new PGlite();
  await db.exec(`CREATE TABLE plots(id integer PRIMARY KEY,site_id integer,plot_no text);
    CREATE TABLE bookings(id integer PRIMARY KEY,plot_id integer,site_id integer,client_member_id integer,status text,booking_date date,created_at timestamptz,updated_at timestamptz);
    INSERT INTO plots VALUES(1,1,'A1'),(2,1,'A1'),(3,2,'A1');
    INSERT INTO bookings(id,plot_id,site_id,client_member_id,status,booking_date,created_at) VALUES(1,1,1,9,'CANCELLED','2025-01-01','2025-01-01T10:00:00Z'),
      (2,1,1,10,'CONFIRMED','2026-10-01','2026-10-01T10:00:00Z'),
      (3,2,1,20,'CONFIRMED','2026-10-01','2026-10-01T10:00:00Z'),
      (4,3,2,30,'CONFIRMED','2026-10-01','2026-10-01T10:00:00Z');`);
  await db.exec(postingPolicySql);
  if (optional) await db.exec(`
    CREATE TABLE plot_registries(id integer PRIMARY KEY,plot_id integer,site_id integer,plot_no text,customer_name text,registry_date date,created_at timestamptz,updated_at timestamptz,
      size_meter numeric,size_sqyard numeric,circle_rate numeric,farmer_name text,seller_name text,registry_payment numeric);
    CREATE TABLE kyc_cases(id integer PRIMARY KEY,booking_id integer,site_id integer);
    CREATE TABLE documents(id integer PRIMARY KEY,plot_id integer,site_id integer,client_member_id integer,kyc_case_id integer,category text,uploaded_source text,file_path text,created_at timestamptz);
    CREATE TABLE registry_document_handovers(id integer PRIMARY KEY,registry_id integer,site_id integer,given_at timestamptz);
    CREATE TABLE plot_payments(id integer PRIMARY KEY,plot_id integer,site_id integer,amount numeric,date date,payment_type text,status text,cheque_status text,money_transfer_id integer,entry_transfer_id integer,created_at timestamptz);
    CREATE TABLE plot_installments(id integer PRIMARY KEY,plot_id integer);
    CREATE TABLE plot_installment_payments(id integer PRIMARY KEY,plot_id integer,installment_id integer,amount numeric,payment_date date,payment_mode text,status text,cheque_status text,money_transfer_id integer,entry_transfer_id integer,created_at timestamptz);
    CREATE TABLE website_booking_requests(id integer PRIMARY KEY,booking_id integer,plot_id integer,site_id integer,amount_refunded_paise bigint,refund_required boolean,created_at timestamptz,updated_at timestamptz);
  `);
  return db;
}

async function addRegistry(db, { id = 1, plotId = 1, siteId = 1, buyer = 'Current Buyer', created = '2026-10-02T10:00:00Z', complete = true } = {}) {
  await db.query(`INSERT INTO plot_registries VALUES($1,$2,$3,'A1',$4,'2026-10-03',$5,'2026-11-08',0,$6,$7,$8,'',$9)`,
  [id, plotId, siteId, buyer, created, complete ? 100 : 0, complete ? 1000 : 0, complete ? 'Seller' : '', complete ? 100000 : 0]);
}
async function addDeed(db, { id = 1, plotId = 1, siteId = 1, clientId = 10, caseId = null, category = 'REGISTRY', source = 'BOOKING', path = 'private://never-return-this', created = '2026-10-03T10:00:00Z' } = {}) {
  await db.query('INSERT INTO documents VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id, plotId, siteId, clientId, caseId, category, source, path, created]);
}
async function addRefund(db, { id = 1, plotId = 1, siteId = 1, date = '2026-10-04', status = 'approved', mode = 'CASH', cheque = null, transfer = null, entry = null, created = '2026-10-04T10:00:00Z' } = {}) {
  await db.query('INSERT INTO plot_payments VALUES($1,$2,$3,-100,$4,$5,$6,$7,$8,$9,$10)', [id, plotId, siteId, date, mode, status, cheque, transfer, entry, created]);
}

test('current booking dates and next actions come from the latest matching booking', async t => {
  const db = await fixture(); t.after(() => db.close());
  const read = createBrokerBookingProgressReader(db, { now });
  const current = await read(plot);
  assert.deepEqual(current, { currentStage: 'booked', nextAction: 'review_installments', milestones: [{ code: 'booking', state: 'complete', date: '2026-10-01' }] });
  assert.equal((await read({ ...plot, balanceAmount: 0 })).nextAction, 'contact_admin');
  const oldBuyer = await read({ ...plot, client_id: 9 });
  assert.equal(step(oldBuyer, 'booking').state, 'unavailable');
  assert.equal(step(oldBuyer, 'booking').date, null);
  assert.equal(oldBuyer.nextAction, 'contact_admin');
  await db.exec("UPDATE bookings SET created_at=NULL WHERE id=2");
  assert.equal(step(await read(plot), 'booking').date, '2026-10-01');
});

test('optional lifecycle tables are not prerequisites for property details', async t => {
  const db = await fixture({ optional: false }); t.after(() => db.close());
  const read = createBrokerBookingProgressReader(db, { now });
  const registry = await read({ ...plot, status: 'REGISTRY' });
  assert.equal(registry.currentStage, 'registry_pending');
  assert.equal(registry.nextAction, 'await_registry_details');
  assert.equal(step(registry, 'registry_started').state, 'current');
  const cancelled = await read({ ...plot, status: 'Cancelled' });
  assert.equal(cancelled.currentStage, 'cancelled');
  assert.deepEqual(step(cancelled, 'cancellation'), { code: 'cancellation', state: 'complete', date: null });
  assert.equal(step(cancelled, 'refund').state, 'unavailable');
});

test('REGISTRY workspace and a legal date do not mean details, deed or handover completion', async t => {
  const db = await fixture(); t.after(() => db.close()); await addRegistry(db, { complete: false });
  const read = createBrokerBookingProgressReader(db, { now });
  let result = await read({ ...plot, status: 'REGISTRY' });
  assert.equal(result.currentStage, 'registry_pending');
  assert.equal(result.nextAction, 'await_registry_details');
  await db.exec("UPDATE plot_registries SET size_sqyard=100,circle_rate=1000,farmer_name='Seller',registry_payment=100000");
  result = await read({ ...plot, status: 'REGISTRY' });
  assert.equal(result.currentStage, 'registry_deed_pending');
  assert.equal(result.nextAction, 'await_registry_deed');
  assert.deepEqual(step(result, 'registry_started'), { code: 'registry_started', state: 'complete', date: '2026-10-02' });
  assert.equal(step(result, 'registry_deed').state, 'pending');
  assert.equal(step(result, 'registry_handover').state, 'pending');
  assert.ok(!JSON.stringify(result).includes('2026-10-03'));
});

test('registry deed and subsequent handover advance recorded progress without exposing their payloads', async t => {
  const db = await fixture(); t.after(() => db.close()); await addRegistry(db); await addDeed(db);
  const read = createBrokerBookingProgressReader(db, { now });
  assert.equal((await read({ ...plot, status: 'REGISTRY' })).currentStage, 'registry_handover_pending');
  await db.exec("INSERT INTO registry_document_handovers VALUES(1,1,1,'2026-10-04T12:00:00Z')");
  const result = await read({ ...plot, status: 'REGISTRY' });
  assert.equal(result.currentStage, 'registry_complete');
  assert.equal(result.nextAction, 'none');
  assert.deepEqual(step(result, 'registry_deed'), { code: 'registry_deed', state: 'complete', date: '2026-10-03' });
  assert.deepEqual(step(result, 'registry_handover'), { code: 'registry_handover', state: 'complete', date: '2026-10-04' });
  assert.ok(!/private|Current Buyer|plot_id|client_id|site_id|customer_name|file_path/.test(JSON.stringify(result)));
  await db.exec('DELETE FROM documents');
  const removed = await read({ ...plot, status: 'REGISTRY' });
  assert.equal(removed.currentStage, 'registry_deed_pending');
  assert.equal(step(removed, 'registry_handover').state, 'pending');
  assert.equal(step(removed, 'registry_handover').date, null);
});

test('registry evidence rejects other plots/sites, old owners, future records and contradictory buyer names', async t => {
  const db = await fixture(); t.after(() => db.close());
  const read = createBrokerBookingProgressReader(db, { now });
  await addRegistry(db, { plotId: 2 });
  await addRegistry(db, { id: 2, plotId: 3, siteId: 2 });
  await addRegistry(db, { id: 3, created: '2025-01-02T10:00:00Z' });
  assert.equal((await read({ ...plot, status: 'REGISTRY' })).currentStage, 'registry_pending');
  await addRegistry(db, { id: 4, buyer: 'Previous Buyer' });
  assert.equal((await read({ ...plot, status: 'REGISTRY' })).currentStage, 'registry_pending');
  await addRegistry(db, { id: 5, created: '2026-12-01T10:00:00Z' });
  assert.equal((await read({ ...plot, status: 'REGISTRY' })).currentStage, 'registry_pending');
  await addRegistry(db, { id: 6 }); await addDeed(db);
  await db.exec("INSERT INTO bookings VALUES(5,1,1,99,'CONFIRMED','2026-11-01','2026-11-01T10:00:00Z',NULL)");
  const changed = await read({ ...plot, status: 'REGISTRY' });
  assert.equal(changed.currentStage, 'registry_pending');
  assert.equal(step(changed, 'booking').state, 'unavailable');
  assert.equal(step(changed, 'registry_started').date, null);
});

test('deeds require exact current ownership, valid storage, current dates and current legacy booking links', async t => {
  const db = await fixture(); t.after(() => db.close()); await addRegistry(db);
  const read = createBrokerBookingProgressReader(db, { now });
  await db.exec('INSERT INTO kyc_cases VALUES(1,1,1),(2,2,1),(3,3,1)');
  const invalid = [
    { plotId: 2 }, { siteId: 2 }, { clientId: 9 }, { path: ' ' }, { source: 'DMS' }, { category: 'KYC' },
    { created: '2025-01-03T10:00:00Z' }, { created: '2026-12-03T10:00:00Z' },
    { plotId: null, caseId: 1 }, { plotId: null, caseId: 3 },
  ];
  for (let i = 0; i < invalid.length; i++) await addDeed(db, { id: i + 1, ...invalid[i] });
  assert.equal((await read({ ...plot, status: 'REGISTRY' })).currentStage, 'registry_deed_pending');
  await addDeed(db, { id: 50, plotId: null, caseId: 2 });
  assert.equal((await read({ ...plot, status: 'REGISTRY' })).currentStage, 'registry_handover_pending');
  await db.exec("INSERT INTO registry_document_handovers VALUES(1,1,2,'2026-10-04T12:00:00Z'),(2,1,1,'2026-10-02T12:00:00Z'),(3,1,1,'2026-12-04T12:00:00Z')");
  assert.equal((await read({ ...plot, status: 'REGISTRY' })).currentStage, 'registry_handover_pending');
});

test('registry completion reads current deed and handover in the same database snapshot', async t => {
  const db = await fixture(); t.after(() => db.close()); await addRegistry(db); await addDeed(db);
  await db.exec("INSERT INTO registry_document_handovers VALUES(1,1,1,'2026-10-04T12:00:00Z')");
  let deleted = false;
  const read = createBrokerBookingProgressReader({ async query(sql, args) {
    if (!deleted && sql.includes('FROM registry_document_handovers')) {
      deleted = true;
      await db.exec('DELETE FROM documents');
    }
    return db.query(sql, args);
  } }, { now });
  const result = await read({ ...plot, status: 'REGISTRY' });
  assert.equal(deleted, true);
  assert.equal(result.currentStage, 'registry_deed_pending');
  assert.equal(step(result, 'registry_handover').state, 'pending');
});

test('timestamp milestones use India calendar days while genuine DATE values stay unchanged', async t => {
  const db = await fixture(); t.after(() => db.close());
  await db.exec("UPDATE bookings SET booking_date=NULL,created_at='2026-11-07T18:40:00Z' WHERE id=2");
  await addRegistry(db, { created: '2026-11-07T19:00:00Z' });
  await addDeed(db, { created: '2026-11-07T20:00:00Z' });
  await db.exec("INSERT INTO registry_document_handovers VALUES(1,1,1,'2026-11-07T21:00:00Z')");
  const read = createBrokerBookingProgressReader(db, { now });
  const result = await read({ ...plot, status: 'REGISTRY' });
  assert.equal(result.currentStage, 'registry_complete');
  for (const item of result.milestones) assert.equal(item.date, '2026-11-08');
  await db.exec("UPDATE bookings SET booking_date='2026-11-07' WHERE id=2");
  assert.equal(step(await read(plot), 'booking').date, '2026-11-07');
  await addRefund(db, { date: '2026-11-07', created: '2026-11-08T10:00:00Z' });
  assert.equal((await read({ ...plot, status: 'Cancelled' })).currentStage, 'cancelled');
  await addRefund(db, { id: 2, date: '2026-11-08', created: '2026-11-08T10:00:00Z' });
  assert.equal(step(await read({ ...plot, status: 'Cancelled' }), 'refund').date, '2026-11-08');
});

test('in-place booking owner edits suppress older same-name registry and refund evidence without inventing edit milestones', async t => {
  const db = await fixture(); t.after(() => db.close()); await addRegistry(db); await addDeed(db); await addRefund(db);
  await db.exec("INSERT INTO registry_document_handovers VALUES(1,1,1,'2026-10-04T12:00:00Z')");
  const read = createBrokerBookingProgressReader(db, { now });
  assert.equal((await read({ ...plot, status: 'REGISTRY' })).currentStage, 'registry_complete');
  await db.exec("UPDATE bookings SET client_member_id=99,updated_at='2026-11-01T10:00:00Z' WHERE id=2");
  const changed = { ...plot, client_id: 99 };
  const registry = await read({ ...changed, status: 'REGISTRY' });
  assert.equal(registry.currentStage, 'registry_pending');
  assert.equal(step(registry, 'booking').date, null);
  assert.equal(step(registry, 'registry_started').date, null);
  const cancelled = await read({ ...changed, status: 'Cancelled' });
  assert.equal(cancelled.currentStage, 'cancelled');
  assert.equal(step(cancelled, 'refund').state, 'unavailable');
  assert.ok(!/2026-10|2026-11-01/.test(JSON.stringify(registry)));
  await addRegistry(db, { id: 2, created: '2026-11-02T10:00:00Z' });
  await addDeed(db, { id: 2, clientId: 99, created: '2026-11-03T10:00:00Z' });
  await db.exec("INSERT INTO registry_document_handovers VALUES(2,2,1,'2026-11-04T12:00:00Z')");
  assert.equal((await read({ ...changed, status: 'REGISTRY' })).currentStage, 'registry_complete');
  await addRefund(db, { id: 2, date: '2026-11-05', created: '2026-11-05T10:00:00Z' });
  assert.equal((await read({ ...changed, status: 'Cancelled' })).currentStage, 'refund_recorded');
  for (const edit of ['2026-12-01T10:00:00Z', '2026-09-01T10:00:00Z']) {
    await db.query('UPDATE bookings SET updated_at=$1 WHERE id=2', [edit]);
    const invalid = await read({ ...changed, status: 'REGISTRY' });
    assert.equal(invalid.currentStage, 'registry_pending');
    assert.equal(invalid.nextAction, 'contact_admin');
    assert.equal(step(invalid, 'booking').date, null);
  }
});

test('cancellation states remain undated and never manufacture a refund obligation', async t => {
  const db = await fixture(); t.after(() => db.close());
  const read = createBrokerBookingProgressReader(db, { now });
  const pending = await read({ ...plot, status: 'Under Cancellation' });
  assert.equal(pending.currentStage, 'cancellation_pending');
  assert.equal(pending.nextAction, 'await_cancellation');
  assert.deepEqual(step(pending, 'cancellation'), { code: 'cancellation', state: 'current', date: null });
  assert.equal(step(pending, 'refund').state, 'unavailable');
  const resale = await read({ ...plot, status: 'RESALE' });
  assert.equal(resale.currentStage, 'resale');
  assert.equal(step(resale, 'cancellation'), undefined);
  assert.equal((await read({ ...plot, status: 'TRANSFERRED' })).currentStage, 'transferred');
  assert.equal((await read({ ...plot, status: 'Unexpected private status' })).currentStage, 'unknown');
});

test('refund entries use posting policy, exclude both transfer links and stay current-booking scoped', async t => {
  const db = await fixture(); t.after(() => db.close());
  const read = createBrokerBookingProgressReader(db, { now });
  await addRefund(db, { transfer: 50 }); await addRefund(db, { id: 2, entry: 60 });
  await addRefund(db, { id: 3, plotId: 2 }); await addRefund(db, { id: 4, siteId: 2 });
  await addRefund(db, { id: 5, created: '2025-01-03T10:00:00Z' });
  await addRefund(db, { id: 6, date: '2025-01-03' });
  await addRefund(db, { id: 7, status: 'rejected' });
  await addRefund(db, { id: 8, mode: 'CHEQUE', cheque: 'BOUNCED' });
  await addRefund(db, { id: 9, created: null });
  await addRefund(db, { id: 10, date: '2026-12-04', created: '2026-12-04T10:00:00Z' });
  let result = await read({ ...plot, status: 'Cancelled' });
  assert.equal(result.currentStage, 'cancelled'); assert.equal(step(result, 'refund').state, 'unavailable');
  await addRefund(db, { id: 11, status: 'pending' });
  result = await read({ ...plot, status: 'Cancelled' });
  assert.equal(result.currentStage, 'refund_pending'); assert.equal(step(result, 'refund').date, null);
  await addRefund(db, { id: 12, mode: 'CHEQUE', cheque: 'PENDING' });
  assert.equal((await read({ ...plot, status: 'Cancelled' })).currentStage, 'refund_pending');
  await addRefund(db, { id: 13, date: '2026-10-05' });
  result = await read({ ...plot, status: 'Cancelled' });
  assert.equal(result.currentStage, 'refund_recorded'); assert.equal(result.nextAction, 'confirm_refund');
  assert.deepEqual(step(result, 'refund'), { code: 'refund', state: 'complete', date: '2026-10-05' });
  assert.ok(!/amount|100|settled|refunded/.test(JSON.stringify(result)));
  assert.equal((await read(plot)).currentStage, 'booked');
});

test('installment refunds require exact installment/plot and preserve cheque posting rules', async t => {
  const db = await fixture(); t.after(() => db.close());
  const read = createBrokerBookingProgressReader(db, { now });
  await db.exec(`INSERT INTO plot_installments VALUES(1,1),(2,2);
    INSERT INTO plot_installment_payments VALUES
      (1,1,2,-100,'2026-10-05','CASH','approved',NULL,NULL,NULL,'2026-10-05T10:00:00Z'),
      (2,1,1,-100,'2026-10-05','CASH','approved',NULL,NULL,1,'2026-10-05T10:00:00Z');`);
  assert.equal((await read({ ...plot, status: 'Cancelled' })).currentStage, 'cancelled');
  await db.exec("INSERT INTO plot_installment_payments VALUES(3,1,1,-100,'2026-10-06','CHEQUE','approved','CLEARED',NULL,NULL,'2026-10-06T10:00:00Z')");
  const result = await read({ ...plot, status: 'Cancelled' });
  assert.equal(result.currentStage, 'refund_recorded');
  assert.equal(step(result, 'refund').date, '2026-10-06');
});

test('website refunds bind the exact current booking and do not use mutable update timestamps', async t => {
  const db = await fixture(); t.after(() => db.close());
  const read = createBrokerBookingProgressReader(db, { now });
  await db.exec(`INSERT INTO website_booking_requests VALUES
    (1,1,1,1,1000,false,'2025-01-01','2026-11-08'),
    (2,2,2,1,1000,false,'2026-09-30','2026-11-08'),
    (3,2,1,2,1000,false,'2026-09-30','2026-11-08');`);
  assert.equal((await read({ ...plot, status: 'Cancelled' })).currentStage, 'cancelled');
  await db.exec("INSERT INTO website_booking_requests VALUES(4,2,1,1,0,true,'2026-09-30','2026-11-08')");
  assert.equal((await read({ ...plot, status: 'Cancelled' })).currentStage, 'refund_pending');
  await db.exec('UPDATE website_booking_requests SET amount_refunded_paise=100 WHERE id=4');
  const result = await read({ ...plot, status: 'Cancelled' });
  assert.equal(result.currentStage, 'refund_recorded');
  assert.equal(result.nextAction, 'confirm_refund');
  assert.equal(step(result, 'refund').date, null);
});

test('an old website request does not follow an in-place booking owner edit', async t => {
  const db = await fixture(); t.after(() => db.close());
  const read = createBrokerBookingProgressReader(db, { now });
  await db.exec("INSERT INTO website_booking_requests VALUES(1,2,1,1,100,true,'2026-09-30','2026-11-08')");
  assert.equal((await read({ ...plot, status: 'Cancelled' })).currentStage, 'refund_recorded');
  await db.exec("UPDATE bookings SET client_member_id=99,updated_at='2026-11-01T10:00:00Z' WHERE id=2");
  const result = await read({ ...plot, client_id: 99, status: 'Cancelled' });
  assert.equal(result.currentStage, 'cancelled');
  assert.equal(step(result, 'refund').state, 'unavailable');
});

test('pure projection emits only fixed codes and does not treat missing evidence as completion', () => {
  assert.deepEqual(projectBrokerBookingProgress({ status: 'secret status' }), {
    currentStage: 'unknown', nextAction: 'contact_admin', milestones: [{ code: 'booking', state: 'unavailable', date: null }],
  });
  const result = projectBrokerBookingProgress({ status: 'Registered' }, { handedOver: true });
  assert.equal(result.currentStage, 'registry_pending');
  assert.equal(step(result, 'registry_handover').state, 'pending');
});
