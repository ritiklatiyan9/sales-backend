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

test('later KYC sync preserves explicit multi-dealer attribution and allocations', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    CREATE TABLE members(id integer PRIMARY KEY,site_id integer,full_name text);
    CREATE TABLE users(id integer PRIMARY KEY,name text,email text,phone text,photo text);
    CREATE TABLE plots(id integer PRIMARY KEY,site_id integer,plot_no text,status text,
      buyer_member_id integer,buyer_name text,booking_by text,booking_date date,
      plot_size numeric,plot_rate numeric,commission_rate numeric,plot_commission numeric,
      updated_at timestamptz DEFAULT NOW());
    CREATE TABLE plot_commissions_v2(id integer PRIMARY KEY,site_id integer,plot_id integer,agent_id integer,
      total_commission numeric,allocation_type text,allocation_value numeric,allocation_base numeric,remarks text,status text,created_by integer);
    CREATE TABLE plot_commission_payments(id integer PRIMARY KEY,plot_commission_id integer,amount numeric);
    INSERT INTO members VALUES(1,1,'Buyer'),(2,1,'Alice'),(3,1,'Bob'),(4,1,'Carol'),(5,1,'New KYC agent');
    INSERT INTO users VALUES(6,'KYC Staff','staff@example.test','9876543210',NULL);
    INSERT INTO plots(id,site_id,plot_no,status,buyer_member_id,buyer_name,booking_by,plot_size,plot_rate,plot_commission)
      VALUES(1,1,'A2','BOOKED',1,'BUYER','ALICE, BOB, CAROL',100,1000,10000);
    INSERT INTO plot_commissions_v2 VALUES
      (10,1,1,2,3000,'percentage',30,10000,'Auto-created from Plot Payments booking','Pending',7),
      (11,1,1,3,5000,'percentage',50,10000,NULL,'Pending',7),
      (12,1,1,4,2000,'amount',2000,10000,NULL,'Pending',7);
    INSERT INTO plot_commission_payments VALUES(20,10,500);
  `);
  const before = (await db.query('SELECT * FROM plot_commissions_v2 ORDER BY id')).rows;
  const payments = (await db.query('SELECT * FROM plot_commission_payments ORDER BY id')).rows;
  for (const agent of [5, null]) {
    const result = await syncPlotBookingToAccounting({ id:9,plot_id:1,site_id:1,client_member_id:1,
      booking_agent_id:agent,created_by:6,booking_date:'2026-11-11' },db);
    assert.equal(result.ok,true);
    assert.equal(result.booking_by,'ALICE, BOB, CAROL');
    assert.deepEqual(result.commission,{created:false,reason:'managed_allocations_preserved'});
    assert.equal((await db.query('SELECT booking_by FROM plots WHERE id=1')).rows[0].booking_by,'ALICE, BOB, CAROL');
    assert.deepEqual((await db.query('SELECT * FROM plot_commissions_v2 ORDER BY id')).rows,before);
    assert.deepEqual((await db.query('SELECT * FROM plot_commission_payments ORDER BY id')).rows,payments);
    assert.equal((await db.query('SELECT COUNT(*)::int AS count FROM members')).rows[0].count,5,'no unrelated staff member provisioned');
  }

  // Simulate an allocation edit winning between the initial read and sync's
  // update. Optimistic label preservation avoids overwriting the new names.
  await db.exec("DELETE FROM plot_commission_payments;DELETE FROM plot_commissions_v2;UPDATE plots SET booking_by='OLD AGENT' WHERE id=1");
  let introduced = false;
  const concurrent = { query: async (sql, values) => {
    if (!introduced && sql.includes('UPDATE plots')) {
      introduced = true;
      await db.exec("UPDATE plots SET booking_by='ALICE, BOB' WHERE id=1; INSERT INTO plot_commissions_v2 VALUES(30,1,1,2,10000,'percentage',100,10000,NULL,'Pending',7)");
    }
    return db.query(sql,values);
  } };
  const raced = await syncPlotBookingToAccounting({id:9,plot_id:1,site_id:1,client_member_id:1,booking_agent_id:5},concurrent);
  assert.equal(raced.ok,true);
  assert.equal(raced.booking_by,'ALICE, BOB');
  assert.deepEqual(raced.commission,{created:false,reason:'managed_allocations_preserved'});
  assert.equal((await db.query('SELECT COUNT(*)::int AS count FROM plot_commissions_v2')).rows[0].count,1);
});

test('cancelled and previous booking rows cannot be reactivated by later KYC sync', async t => {
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(`CREATE TABLE members(id int PRIMARY KEY,site_id int,full_name text);
    CREATE TABLE plots(id int PRIMARY KEY,site_id int,plot_no text,status text,buyer_member_id int,buyer_name text,
      booking_by text,booking_date date,plot_size numeric,plot_rate numeric,commission_rate numeric,plot_commission numeric,
      booking_cancelled_at timestamptz,updated_at timestamptz DEFAULT NOW());
    CREATE TABLE plot_commissions_v2(id int PRIMARY KEY,site_id int,plot_id int,agent_id int,total_commission numeric,
      allocation_type text,remarks text,status text,created_by int);
    CREATE TABLE plot_commission_payments(id int PRIMARY KEY,plot_commission_id int,amount numeric);
    INSERT INTO members VALUES(1,1,'Old buyer'),(2,1,'New buyer'),(3,1,'Original dealer');
    INSERT INTO plots VALUES(1,1,'A2','CANCELLED',1,'OLD BUYER','ORIGINAL DEALER','2026-09-01',100,1000,10,1000,'2026-10-01',NOW());
    INSERT INTO plot_commissions_v2 VALUES(10,1,1,3,1000,'percentage','Original split','Partial',7);
    INSERT INTO plot_commission_payments VALUES(11,10,250);`);
  const booking={id:50,plot_id:1,site_id:1,client_member_id:1,booking_agent_id:3,booking_date:'2026-11-01'};
  const originals=(await db.query('SELECT * FROM plot_commissions_v2')).rows;
  const payments=(await db.query('SELECT * FROM plot_commission_payments')).rows;
  for(const status of ['CANCELLED','RESALE','TRANSFERRED','UNDER CANCELLATION']){
    await db.query('UPDATE plots SET status=$1 WHERE id=1',[status]);
    const before=(await db.query('SELECT * FROM plots')).rows[0];
    const result=await syncPlotBookingToAccounting(booking,db);
    assert.equal(result.ok,false);assert.equal(result.reason,'historical_booking_requires_new_plot');
    assert.deepEqual((await db.query('SELECT * FROM plots')).rows[0],before);
  }
  await db.exec("UPDATE plots SET status='BOOKED' WHERE id=1");
  assert.equal((await syncPlotBookingToAccounting(booking,db)).reason,'historical_booking_requires_new_plot','Cancellation marker remains authoritative if a scalar status was accidentally reset');
  await db.exec("UPDATE plots SET booking_cancelled_at=NULL WHERE id=1");
  let raced=false;
  const adapter={query:async(sql,values)=>{
    if(!raced&&sql.includes('UPDATE plots')){
      raced=true;await db.exec("UPDATE plots SET status='CANCELLED',booking_cancelled_at=NOW() WHERE id=1");
    }
    return db.query(sql,values);
  }};
  assert.equal((await syncPlotBookingToAccounting(booking,adapter)).reason,'historical_booking_requires_new_plot');
  assert.equal((await db.query('SELECT status FROM plots')).rows[0].status,'CANCELLED');
  assert.deepEqual((await db.query('SELECT * FROM plot_commissions_v2')).rows,originals);
  assert.deepEqual((await db.query('SELECT * FROM plot_commission_payments')).rows,payments);
});
