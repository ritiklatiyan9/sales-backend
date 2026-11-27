import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { drawFixture } from '../test/drawFixture.mjs';
import { allotShop, getDrawShopBooking, createDrawShopBooking, listDraws } from './draw.controller.js';
import { deleteBooking, updateBooking } from './booking.controller.js';

const site = 7;
const draw = 301;
const shop = 401;
const admin = { id: 1, role: 'admin', organization_id: 1, email: 'admin@example.test' };
const review = { plot_id: shop, site_id: site, client_member_id: 201, expected_sale_price: 850000, expected_draw_credit_amount: 100000 };
const accountsMigration = new URL('../../../../Accounts/rgaccountbackend/src/migrations/238_pool_money.js', import.meta.url);

function request(handler, { body = {}, id = draw, user = admin, query = {} } = {}) {
  return new Promise(resolve => {
    const res = { code: 200, status(code) { this.code = code; return this; }, json(data) { resolve({ status: this.code, data }); } };
    handler({ params: { id }, body, query, user }, res, error => resolve({ status: error.status || 500, data: { message: error.message } }));
  });
}

async function fixture(t) {
  const f = await drawFixture();
  t.after(() => f.close());
  await f.db.exec(`
    ALTER TABLE plots ADD COLUMN unit_type text DEFAULT 'shop', ADD COLUMN approval_status text DEFAULT 'approved',
      ADD COLUMN buyer_member_id integer, ADD COLUMN plot_tag text, ADD COLUMN booking_cancelled_at timestamptz;
    ALTER TABLE plot_payments ADD COLUMN approved_by integer, ADD COLUMN approved_at timestamptz;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS first_installment_amount numeric(15,2);
    CREATE TABLE website_booking_requests(id serial PRIMARY KEY, plot_id integer, status text, hold_expires_at timestamptz);
    INSERT INTO sites(id,name) VALUES(7,'Naya Baazar Unn Commercial');
    INSERT INTO members(id,site_id,member_type,status,full_name) VALUES
      (201,7,'CLIENT','ACTIVE','Shop Applicant'),(202,7,'BROKER','ACTIVE','Draw Broker'),(203,1,'CLIENT','ACTIVE','Other Applicant');
    INSERT INTO kyc_cases(id,site_id,client_member_id,status) VALUES(211,7,201,'VERIFIED');
    INSERT INTO draw_registrations(id,site_id,client_member_id,registration_no,qr_token,required_amount,status,
      slip_no,kyc_case_id,broker_member_id,draw_opening_date,workflow_version) VALUES
      (301,7,201,'DR-301','test-301',100000,'SLIP_ISSUED','SLIP-301',211,202,'2099-01-01',1),
      (302,1,203,'DR-302','test-302',100000,'REGISTERED',NULL,NULL,NULL,'2099-01-01',1);
    INSERT INTO plots(id,site_id,plot_no,status,sale_price,first_installment,installments_enabled,unit_type,approval_status) VALUES
      (401,7,'G-14','COMPANY',850000,200000,true,'shop','approved'),
      (402,7,'G-15','COMPANY',850000,0,false,'shop','pending'),
      (403,7,'G-16','COMPANY',850000,0,false,'shop','approved'),
      (404,7,'P-20','COMPANY',850000,0,false,'plot','approved'),
      (405,7,'G-17','BOOKED',850000,0,false,'shop','approved');
    INSERT INTO website_booking_requests(plot_id,status,hold_expires_at) VALUES(403,'AWAITING_PAYMENT',now()+interval '1 hour');
    INSERT INTO plot_installments(plot_id,installment_name,amount,due_date) VALUES(401,'Deposit',200000,'2026-12-01');
    INSERT INTO bank_accounts(id,site_id,name) VALUES(71,7,'DRAW BANK');
  `);
  return f;
}

async function collect(db, bankAmount = 50000) {
  await db.query(`
    INSERT INTO draw_payments(draw_registration_id,receipt_no,amount,payment_date,payment_from,received_by,
      bank_name,bank_account_id,bank_details,created_by,created_at) VALUES
      (301,'CASH-25',50000,'2026-11-07','CASH','Collector',NULL,NULL,NULL,2,'2026-11-07T10:00:00Z'),
      (301,'BANK-45',$1,'2026-11-07','BANK','Collector','DRAW BANK',71,'BANK-REF',2,'2026-11-16T10:00:00Z');
  `, [bankAmount]);
}

