import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { syncPlotBookingToAccounting } from './plotBookingSync.js';

test('booking sync records an explicit same-site client association and preserves protected ownership', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    CREATE TABLE members(id integer PRIMARY KEY,site_id integer,full_name text);
    CREATE TABLE plots(id integer PRIMARY KEY,site_id integer,plot_no text,status text,
      buyer_member_id integer,buyer_name text,booking_by text,booking_date date,
      plot_size numeric,plot_rate numeric,commission_rate numeric,plot_commission numeric,
      updated_at timestamptz DEFAULT '2026-01-01T00:00:00Z');
    INSERT INTO members VALUES (1,1,'Identical Client Name'),(2,1,'Identical Client Name'),(3,2,'Other Site Client');
    INSERT INTO plots(id,site_id,plot_no,status) VALUES (1,1,'A-01','AVAILABLE'),(2,2,'B-02','AVAILABLE');
  `);
  const booking = { id: 1, plot_id: 1, site_id: 1, client_member_id: 1, booking_date: '2026-11-07' };
  const plot = async () => (await db.query('SELECT * FROM plots WHERE id=1')).rows[0];

  await t.test('booking creates the explicit owner link using the same-site client id', async () => {
    const result = await syncPlotBookingToAccounting(booking, db);
    assert.equal(result.ok, true);
    const current = await plot();
    assert.equal(current.status, 'BOOKED');
    assert.equal(current.buyer_member_id, 1);
    assert.equal(current.buyer_name, 'IDENTICAL CLIENT NAME');
    assert.equal(current.booking_date.toISOString().slice(0, 10), '2026-11-07');
    assert.deepEqual(result.commission, { created: false, reason: 'no_matching_agent_member' });
  });

  await t.test('matching names cannot replace a different explicit owner on a protected plot', async () => {
    for (const status of ['BOOKED', 'SOLD', 'REGISTRY', 'UNDER CANCELLATION', 'CANCELLED', 'TRANSFERRED']) {
      await db.query('UPDATE plots SET status=$1,buyer_member_id=1 WHERE id=1', [status]);
      const before = await plot();
      const result = await syncPlotBookingToAccounting({ ...booking, client_member_id: 2 }, db);
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'plot_committed_to_other_buyer');
      assert.deepEqual(await plot(), before);
    }
  });

  await t.test('the same explicit owner can resync after their displayed name changes', async () => {
    await db.exec("UPDATE plots SET status='BOOKED',buyer_name='AN OUTDATED DISPLAY NAME' WHERE id=1");
    const result = await syncPlotBookingToAccounting(booking, db);
    assert.equal(result.ok, true);
    assert.equal((await plot()).buyer_member_id, 1);
    assert.equal((await plot()).buyer_name, 'IDENTICAL CLIENT NAME');
  });

  await t.test('a fresh plot assignment replaces a stale owner link with the selected client', async () => {
    await db.exec("UPDATE plots SET status='AVAILABLE' WHERE id=1");
    const result = await syncPlotBookingToAccounting({ ...booking, client_member_id: 2 }, db);
    assert.equal(result.ok, true);
    assert.equal((await plot()).buyer_member_id, 2);
    assert.equal((await plot()).status, 'BOOKED');
  });

  await t.test('cross-site plot and client selections leave the plot untouched', async () => {
    await db.exec("UPDATE plots SET status='AVAILABLE',buyer_member_id=NULL,buyer_name=NULL WHERE id=1");
    const before = await plot();
    const wrongPlotSite = await syncPlotBookingToAccounting({ ...booking, site_id: 2 }, db);
    assert.deepEqual(wrongPlotSite, { ok: false, reason: 'plot_site_mismatch' });
    assert.deepEqual(await plot(), before);
    const wrongMemberSite = await syncPlotBookingToAccounting({ ...booking, client_member_id: 3 }, db);
    assert.deepEqual(wrongMemberSite, { ok: false, reason: 'client_not_found' });
    assert.deepEqual(await plot(), before);
    const missingMember = await syncPlotBookingToAccounting({ ...booking, client_member_id: 999 }, db);
    assert.deepEqual(missingMember, { ok: false, reason: 'client_not_found' });
    assert.deepEqual(await plot(), before);
  });
});
