import test from 'node:test';
import assert from 'node:assert/strict';
import { drawFixture } from '../test/drawFixture.mjs';
import { migrateFormStudioAttendance } from '../migrations/025_form_studio_attendance.js';
import { deleteDraw } from './draw.controller.js';

const admin={id:1,role:'admin'};
const call=(id,{user=admin,withPayments=false}={})=>new Promise(resolve=>{
  const res={statusCode:200,status(code){this.statusCode=code;return this;},json(data){resolve({status:this.statusCode,data});}};
  deleteDraw({user,params:{id},query:withPayments?{with_payments:'true'}:{}},res,error=>resolve({status:error.status||500,data:{message:error.message}}));
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
  } finally {await fixture.close();}
});