const submit = async (override = {}) => {
  const { data } = await request(getDrawShopBooking);
  return request(createDrawShopBooking, { body: { ...review, receipt_version: data.receipt_version, ...override } });
};

async function assertUnbooked(f) {
  const { rows: [state] } = await f.query(`SELECT
    (SELECT count(*)::int FROM bookings) AS bookings, (SELECT count(*)::int FROM plot_payments) AS payments,
    (SELECT count(*)::int FROM draw_payments WHERE plot_payment_id IS NOT NULL) AS linked,
    (SELECT status FROM plots WHERE id=401) AS shop, (SELECT status FROM draw_registrations WHERE id=301) AS draw_status,
    (SELECT booking_id FROM kyc_cases WHERE id=211) AS kyc_booking`);
  assert.deepEqual(state, { bookings: 0, payments: 0, linked: 0, shop: 'COMPANY', draw_status: 'SLIP_ISSUED', kyc_booking: null });
}

test('Book Shop validates the reviewed draw, books its client before the draw opens and applies each original receipt once', async t => {
  const f = await fixture(t);
  await collect(f.db);
  const register = await request(listDraws, { query: { site_id: site, view: 'active' } });
  assert.equal(register.status, 200, JSON.stringify(register.data));
  assert.equal(register.data.find(r => r.id === draw).direct_shop_booking_enabled, true);
  const otherProject = await request(listDraws, { query: { site_id: 1, view: 'active' } });
  assert.equal(otherProject.data[0].direct_shop_booking_enabled, false);
  assert.equal((await request(getDrawShopBooking, { user: { ...admin, organization_id: null } })).status, 403);
  const options = await request(getDrawShopBooking);
  assert.equal(options.status, 200);
  assert.equal(options.data.reason, null);
  assert.equal(options.data.broker_name, 'Draw Broker');
  assert.deepEqual(options.data.shops.map(p => p.id), [shop]);
  assert.equal(options.data.total, 100000);
  assert.deepEqual(options.data.receipts.map(r => r.receipt_no), ['CASH-25', 'BANK-45']);
  assert.equal((await request(getDrawShopBooking, { id: 302 })).status, 403);
  assert.equal((await request(getDrawShopBooking, { user: { ...admin, organization_id: 2 } })).status, 403);
  assert.equal((await request(createDrawShopBooking, { body: review, user: { ...admin, role: 'agent' } })).status, 403);
  for (const changes of [{ plot_id: 402 }, { plot_id: 403 }, { plot_id: 404 }, { plot_id: 405 }, { plot_id: 1 },
    { expected_sale_price: 800000 }, { expected_draw_credit_amount: 50000 }, { client_member_id: 203 }, { site_id: 1 }]) {
    assert.equal((await submit(changes)).status, 409);
  }
  await f.db.exec("UPDATE kyc_cases SET status='OPEN' WHERE id=211");
  assert.match((await submit()).data.message, /KYC/);
  await f.db.exec("UPDATE kyc_cases SET status='VERIFIED' WHERE id=211; UPDATE draw_registrations SET required_amount=150000 WHERE id=301");
  assert.match((await submit()).data.message, /required draw payment/);
  await f.db.exec("UPDATE draw_registrations SET required_amount=100000 WHERE id=301");
  await f.db.exec("UPDATE draw_payments SET bank_details='NEW-BANK-REF' WHERE receipt_no='BANK-45'");
  assert.match((await submit({ receipt_version: options.data.receipt_version })).data.message, /receipts changed/);
  await f.db.exec("UPDATE draw_payments SET bank_details='BANK-REF' WHERE receipt_no='BANK-45'");
  await assertUnbooked(f);
  const result = await submit();
  assert.equal(result.status, 201, JSON.stringify(result.data));
  const bookingId = result.data.booking_id;
  assert.match(result.data.booking_no, /^BK-\d{4}-\d{6}$/);
  assert.deepEqual([result.data.plot_id, result.data.amount, result.data.receipt_count], [shop, 100000, 2]);
  const { rows: [booking] } = await f.query(`SELECT b.client_member_id,b.status,b.booking_agent_id,b.booked_by,b.created_by,b.token_amount::int,b.payment_plan,
    b.first_installment_amount::int,p.status AS shop_status,p.buyer_member_id,p.buyer_name,p.booking_by,r.is_winner,r.winner_marked_at,
    r.status AS draw_status,k.booking_id AS kyc_booking FROM bookings b JOIN plots p ON p.id=b.plot_id
    JOIN draw_registrations r ON r.booking_id=b.id JOIN kyc_cases k ON k.id=r.kyc_case_id WHERE b.id=$1`, [bookingId]);
  assert.deepEqual(booking, { client_member_id: 201, status: 'CONFIRMED', booking_agent_id: 202, booked_by: 'Draw Broker', created_by: admin.id, token_amount: 0, payment_plan: 'INSTALLMENT',
    first_installment_amount: 200000, shop_status: 'BOOKED', buyer_member_id: 201, buyer_name: 'SHOP APPLICANT', booking_by: 'DRAW BROKER',
    is_winner: false, winner_marked_at: null, draw_status: 'ALLOTTED', kyc_booking: bookingId });
  const { rows: payments } = await f.query(`SELECT d.receipt_no,p.payment_type,p.amount::int,p.created_by,p.bank_details,c.bank_account_id,
    p.date=d.payment_date AS same_date,p.created_at=d.created_at AS same_timestamp
    FROM draw_payments d JOIN plot_payments p ON p.id=d.plot_payment_id JOIN cash_flow_entries c
    ON c.source_module='plot_payments' AND c.source_id=p.id WHERE p.plot_id=$1 ORDER BY d.id`, [shop]);
  assert.deepEqual(payments, [
    { receipt_no: 'CASH-25', payment_type: 'CASH', amount: 50000, created_by: 2, bank_details: null, bank_account_id: null, same_date: true, same_timestamp: true },
    { receipt_no: 'BANK-45', payment_type: 'BANK', amount: 50000, created_by: 2, bank_details: 'BANK-REF', bank_account_id: 71, same_date: true, same_timestamp: true },
  ]);
  assert.equal((await f.query('SELECT count(*)::int AS n FROM plot_installments WHERE plot_id=401 AND amount=200000')).rows[0].n, 1);
  assert.equal((await request(getDrawShopBooking)).data.booking_id, bookingId);
  assert.equal((await submit()).status, 409);
  assert.equal((await request(updateBooking, { id: bookingId, body: { plot_id: 402 } })).data.code, 'DRAW_SHOP_RECEIPTS_LINKED');
  assert.equal((await request(deleteBooking, { id: bookingId })).data.code, 'DRAW_SHOP_RECEIPTS_LINKED');
  assert.equal((await f.query('SELECT count(*)::int AS n FROM plot_payments')).rows[0].n, 2);
  const { rows: [event] } = await f.query("SELECT detail, actor_user_id FROM draw_events WHERE event_type='ALLOTTED'");
  assert.equal(event.actor_user_id, admin.id);
  assert.equal(event.detail.previous_status, 'SLIP_ISSUED');
});

