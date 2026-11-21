import test from 'node:test';
import assert from 'node:assert/strict';
import { drawFixture } from '../test/drawFixture.mjs';
import { migrateFormStudioAttendance } from '../migrations/025_form_studio_attendance.js';
import { deleteDraw, deleteDrawPayment, updateDraw, updateDrawPayment } from './draw.controller.js';

const admin={id:1,role:'admin'};
const call=(id,{user=admin,withPayments=false}={})=>new Promise(resolve=>{
  const res={statusCode:200,status(code){this.statusCode=code;return this;},json(data){resolve({status:this.statusCode,data});}};
  deleteDraw({user,params:{id},query:withPayments?{with_payments:'true'}:{}},res,error=>resolve({status:error.status||500,data:{message:error.message}}));
});
const update=(handler,params,body,user=admin)=>new Promise(resolve=>{
  const res={statusCode:200,status(code){this.statusCode=code;return this;},json(data){resolve({status:this.statusCode,data});}};
  handler({user,params,body},res,error=>resolve({status:error.status||500,data:{message:error.message}}));
});

test('collection entry deletion respects site, receipts, issued slips and Accounting on isolated PostgreSQL',async t=>{
  const fixture=await drawFixture();
  try {
    await migrateFormStudioAttendance(fixture.pool);
    await fixture.query('CREATE TABLE IF NOT EXISTS agent_activity_log (actor_user_id INTEGER,target_user_id INTEGER,action TEXT,detail JSONB)');
    const member=(await fixture.query("INSERT INTO members(site_id,member_type,full_name,phone) VALUES(1,'CLIENT','Deletion fixture','9000000123') RETURNING id")).rows[0].id;
    let counter=0;
    async function entry({status='REGISTERED',slip=false,paid=0}={}) {
      const n=++counter;
      const row=(await fixture.query('INSERT INTO draw_registrations(site_id,client_member_id,status,qr_token,registration_no,slip_no,required_amount) VALUES(1,$1,$2,$3,$4,$5,500) RETURNING id',[member,status,`delete-fixture-${n}`,`REG-${n}`,slip?`SLIP-${n}`:null])).rows[0];
      if(paid)await fixture.query('INSERT INTO draw_payments(draw_registration_id,receipt_no,amount) VALUES($1,$2,$3)',[row.id,`RECEIPT-${n}`,paid]);
      return row.id;
    }
    const exists=async id=>(await fixture.query('SELECT count(*)::int AS n FROM draw_registrations WHERE id=$1',[id])).rows[0].n;
    await t.test('blocks an agent and a sub-admin outside the assigned site',async()=>{
      const id=await entry();
      assert.equal((await call(id,{user:{id:2,role:'agent'}})).status,403);
      assert.equal((await call(id,{user:{id:3,role:'sub_admin'}})).status,403);
      assert.equal(await exists(id),1);
      assert.equal((await call(id)).status,200);
      assert.equal(await exists(id),0);
      assert.equal((await fixture.query('SELECT count(*)::int AS n FROM members WHERE id=$1',[member])).rows[0].n,1);
    });
    await t.test('paid entries require explicit receipt deletion and are removed together',async()=>{
      const id=await entry({status:'ELIGIBLE',paid:500});
      assert.equal((await call(id)).status,409);
      assert.equal(await exists(id),1);
      assert.equal((await call(id,{withPayments:true})).status,200);
      assert.equal(await exists(id),0);
      assert.equal((await fixture.query('SELECT count(*)::int AS n FROM draw_payments WHERE draw_registration_id=$1',[id])).rows[0].n,0);
    });
    await t.test('active issued slips and allotted entries remain protected',async()=>{
      for(const settings of [{status:'SLIP_ISSUED',slip:true,paid:500},{status:'ALLOTTED'}]) {
        const id=await entry(settings);
        assert.equal((await call(id,{withPayments:true})).status,409);
        assert.equal(await exists(id),1);
      }
    });
    await t.test('cancelled entries with attendance can be deleted without orphaned attendance events',async()=>{
      const id=await entry({status:'CANCELLED',slip:true,paid:500});
      const attendance=(await fixture.query("INSERT INTO draw_attendance(draw_registration_id,attendance_date,checked_in_by) VALUES($1,CURRENT_DATE,1) RETURNING id",[id])).rows[0].id;
      await fixture.query("INSERT INTO draw_attendance_events(attendance_id,action,actor_id) VALUES($1,'CHECKED_IN',1)",[attendance]);
      assert.equal((await call(id,{withPayments:true})).status,200);
      assert.equal(await exists(id),0);
      assert.equal((await fixture.query('SELECT count(*)::int AS n FROM draw_attendance_events WHERE attendance_id=$1',[attendance])).rows[0].n,0);
    });
    await t.test('a receipt transferred to Accounting cannot be deleted',async()=>{
      const id=await entry({status:'CANCELLED',paid:500});
      const plotPayment=(await fixture.query('INSERT INTO plot_payments(plot_id,site_id,date,amount) VALUES(1,1,CURRENT_DATE,500) RETURNING id')).rows[0].id;
      await fixture.query('UPDATE draw_payments SET plot_payment_id=$1 WHERE draw_registration_id=$2',[plotPayment,id]);
      const result=await call(id,{withPayments:true});
      assert.equal(result.status,409);
      assert.match(result.data.message,/Accounting/);
      assert.equal(await exists(id),1);
      assert.equal((await fixture.query('SELECT count(*)::int AS n FROM draw_payments WHERE draw_registration_id=$1',[id])).rows[0].n,1);
    });
    await t.test('individual receipt deletion updates totals and eligibility and preserves an issued slip', async () => {
      const { rows: [draw] } = await fixture.query(`INSERT INTO draw_registrations
        (site_id,client_member_id,status,qr_token,registration_no,slip_no,required_amount)
        VALUES(1,$1,'SLIP_ISSUED','receipt-deletion-fixture','REG-001','SLIP-001',500.10) RETURNING id`, [member]);
      const { rows: [first, second] } = await fixture.query(`INSERT INTO draw_payments(draw_registration_id,receipt_no,amount)
        VALUES($1,'RECEIPT-001',40.20),($1,'RECEIPT-002',500.10) RETURNING id`, [draw.id]);
      const remove = (paymentId, user = admin) => new Promise(resolve => {
        const res = { statusCode: 200, status(code) { this.statusCode = code; return this; },
          json(data) { resolve({ status: this.statusCode, data }); } };
        deleteDrawPayment({ user, params: { id: draw.id, paymentId } }, res,
          error => resolve({ status: error.status || 500, data: { message: error.message } }));
      });
      assert.equal((await remove(first.id,{id:2,role:'agent'})).status,403);
      assert.equal((await remove(first.id,{id:3,role:'sub_admin'})).status,403);
      assert.match((await remove(second.id)).data.message,/below the minimum for the issued slip/);
      const afterFirst = await remove(first.id);
      assert.equal(afterFirst.status,200);
      assert.equal(afterFirst.data.total_paid,500.10);
      assert.equal(afterFirst.data.slip_no,'SLIP-001');
      assert.deepEqual(afterFirst.data.payments.map(payment => payment.id),[second.id]);
      assert.equal((await remove(first.id)).status,404);

      await fixture.query("UPDATE draw_registrations SET status='ELIGIBLE',slip_no=NULL WHERE id=$1",[draw.id]);
      const afterSecond = await remove(second.id);
      assert.equal(afterSecond.status,200);
      assert.equal(afterSecond.data.status,'REGISTERED');
      assert.equal(afterSecond.data.total_paid,0);
      assert.equal(afterSecond.data.balance_due,500.10);
      assert.equal(afterSecond.data.events.find(event => event.event_type === 'PAYMENT_DELETED').detail.receipt_no,'RECEIPT-001');
    });
    await t.test('assigned sub-admins can edit draw details while required amounts stay restricted',async()=>{
      const id=await entry();
      const sales={id:2,role:'sub_admin'};
      assert.equal((await update(updateDraw,{id},{notes:'outside site'},{id:3,role:'sub_admin'})).status,403);
      assert.equal((await update(updateDraw,{id},{required_amount:1000},sales)).status,403);
      const result=await update(updateDraw,{id},{notes:'Updated registration'},sales);
      assert.equal(result.status,200);
      assert.equal(result.data.notes,'Updated registration');
      assert.equal(Number(result.data.required_amount),500);
    });
    await t.test('receipt edits recompute totals and preserve the receipt number and actor history',async()=>{
      const id=await entry({status:'ELIGIBLE',paid:500});
      const { rows:[payment] }=await fixture.query('SELECT id,receipt_no FROM draw_payments WHERE draw_registration_id=$1',[id]);
      const params={id,paymentId:payment.id};
      const body={amount:245.50,payment_from:'UPI',bank_account_id:1,bank_details:'TRX-245',narration:'Corrected amount'};
      assert.equal((await update(updateDrawPayment,params,body,{id:3,role:'sub_admin'})).status,403);
      assert.equal((await update(updateDrawPayment,params,{...body,bank_account_id:2})).status,409);
      const result=await update(updateDrawPayment,params,body);
      assert.equal(result.status,200);
      assert.equal(result.data.status,'REGISTERED');
      assert.equal(result.data.total_paid,245.50);
      assert.equal(result.data.balance_due,254.50);
      assert.equal(result.data.payments[0].receipt_no,payment.receipt_no);
      assert.equal(result.data.payments[0].bank_name,'ICICI BANK');
      assert.equal(result.data.events.find(event=>event.event_type==='PAYMENT_UPDATED').detail.after.amount,245.50);
      const retry=await update(updateDrawPayment,params,body);
      assert.equal(retry.status,200);
      assert.equal(retry.data.events.filter(event=>event.event_type==='PAYMENT_UPDATED').length,1);
    });
    await t.test('paid registration deletion uses the Accounting bridge and rolls back on a protected receipt',async()=>{
      await fixture.db.exec(`
        CREATE TABLE pool_money_receipts (source_kind text NOT NULL,source_id integer NOT NULL,posted boolean NOT NULL DEFAULT false);
        CREATE FUNCTION test_guard_draw_payment() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF EXISTS(SELECT 1 FROM pool_money_receipts WHERE source_kind='draw' AND source_id=OLD.id) THEN
              RAISE EXCEPTION 'A draw receipt has a live Accounting projection';
            END IF;
            RETURN OLD;
          END $$;
        CREATE TRIGGER test_guard BEFORE DELETE ON draw_payments FOR EACH ROW EXECUTE FUNCTION test_guard_draw_payment();
        CREATE FUNCTION delete_draw_payment_with_accounting(registration_id integer,payment_id integer,actor_id integer) RETURNS boolean LANGUAGE plpgsql AS $$
          BEGIN
            IF EXISTS(SELECT 1 FROM pool_money_receipts WHERE source_kind='draw' AND source_id=payment_id AND posted) THEN
              RAISE EXCEPTION 'This receipt has already been processed in Accounting' USING ERRCODE='23514',CONSTRAINT='draw_payment_delete_conflict';
            END IF;
            DELETE FROM pool_money_receipts WHERE source_kind='draw' AND source_id=payment_id;
            DELETE FROM draw_payments WHERE draw_registration_id=registration_id AND id=payment_id;
            RETURN FOUND;
          END $$;
      `);
      const id=await entry({status:'ELIGIBLE',paid:500});
      await fixture.query("INSERT INTO draw_payments(draw_registration_id,receipt_no,amount) VALUES($1,'ADDITIONAL-PENDING',100)",[id]);
      await fixture.query("INSERT INTO pool_money_receipts(source_kind,source_id,posted) SELECT 'draw',id,receipt_no='ADDITIONAL-PENDING' FROM draw_payments WHERE draw_registration_id=$1",[id]);
      const countLinks=async()=>(await fixture.query('SELECT count(*)::int AS n FROM pool_money_receipts')).rows[0].n;
      assert.equal((await call(id)).status,409);
      const blocked=await call(id,{withPayments:true});
      assert.equal(blocked.status,409);
      assert.match(blocked.data.message,/already been processed/);
      assert.equal(await exists(id),1);
      assert.equal(await countLinks(),2);
      await fixture.query('UPDATE pool_money_receipts SET posted=false');
      assert.equal((await call(id,{withPayments:true})).status,200);
      assert.equal(await exists(id),0);
      assert.equal(await countLinks(),0);
    });
  } finally {await fixture.close();}
});
