import test from 'node:test';
import assert from 'node:assert/strict';
import { drawFixture } from '../test/drawFixture.mjs';
import { createBooking, getBookingDrawCredits } from './booking.controller.js';
import { createDraw, setDrawSettings, addDrawPayment } from './draw.controller.js';
import { listPlotPayments } from './plotPayments.controller.js';
import { todayIST } from '../services/drawWorkflow.js';
import { migrateWebsiteBookings } from '../migrations/028_website_bookings.js';

const admin = { id:1, role:'admin', email:'admin@example.test' };
const call = (handler, { body = {}, params = {}, query = {}, user = admin } = {}) => new Promise(resolve => {
  const res = { code:200, status(code) { this.code=code; return this; }, json(data) { resolve({ status:this.code, data }); } };
  handler({ body, params, query, user }, res, error => resolve({ status:error.status || 500, data:{ message:error.message } }));
});

test('new-booking draw credits preserve receipts, enforce ownership and transfer atomically once', async t => {
  const f = await drawFixture();
  try {
    await migrateWebsiteBookings(f.pool);
    await call(setDrawSettings, { body:{ site_id:1, required_amount:5000, wait_days:10 } });
    const created = await call(createDraw, { body:{ site_id:1, full_name:'Credit customer', phone:'9888877777' } });
    assert.equal(created.status,201,JSON.stringify(created.data));
    const drawId = created.data.id;
    const memberId = created.data.client_member_id;
    for (const [amount,mode,ref] of [[2000,'CASH',''],[3000,'UPI','UTR-ORIGINAL-001']]) {
      const result = await call(addDrawPayment, { params:{id:drawId}, body:{ amount,payment_from:mode,bank_name:'Original Bank',bank_details:ref,payment_date:todayIST() } });
      assert.equal(result.status,201,JSON.stringify(result.data));
    }
    const lookup = overrides => call(getBookingDrawCredits, { query:{ site_id:1, client_member_id:memberId, ...overrides } });
    await t.test('lookup shows pending draw receipts but does not allow premature credit', async () => {
      const r = await lookup();
      assert.equal(r.status,200); assert.equal(r.data[0].total_paid,5000);
      assert.equal(r.data[0].payments.length,2); assert.equal(r.data[0].eligible,false);
      assert.match(r.data[0].reason,/physical draw/);
      assert.deepEqual((await lookup({ site_id:2 })).data,[]);
      assert.deepEqual((await lookup({ client_member_id:9999 })).data,[]);
      assert.equal((await call(getBookingDrawCredits,{user:{id:2,role:'agent'},query:{site_id:1,client_member_id:memberId}})).status,403);
    });
    // Current Accounting policy requires a complete full-price schedule with a
    // 25% booking installment; the original fixture predated this validation.
    const bookingDay=todayIST();
    const nextDue=new Date(Date.parse(`${bookingDay}T12:00:00Z`)+30*86400000).toISOString().slice(0,10);
    const payload = { site_id:1,client_member_id:memberId,draw_registration_id:drawId,plot_id:1,sale_price:1000000,payment_plan:'INSTALLMENT',first_installment_amount:250000,
      installments:[{installment_name:'Booking installment',amount:250000,due_date:bookingDay},{installment_name:'Remaining balance',amount:750000,due_date:nextDue}],
      token_amount:2500,token_payment_from:'UPI',token_bank_details:'UTR-NEW-002',token_payment_date:bookingDay,expected_draw_credit_amount:5000 };
    assert.equal((await call(createBooking,{body:payload})).status,400);
    await f.query("UPDATE draw_registrations SET status='WINNER', is_winner=true, draw_opening_date=$1, slip_no='TEST-SLIP-1' WHERE id=$2",[todayIST(),drawId]);
    assert.equal((await call(createBooking,{body:payload})).status,409); // KYC still required
    await f.query("UPDATE kyc_cases SET status='VERIFIED' WHERE client_member_id=$1",[memberId]);
    assert.equal((await lookup()).data[0].eligible,true);

    await t.test('cross-customer, cross-project and stale totals cannot claim a receipt',async () => {
      for (const override of [{client_member_id:memberId+1},{site_id:2},{expected_draw_credit_amount:4999}]) assert.equal((await call(createBooking,{body:{...payload,...override}})).status,409);
      assert.equal((await f.query('SELECT count(*)::int AS n FROM bookings')).rows[0].n,0);
    });
    await t.test('an active website hold blocks draw allotment and preserves every original receipt',async()=>{
      await f.query(`INSERT INTO website_booking_requests(site_id,plot_id,plot_number,request_token_hash,idempotency_key_hash,payload_hash,buyer_name,buyer_phone,buyer_email,buyer_address,terms_snapshot,amount_paise,hold_expires_at,gateway_receipt,status)
        VALUES(1,1,'A-1',$1,$2,$3,'Website customer','9876543210','website@example.test','Isolated test address','Isolated test terms',100000,now()+interval '15 minutes','WB-draw-guard-fixture','AWAITING_PAYMENT')`,['a'.repeat(64),'b'.repeat(64),'c'.repeat(64)]);
      const blocked=await call(createBooking,{body:payload});
      assert.equal(blocked.status,409,JSON.stringify(blocked.data));
      assert.match(blocked.data.message,/website booking request/i);
      assert.equal((await f.query('SELECT count(*)::int AS n FROM bookings')).rows[0].n,0);
      assert.equal((await f.query('SELECT count(*)::int AS n FROM plot_payments')).rows[0].n,0);
      assert.equal((await f.query('SELECT count(*)::int AS n FROM draw_payments WHERE plot_payment_id IS NOT NULL')).rows[0].n,0);
      await f.query("UPDATE website_booking_requests SET status='EXPIRED',hold_expires_at=now()-interval '1 minute' WHERE gateway_receipt='WB-draw-guard-fixture'");
    });
    await t.test('a failure while collecting additional money rolls back the booking and every draw mirror',async () => {
      await f.query('ALTER TABLE plot_payments ADD CONSTRAINT reject_new_money CHECK (amount <> 2500)');
      const failed = await call(createBooking,{body:payload});
      assert.equal(failed.status,409,JSON.stringify(failed.data));
      assert.equal((await f.query('SELECT count(*)::int AS n FROM bookings')).rows[0].n,0);
      assert.equal((await f.query('SELECT count(*)::int AS n FROM plot_payments')).rows[0].n,0);
      assert.equal((await f.query('SELECT count(*)::int AS n FROM draw_payments WHERE plot_payment_id IS NOT NULL')).rows[0].n,0);
      assert.equal((await f.query('SELECT status FROM plots WHERE id=1')).rows[0].status,'AVAILABLE');
      await f.query('ALTER TABLE plot_payments DROP CONSTRAINT reject_new_money');
    });
    await t.test('first installment receives original draw money plus only the new collection',async () => {
      const result = await call(createBooking,{body:payload});
      assert.equal(result.status,201,JSON.stringify(result.data));
      assert.equal(Number(result.data.token_amount),2500);
      assert.equal(Number(result.data.first_installment_amount),250000);
      assert.equal(result.data.draw_credit_amount,5000);
      const ledger = (await f.query('SELECT * FROM plot_payments ORDER BY id')).rows;
      assert.equal(ledger.length,3);
      assert.equal(ledger.reduce((n,p)=>n+Number(p.amount),0),7500);
      assert.equal(ledger[1].bank_details,'UTR-ORIGINAL-001');
      assert.equal(ledger[1].payment_from,'UPI');
      assert.equal(ledger[1].bank_name,'ORIGINAL BANK');
      assert.equal(ledger[2].bank_details,'UTR-NEW-002');
      const credits = (await lookup()).data;
      assert.equal(credits[0].booking_id,result.data.id);
      assert.equal(credits[0].eligible,false);
      assert.ok(credits[0].payments.every(p=>p.plot_payment_id));
      assert.equal((await call(createBooking,{body:payload})).status,409);
      assert.equal((await f.query('SELECT count(*)::int AS n FROM plot_payments')).rows[0].n,3);
      assert.equal((await f.query('SELECT count(*)::int AS n FROM bookings')).rows[0].n,1);
      await f.query("UPDATE plot_payments SET status='rejected' WHERE amount=2000");
      const updatedLedger = await call(listPlotPayments, { query: { plot_id:1 } });
      assert.equal(updatedLedger.status,200,JSON.stringify(updatedLedger.data));
      assert.equal(Number(updatedLedger.data.plot.total_received),5500);
    });
  } finally { await f.close(); }
});