test('a buyer can book two shops on separate slips that share verified KYC', async t => {
  const f = await fixture(t);
  await collect(f.db);
  await f.db.exec(`
    ALTER TABLE kyc_cases ADD COLUMN reused_from_case_id integer REFERENCES kyc_cases(id);
    DELETE FROM website_booking_requests WHERE plot_id=403;
    INSERT INTO documents(kyc_case_id,client_member_id,site_id,type,file_path,ocr_status)
      VALUES(211,201,7,'PHOTO','test/verified-photo','DONE');
    INSERT INTO ocr_results(document_id,extracted_fields)
      SELECT id,'{"fixture":true}'::jsonb FROM documents WHERE kyc_case_id=211;
    INSERT INTO draw_registrations(id,site_id,client_member_id,registration_no,qr_token,required_amount,status,
      slip_no,kyc_case_id,broker_member_id,draw_opening_date,workflow_version)
      VALUES(303,7,201,'DR-303','test-303',100000,'SLIP_ISSUED','SLIP-303',211,202,'2099-01-01',1);
    INSERT INTO draw_payments(draw_registration_id,receipt_no,amount,payment_date,payment_from,created_by)
      VALUES(303,'CASH-26',100000,'2026-11-08','CASH',2);
  `);
  const first = await submit();
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const options = await request(getDrawShopBooking, { id: 303 });
  assert.equal(options.data.reason, null);
  assert.deepEqual(options.data.shops.map(p => p.id), [403]);
  const secondRequest = { id: 303, body: { ...review, plot_id: 403, receipt_version: options.data.receipt_version } };
  const second = await request(createDrawShopBooking, secondRequest);
  assert.equal(second.status, 201, JSON.stringify(second.data));
  assert.notEqual(first.data.booking_id, second.data.booking_id);
  const { rows: cases } = await f.query(`SELECT r.id AS slip,r.allotted_plot_id AS plot,
      k.booking_id,k.status,k.reused_from_case_id,b.booking_agent_id,d.file_path,o.extracted_fields
    FROM draw_registrations r JOIN kyc_cases k ON k.id=r.kyc_case_id
    JOIN bookings b ON b.id=r.booking_id JOIN documents d ON d.kyc_case_id=k.id
    JOIN ocr_results o ON o.document_id=d.id WHERE r.id IN (301,303) ORDER BY r.id`);
  assert.deepEqual(cases, [
    { slip: 301, plot: 401, booking_id: first.data.booking_id, status: 'VERIFIED', reused_from_case_id: null,
      booking_agent_id: 202, file_path: 'test/verified-photo', extracted_fields: { fixture: true } },
    { slip: 303, plot: 403, booking_id: second.data.booking_id, status: 'VERIFIED', reused_from_case_id: 211,
      booking_agent_id: 202, file_path: 'test/verified-photo', extracted_fields: { fixture: true } },
  ]);
  const { rows: credits } = await f.query(`SELECT d.receipt_no,p.plot_id FROM draw_payments d
    JOIN plot_payments p ON p.id=d.plot_payment_id ORDER BY d.id`);
  assert.deepEqual(credits, [
    { receipt_no: 'CASH-25', plot_id: 401 }, { receipt_no: 'BANK-45', plot_id: 401 }, { receipt_no: 'CASH-26', plot_id: 403 },
  ]);
  assert.equal((await request(createDrawShopBooking, secondRequest)).status, 409);
});

test('the active Draws register reports Accounts shops and distinguishes receipts on separate slips', async t => {
  const f = await fixture(t);
  await collect(f.db);
  await f.db.exec(`
    UPDATE plots SET status='BOOKED',buyer_member_id=201 WHERE id IN (401,402,403,404);
    UPDATE plots SET buyer_member_id=204 WHERE id=402;
    UPDATE plots SET plot_tag='OLD' WHERE id=403;
    UPDATE plots SET buyer_member_id=202,buyer_name='Shop Applicant' WHERE id=405;
    INSERT INTO members(id,site_id,member_type,status,full_name) VALUES(204,7,'CLIENT','ACTIVE','Unlinked Applicant');
    INSERT INTO draw_registrations(id,site_id,client_member_id,registration_no,qr_token,required_amount,status)
      VALUES(303,7,201,'DR-303','test-303',100000,'SLIP_ISSUED'),
        (304,7,204,'DR-304','test-304',100000,'SLIP_ISSUED'),
        (305,7,204,'DR-305','test-305',100000,'ALLOTTED'),
        (306,7,201,'DR-306','test-306',100000,'CANCELLED');
    INSERT INTO plot_payments(id,plot_id,site_id,amount) VALUES(501,401,7,50000);
    UPDATE draw_payments SET plot_payment_id=501 WHERE draw_registration_id=301 AND receipt_no='CASH-25';
  `);
  const register = await request(listDraws, { query: { site_id: site, view: 'active' } });
  assert.equal(register.status, 200, JSON.stringify(register.data));
  const linked = register.data.find(row => row.id === draw);
  const otherSlip = register.data.find(row => row.id === 303);
  assert.deepEqual(linked.accounts_booked_shops, [{ plot_no: 'G-14', block: null, receipt_linked: true }]);
  assert.deepEqual(otherSlip.accounts_booked_shops, [{ plot_no: 'G-14', block: null, receipt_linked: false }]);
  assert.equal(linked.status, 'SLIP_ISSUED');
  assert.equal(otherSlip.allotted_plot_id, null);

  const allottedQuery = { site_id: site, view: 'active', status: 'ALLOTTED' };
  const allotted = await request(listDraws, { query: allottedQuery });
  assert.equal(allotted.status, 200, JSON.stringify(allotted.data));
  assert.deepEqual(allotted.data.map(row => row.id).sort((a, b) => a - b), [301, 305]);
  assert.deepEqual(register.data.find(row => row.id === 304).accounts_booked_shops,
    [{ plot_no: 'G-15', block: null, receipt_linked: false }]);
  const searched = await request(listDraws, { query: { ...allottedQuery, q: 'DR-303' } });
  assert.deepEqual(searched.data, []);
  const otherOrganization = await request(listDraws, { query: allottedQuery, user: { ...admin, organization_id: 2 } });
  assert.deepEqual(otherOrganization.data.map(row => row.id), [305]);
  await f.db.exec("UPDATE plots SET approval_status='rejected' WHERE id=401");
  const afterRejection = await request(listDraws, { query: allottedQuery });
  assert.deepEqual(afterRejection.data.map(row => row.id), [305]);
});

test('Book Shop allows a sub-admin with Draws update access in their assigned project', async t => {
  const f = await fixture(t);
  await collect(f.db);
  const user = { id: 2, role: 'sub_admin', organization_id: 1, grants: { booking_draws: [true, false, true, false] } };
  assert.equal((await request(getDrawShopBooking, { user })).status, 403);
  assert.equal((await request(createDrawShopBooking, { user, body: review })).status, 403);

  await f.db.exec("UPDATE users SET role='sub_admin' WHERE id=2; INSERT INTO user_sites(user_id, site_id) VALUES (2,7)");
  const readOnly = { ...user, grants: { booking_draws: [true, false, false, false] } };
  assert.equal((await request(getDrawShopBooking, { user: readOnly })).status, 403);
  assert.equal((await request(createDrawShopBooking, { user: readOnly, body: review })).status, 403);
  const register = await request(listDraws, { user, query: { site_id: site, view: 'active' } });
  assert.equal(register.data.find(row => row.id === draw).direct_shop_booking_enabled, true);
  const options = await request(getDrawShopBooking, { user });
  assert.equal(options.status, 200);
  assert.deepEqual(options.data.shops.map(row => row.id), [shop]);
  const booking = await request(createDrawShopBooking, {
    user, body: { ...review, receipt_version: options.data.receipt_version },
  });
  assert.equal(booking.status, 201, JSON.stringify(booking.data));
  const { rows: [saved] } = await f.query('SELECT allotted_by FROM draw_registrations WHERE id=$1', [draw]);
  assert.equal(saved.allotted_by, user.id);
});

test('a verified Naya Baazar winner allots an approved shop directly', { skip: !existsSync(accountsMigration) }, async t => {
  const f = await fixture(t);
  const { migrationSql } = await import(new URL('./258_direct_plot_status.js', accountsMigration));
  await f.db.exec(`
    ALTER TABLE plots ADD COLUMN approved_by integer, ADD COLUMN approved_at timestamptz,
      ADD COLUMN approval_requested_by integer, ADD COLUMN approval_requested_at timestamptz,
      ADD COLUMN assigned_admin_id integer, ADD COLUMN created_by integer;
    ${migrationSql}
    CREATE TRIGGER plot_approval BEFORE INSERT OR UPDATE ON plots FOR EACH ROW EXECUTE FUNCTION queue_plot_status_approval();
    DELETE FROM plot_installments WHERE plot_id=401;
    UPDATE draw_registrations SET status='WINNER',is_winner=true,draw_opening_date='2020-01-01',
      broker_member_id=NULL,broker_code='BRK-00202' WHERE id=301;
  `);
  await collect(f.db);
  const result = await request(allotShop, { body: { plot_id: shop, sale_price: 900000 } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.status, 'ALLOTTED');
  const { rows: [saved] } = await f.query('SELECT status,approval_status,buyer_member_id,booking_by,sale_price::int FROM plots WHERE id=$1', [shop]);
  assert.deepEqual(saved, { status: 'BOOKED', approval_status: 'approved', buyer_member_id: 201, booking_by: 'DRAW BROKER', sale_price: 900000 });
  const { rows: [booking] } = await f.query('SELECT booking_agent_id,booked_by,created_by FROM bookings WHERE id=$1', [result.data.booking_id]);
  assert.deepEqual(booking, { booking_agent_id: 202, booked_by: 'Draw Broker', created_by: admin.id });
  assert.deepEqual((await f.query('SELECT DISTINCT booked_by FROM plot_payments WHERE plot_id=$1', [shop])).rows, [{ booked_by: 'DRAW BROKER' }]);
});

test('Accounts keeps original receipt entries, rejects unusable receipts, and lets staff clear a booked cheque manually',
  { skip: !existsSync(accountsMigration) && 'Shared integration test requires the Accounts backend checkout' }, async t => {
    const f = await fixture(t);
    const { poolMoneySql } = await import(accountsMigration);
    const { migrationSql: directBookingSql } = await import(new URL('./258_direct_plot_status.js', accountsMigration));
    const { postingPolicySql, approvalGuardSql } = await import(new URL('./171_cheque_clearance_before_approval.js', accountsMigration));
    const { updateChequeStatusRecord } = await import(new URL('../services/chequeStatus.service.js', accountsMigration));
    await f.db.exec(`
      ALTER TABLE plots ADD COLUMN approved_by integer, ADD COLUMN approved_at timestamptz, ADD COLUMN approval_requested_by integer,
        ADD COLUMN approval_requested_at timestamptz, ADD COLUMN assigned_admin_id integer, ADD COLUMN created_by integer;
      CREATE TABLE cash_flow_months(id integer PRIMARY KEY,is_locked boolean DEFAULT false);
      INSERT INTO cash_flow_months VALUES(1,false);
      CREATE TABLE plot_installment_payments(id serial PRIMARY KEY,plot_id integer,installment_id integer,created_by integer,
        amount numeric,status text,payment_mode text,cheque_status text);
      CREATE FUNCTION ensure_site_cashflow_month(integer,date,integer) RETURNS integer LANGUAGE sql AS 'SELECT 1';
      ALTER TABLE cash_flow_entries ADD COLUMN cash_flow_month_id integer, ADD COLUMN date date, ADD COLUMN particular text,
        ADD COLUMN debit numeric, ADD COLUMN credit numeric, ADD COLUMN cash_type text, ADD COLUMN remarks text, ADD COLUMN status text,
        ADD COLUMN created_by integer, ADD COLUMN created_at timestamptz, ADD COLUMN cheque_no text, ADD COLUMN cheque_status text,
        ADD COLUMN approved_by integer, ADD COLUMN approved_at timestamptz, ADD COLUMN assigned_admin_id integer,
        ADD COLUMN cheque_transaction_date date;
      CREATE OR REPLACE FUNCTION test_plot_payment_mirror() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO cash_flow_entries(site_id,source_module,source_id,credit,debit,status,particular)
          VALUES(NEW.site_id,'plot_payments',NEW.id,NEW.amount,0,NEW.status,'Shop payment'); RETURN NEW; END $$;
      ${poolMoneySql}
      CREATE TRIGGER pool_capture AFTER INSERT OR UPDATE OR DELETE ON draw_payments FOR EACH ROW EXECUTE FUNCTION capture_pool_money_source();
      CREATE TRIGGER pool_capture AFTER INSERT OR UPDATE OR DELETE ON bookings FOR EACH ROW EXECUTE FUNCTION capture_pool_money_source();
      ${directBookingSql}
      ${postingPolicySql};
      ${approvalGuardSql};
      CREATE TRIGGER plot_approval BEFORE INSERT OR UPDATE ON plots FOR EACH ROW EXECUTE FUNCTION queue_plot_status_approval();
      CREATE TRIGGER cheque_approval BEFORE INSERT OR UPDATE ON plot_payments FOR EACH ROW EXECUTE FUNCTION enforce_cheque_clearance_approval();
    `);
    await collect(f.db, 25000);
    await f.db.exec(`INSERT INTO draw_payments(draw_registration_id,receipt_no,amount,payment_date,payment_from,
      received_by,bank_name,bank_account_id,cheque_no,created_by) VALUES
      (301,'CHEQUE-51',25000,'2026-11-07','CHEQUE','Collector','DRAW BANK',71,'000051',2)`);
    await f.db.exec("INSERT INTO pool_money_results(source_kind,owner_id,site_id,result,note,recorded_by) VALUES('draw',301,7,'NOT_SELECTED','Recorded decision',1)");
    assert.match((await submit()).data.message, /marked as not selected/);
    await f.db.exec("DELETE FROM pool_money_results; UPDATE cash_flow_entries SET status='rejected' WHERE cash_type='bank'");
    assert.match((await submit()).data.message, /BANK-45.*rejected/i);
    await assertUnbooked(f);
    await f.db.exec("UPDATE cash_flow_entries SET status='approved',approved_by=1,approved_at='2026-11-17' WHERE cash_type='bank'");
    for (const status of ['BOUNCED', 'RETURNED']) {
      await f.query("UPDATE cash_flow_entries SET cheque_status=$1 WHERE cash_type='cheque'", [status]);
      assert.match((await submit()).data.message, /CHEQUE-51.*ineligible cheque/i);
      await assertUnbooked(f);
    }
    await f.db.exec("UPDATE cash_flow_entries SET cheque_status='PENDING' WHERE cash_type='cheque'");
    const original = (await f.query('SELECT id,bank_account_id,status,approved_by,approved_at,credit,cash_type,cheque_status FROM cash_flow_entries ORDER BY id')).rows;
    const result = await submit();
    assert.equal(result.status, 201, JSON.stringify(result.data));
    assert.equal((await f.query('SELECT approval_status FROM plots WHERE id=401')).rows[0].approval_status, 'approved');
    const { rows } = await f.query(`SELECT c.id,c.bank_account_id,c.status,c.approved_by,c.approved_at,c.credit,c.cash_type,c.cheque_status
      FROM pool_money_receipts r JOIN plot_payments p ON p.id=r.plot_payment_id JOIN cash_flow_entries c
      ON c.source_module='plot_payments' AND c.source_id=p.id WHERE p.plot_id=401 AND p.status=c.status
      AND p.approved_at IS NOT DISTINCT FROM c.approved_at AND p.approved_by IS NOT DISTINCT FROM c.approved_by
      AND p.cheque_status IS NOT DISTINCT FROM c.cheque_status ORDER BY c.id`);
    assert.deepEqual(rows, original);
    assert.deepEqual((await f.query('SELECT count(*)::int AS n,sum(credit)::int AS amount FROM cash_flow_entries')).rows[0], { n: 3, amount: 100000 });

    // Exercise the main Accounts Plot Payments detail query against the same isolated database.
    const { default: accountsPool } = await import(new URL('../config/db.js', accountsMigration));
    const { getPlotPaymentDetail } = await import(new URL('../graphql/services/plotPayments.service.js', accountsMigration));
    t.mock.method(accountsPool, 'query', f.query);
    const detail = await getPlotPaymentDetail(shop, site);
    assert.equal(detail.plot.buyer_member_id, review.client_member_id);
    assert.equal(detail.plot.status, 'BOOKED');
    assert.deepEqual([detail.plot.total_received, detail.plot.received_cash, detail.plot.received_bank].map(Number), [75000, 50000, 25000]);
    const cheque = detail.payments.find(p => p.payment_from === 'CHEQUE');
    assert.deepEqual([cheque.status, cheque.cheque_status, cheque.created_by_name], ['pending', 'PENDING', 'Test Agent']);
    await assert.rejects(f.query("UPDATE plot_payments SET status='approved' WHERE id=$1", [cheque.id]), /clear the cheque before approving/i);
    await updateChequeStatusRecord(f, { source: 'plot_payment', entryId: cheque.id, status: 'CLEARED', expectedSiteId: site, requirePending: true });
    assert.equal(Number((await getPlotPaymentDetail(shop, site)).plot.total_received), 75000);
    await f.query("UPDATE plot_payments SET status='approved',approved_by=1,approved_at=now() WHERE id=$1", [cheque.id]);
    assert.equal(Number((await getPlotPaymentDetail(shop, site)).plot.total_received), 100000);
  });
