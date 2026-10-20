import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { migrateWebsiteBookings } from '../migrations/028_website_bookings.js';
import { createWebsiteBookingService, normalizeWebsitePlotNumber, validateWebsiteBuyer } from './websiteBookings.js';
import { verifyCheckoutSignature, verifyWebhookSignature } from './websiteRazorpay.js';
import { websiteRateLimit } from '../routes/websiteBooking.routes.js';
import bookingModel from '../models/Booking.model.js';
import { syncTokenPayment } from './tokenPaymentSync.js';
import { configureOmWebsiteToken } from '../scripts/configure_website_token.js';

const buyer = (number='A-1',key='test_request_key_0001') => ({plot_number:number,buyer_name:'Test Buyer',buyer_phone:'9876543210',buyer_email:'buyer@example.test',buyer_address:'Test address Shamli',terms_accepted:true,idempotency_key:key});
const admin={id:1,role:'admin'};

async function fixture() {
  const engine=new PGlite();
  // PGlite exposes one connection. Queue transactions/pool queries independently,
  // retaining the production BEGIN/COMMIT boundaries for real PostgreSQL semantics.
  let tail=Promise.resolve();
  async function acquire() { let release;const next=new Promise(resolve=>{release=resolve;});const prior=tail;tail=next;await prior;return release; }
  const query=async(sql,params)=>{
    if (sql.includes('pg_advisory_xact_lock')) return {rows:[{}]};
    return engine.query(sql,params);
  };
  const db={
    async connect(){const release=await acquire();return{query,release};},
    async query(sql,params){const release=await acquire();try{return await query(sql,params);}finally{release();}},
  };
  await engine.exec(`
    CREATE TABLE sites(id INTEGER PRIMARY KEY,name TEXT);
    CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT,role TEXT,is_active BOOLEAN DEFAULT true);
    CREATE TABLE plots(id SERIAL PRIMARY KEY,site_id INTEGER REFERENCES sites,plot_no TEXT,block TEXT,plot_size NUMERIC,sale_price NUMERIC,status TEXT,buyer_name TEXT,booking_by TEXT,booking_date DATE,updated_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE members(id SERIAL PRIMARY KEY,site_id INTEGER REFERENCES sites,member_type TEXT,member_types TEXT[],status TEXT,full_name TEXT,phone TEXT,email TEXT,address TEXT,notes TEXT,created_by INTEGER REFERENCES users);
    CREATE TABLE bookings(id SERIAL PRIMARY KEY,site_id INTEGER REFERENCES sites,plot_id INTEGER REFERENCES plots,client_member_id INTEGER REFERENCES members,sale_price NUMERIC,token_amount NUMERIC,payment_plan TEXT,status TEXT,kyc_status TEXT,buyer_name TEXT,booked_by TEXT,notes TEXT,created_by INTEGER REFERENCES users,booking_no TEXT UNIQUE,token_payment_from TEXT,token_payment_date DATE,token_bank_details TEXT,token_narration TEXT,token_received_by TEXT,token_payment_id INTEGER,updated_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE kyc_cases(id SERIAL PRIMARY KEY,booking_id INTEGER REFERENCES bookings,client_member_id INTEGER REFERENCES members,site_id INTEGER REFERENCES sites,mode TEXT,status TEXT,created_by INTEGER REFERENCES users,updated_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE plot_payments(id SERIAL PRIMARY KEY,plot_id INTEGER REFERENCES plots,site_id INTEGER REFERENCES sites,date DATE,payment_from TEXT,payment_type TEXT,bank_details TEXT,narration TEXT,received_by TEXT,amount NUMERIC,created_by INTEGER REFERENCES users,status TEXT,buyer_name TEXT,booked_by TEXT);
    INSERT INTO sites VALUES(5,'OM ASSOCIATES'),(6,'Other Site');
    INSERT INTO users VALUES(1,'Test Admin','admin',true),(2,'Test Agent','agent',true),(3,'Sub Admin','sub_admin',true),(4,'Inactive Admin','admin',false);
    INSERT INTO plots(site_id,plot_no,block,plot_size,sale_price,status) VALUES
      (5,'A01','A',100,1500000,'Company'),(5,'A02','A',100,1500000,'Company'),
      (5,'A03','A',100,1500000,'Booked'),(5,'A04','A',100,1500000,'Registry'),
      (5,'A05','A',100,1500000,'Company'),(5,'A06','A',100,1500000,'Resale'),
      (5,'S03','S',25,400000,'Company'),(5,'H1','H',25,400000,'Company'),
      (6,'A01','A',100,1500000,'Company');
  `);
  await migrateWebsiteBookings(db);
  await migrateWebsiteBookings(db); // rerunnable, no inventory writes
  const orders=new Map(),payments=new Map();
  let orderCalls=0;
  const gateway={keyId:'rzp_test_fixture',secret:'fixture_secret_only',ready:true,
    async createOrder(data){const order={...data,id:`order_Test${++orderCalls}`,status:'created'};orders.set(order.id,order);return order;},
    async fetchOrder(id){assert.ok(orders.has(id),'fixture order exists');return {...orders.get(id)};},
    async fetchPayment(id){assert.ok(payments.has(id),'fixture payment exists');return {...payments.get(id)};},
    async fetchOrderPayments(id){return {items:[...payments.values()].filter(payment=>payment.order_id===id)};},
  };
  const service=createWebsiteBookingService({db,gateway,siteId:5,tokenSecret:'stable_fixture_token_secret'});
  const enable=()=>service.saveSettings(admin,{site_id:5,booking_enabled:true,status_display_enabled:true,booking_amount:1000,hold_minutes:15,terms:'Company booking terms used for the isolated integration tests.'});
  function capture(order,{id=`pay_Test${order.order.id.slice(10)}`,amount=order.order.amount,currency='INR',status='captured',captured=true,amount_refunded=0}={}) {
    const payment={id,order_id:order.order.id,amount,currency,status,captured,amount_refunded,method:'upi'};
    payments.set(id,payment);
    return {request_token:order.request_token,razorpay_order_id:order.order.id,razorpay_payment_id:id,razorpay_signature:createHmac('sha256',gateway.secret).update(`${order.order.id}|${id}`).digest('hex')};
  }
  return {engine,db,service,gateway,orders,payments,enable,capture,orderCalls:()=>orderCalls,close:()=>engine.close()};
}

test('canonical numbers preserve map identity; buyer validation rejects untrusted details',()=>{
  assert.equal(normalizeWebsitePlotNumber(' A 001 '),'A-1');
  assert.equal(normalizeWebsitePlotNumber('S03'),'S3');
  assert.equal(normalizeWebsitePlotNumber('004','B'),'B-4');
  assert.equal(normalizeWebsitePlotNumber('H1'),null);
  assert.throws(()=>validateWebsiteBuyer({...buyer(),terms_accepted:false}),/Accept/);
  assert.throws(()=>validateWebsiteBuyer({...buyer(),plot_number:'A-44'}),/layout/);
  assert.throws(()=>validateWebsiteBuyer({...buyer(),buyer_phone:'1234567890'}),/mobile/);
  assert.equal(validateWebsiteBuyer({...buyer(),buyer_phone:'+91 9876543210'}).buyer_phone,'9876543210');
});

test('HMAC checks require saved order id and exact original webhook bytes',()=>{
  const signature=createHmac('sha256','secret').update('order_Test|pay_Test').digest('hex');
  assert.equal(verifyCheckoutSignature('order_Test','pay_Test',signature,'secret'),true);
  assert.equal(verifyCheckoutSignature('order_Other','pay_Test',signature,'secret'),false);
  assert.equal(verifyCheckoutSignature('order_Test','pay_Test','a','secret'),false);
  const raw=Buffer.from('{"event":"payment.captured"}');
  const signed=createHmac('sha256','secret').update(raw).digest('hex');
  assert.equal(verifyWebhookSignature(raw,signed,'secret'),true);
  assert.equal(verifyWebhookSignature(Buffer.from('{ "event":"payment.captured" }'),signed,'secret'),false);
});

test('₹101 setup enables only OM ASSOCIATES and preserves prior orders and customer terms',async()=>{
  const f=await fixture();try{
    await assert.rejects(configureOmWebsiteToken(f.db,{siteId:6,paymentReady:true}),/must be 5/);
    await assert.rejects(configureOmWebsiteToken(f.db,{siteId:5,paymentReady:false}),/credentials/);
    await configureOmWebsiteToken(f.db,{siteId:5,paymentReady:true});
    assert.equal((await f.service.config()).booking_amount,101);
    assert.equal((await f.service.config()).booking_enabled,true);
    await f.enable();
    const prior=await f.service.createOrder(buyer());
    const settings=await f.service.config();
    await configureOmWebsiteToken(f.db,{siteId:5,paymentReady:true});
    const config=await f.service.config();
    assert.equal(config.terms,settings.terms);
    assert.equal(config.hold_minutes,settings.hold_minutes);
    const order=await f.service.createOrder({...buyer('A-2','new_token_request_101'),amount:1});
    assert.equal(order.order.amount,10100);
    assert.equal(order.order.currency,'INR');
    assert.equal((await f.service.requestStatus(prior.request_token)).order.amount,100000);
    assert.equal((await f.db.query('SELECT count(*) AS count FROM website_booking_settings WHERE site_id=6')).rows[0].count,0);
    await f.db.query("UPDATE sites SET name='Another Company' WHERE id=5");
    await assert.rejects(configureOmWebsiteToken(f.db,{siteId:5,paymentReady:true}),/not OM ASSOCIATES/);
  }finally{await f.close();}
});

test('missing checkout fields return 400 and never mark a request paid',async()=>{
  const f=await fixture();try{
    await f.enable();
    const order=await f.service.createOrder(buyer());
    const body=f.capture(order);
    for (const field of ['request_token','razorpay_order_id','razorpay_payment_id','razorpay_signature']) {
      const missing={...body};delete missing[field];
      await assert.rejects(f.service.verifyPayment(missing),{status:400,code:'PAYMENT_FIELDS_REQUIRED'});
    }
    await assert.rejects(f.service.verifyPayment(null),{status:400,code:'PAYMENT_FIELDS_REQUIRED'});
    await assert.rejects(f.service.verifyPayment({...body,razorpay_signature:'0'.repeat(64)}),{status:400,code:'PAYMENT_SIGNATURE_INVALID'});
    assert.equal((await f.service.requestStatus(order.request_token)).payment_verified,false);
    await f.db.query('UPDATE website_booking_settings SET booking_amount=0.5 WHERE site_id=5');
    await assert.rejects(f.service.createOrder(buyer('A-2','below_minimum_request')),{status:400,code:'INVALID_ORDER_AMOUNT'});
    assert.equal(f.orderCalls(),1);
  }finally{await f.close();}
});

test('disabled by default, real status only, no buyer PII, duplicates fail closed',async()=>{
  const f=await fixture();try{
    assert.equal((await f.service.config()).booking_enabled,false);
    await assert.rejects(f.service.createOrder(buyer()),{code:'BOOKING_DISABLED'});
    await f.enable();
    let data=await f.service.plots();
    assert.equal(data.plots.length,200);
    assert.equal(data.plots.find(plot=>plot.number==='A-1').status,'COMPANY');
    assert.equal(data.plots.find(plot=>plot.number==='A-3').status,'BOOKED');
    assert.equal(data.plots.find(plot=>plot.number==='A-4').status,'REGISTRY');
    assert.equal(data.plots.find(plot=>plot.number==='A-6').bookable,false);
    assert.equal(data.plots.find(plot=>plot.number==='S3').mapped,true);
    assert.equal(data.plots.some(plot=>plot.number==='H1'),false);
    assert.equal(JSON.stringify(data).includes('buyer_name'),false);
    await f.db.query("INSERT INTO plots(site_id,plot_no,block,status) VALUES(5,'A-1','A','Registry')");
    data=await f.service.plots();
    assert.equal(data.plots.find(plot=>plot.number==='A-1').status,'UNKNOWN');
    assert.equal(data.plots.find(plot=>plot.number==='A-1').bookable,false);
    await assert.rejects(f.service.createOrder(buyer()),{code:'PLOT_MAPPING_CONFLICT'});
    assert.deepEqual((await f.service.getSettings(admin,5)).mapping_conflicts,[{number:'A-1',count:2}]);
    await f.service.saveSettings(admin,{site_id:5,booking_enabled:false,status_display_enabled:false,booking_amount:1000,hold_minutes:15,terms:'Booking terms hidden live status test.'});
    data=await f.service.plots();
    assert.ok(data.plots.every(plot=>plot.status==='UNKNOWN' && !plot.bookable && !plot.held));
  }finally{await f.close();}
});

test('current ownership displays through resale history while duplicate checkout stays blocked',async()=>{
  const f=await fixture();try{
    await f.enable();
    await f.db.query("INSERT INTO plots(site_id,plot_no,block,status) VALUES(5,'A03','A','RESALE'),(5,'A04','A','RESALE')");
    let data=await f.service.plots();
    for(const [number,status] of [['A-3','BOOKED'],['A-4','REGISTRY']]) {
      const plot=data.plots.find(plot=>plot.number===number);
      assert.equal(plot.status,status);
      assert.equal(plot.mapping_conflict,true);
      assert.equal(plot.bookable,false);
      await assert.rejects(f.service.createOrder(buyer(number)),{code:'PLOT_MAPPING_CONFLICT'});
    }
    await f.db.query("INSERT INTO plots(site_id,plot_no,block,status) VALUES(5,'A04','A','BOOKED')");
    data=await f.service.plots();
    assert.equal(data.plots.find(plot=>plot.number==='A-4').status,'UNKNOWN','two current ownership rows remain ambiguous');
  }finally{await f.close();}
});

test('active bookings immediately display booked before ledger sync, cancellation and registry remain authoritative',async()=>{
  const f=await fixture();try{
    await f.enable();
    await f.db.query("INSERT INTO bookings(site_id,plot_id,status) VALUES(5,1,'CONFIRMED'),(5,4,'KYC_PENDING'),(6,2,'CONFIRMED')");
    let data=await f.service.plots();
    assert.equal(data.plots.find(plot=>plot.number==='A-1').status,'BOOKED');
    assert.equal(data.plots.find(plot=>plot.number==='A-1').bookable,false);
    assert.equal(data.plots.find(plot=>plot.number==='A-4').status,'REGISTRY');
    assert.equal(data.plots.find(plot=>plot.number==='A-2').status,'COMPANY','other project bookings cannot change this project');
    await f.db.query("UPDATE bookings SET status='CANCELLED' WHERE plot_id=1");
    data=await f.service.plots();
    assert.equal(data.plots.find(plot=>plot.number==='A-1').status,'COMPANY');
    assert.equal(data.plots.find(plot=>plot.number==='A-1').bookable,true);
  }finally{await f.close();}
});

test('management guards current database role, validates settings and cannot use another site publicly',async()=>{
  const f=await fixture();try{
    for(const id of [2,3,4])await assert.rejects(f.service.getSettings({id,role:'admin'},5),{status:403});
    await assert.rejects(f.service.saveSettings(admin,{site_id:5,booking_enabled:true,status_display_enabled:true,booking_amount:0,hold_minutes:15,terms:'Valid test terms long enough.'}),/at least/);
    await assert.rejects(f.service.saveSettings(admin,{site_id:5,booking_enabled:false,status_display_enabled:true,booking_amount:1.001,hold_minutes:15,terms:'Valid test terms long enough.'}),/decimals/);
    await f.enable();
    const order=await f.service.createOrder({...buyer(),site_id:6,amount:1});
    assert.equal(order.order.amount,100000);
    const row=(await f.db.query('SELECT site_id,terms_snapshot FROM website_booking_requests')).rows[0];
    assert.equal(row.site_id,5);
    assert.match(row.terms_snapshot,/Company/);
    await f.db.query("UPDATE users SET role='agent' WHERE id=1");
    await assert.rejects(f.service.listRequests(admin,5),{status:403});
  }finally{await f.close();}
});

test('two simultaneous orders reserve one plot; same request retries reuse one gateway order',async()=>{
  const f=await fixture();try{
    await f.enable();
    const outcomes=await Promise.allSettled([f.service.createOrder(buyer()),f.service.createOrder(buyer('A-1','other_request_key_02'))]);
    assert.equal(outcomes.filter(outcome=>outcome.status==='fulfilled').length,1);
    assert.equal(outcomes.find(outcome=>outcome.status==='rejected').reason.code,'PLOT_HELD');
    assert.equal(f.orderCalls(),1);
    const order=outcomes.find(outcome=>outcome.status==='fulfilled').value;
    const retry=await f.service.createOrder(buyer());
    assert.equal(retry.order.id,order.order.id);
    assert.equal(retry.request_token,order.request_token);
    assert.equal(f.orderCalls(),1);
    await assert.rejects(f.service.createOrder({...buyer(),buyer_email:'changed@example.test'}),{code:'IDEMPOTENCY_CONFLICT'});
    const status=await f.service.requestStatus(order.request_token);
    assert.deepEqual(status.order,order.order);
    assert.equal(JSON.stringify(status).includes('buyer@example'),false);
    await assert.rejects(f.service.requestStatus('a'.repeat(64)),{status:404});
  }finally{await f.close();}
});

test('signature, exact amount, currency and captured status protect verification; replay is idempotent',async()=>{
  const f=await fixture();try{
    await f.enable();const order=await f.service.createOrder(buyer());
    let body=f.capture(order,{amount:1});
    await assert.rejects(f.service.verifyPayment({...body,razorpay_signature:'a'.repeat(64)}),{code:'PAYMENT_SIGNATURE_INVALID'});
    await assert.rejects(f.service.verifyPayment(body),{code:'PAYMENT_MISMATCH'});
    body=f.capture(order,{currency:'USD'});await assert.rejects(f.service.verifyPayment(body),{code:'PAYMENT_MISMATCH'});
    body=f.capture(order,{status:'authorized',captured:false});await assert.rejects(f.service.verifyPayment(body),{code:'PAYMENT_NOT_CAPTURED'});
    body=f.capture(order);const result=await f.service.verifyPayment(body);
    assert.equal(result.status,'PAYMENT_REVIEW');
    await f.service.verifyPayment(body);
    assert.equal((await f.db.query('SELECT count(*)::int AS count FROM website_booking_events WHERE event_type=\'PAYMENT_VERIFIED\'')).rows[0].count,1);
    assert.equal((await f.db.query('SELECT status FROM plots WHERE id=1')).rows[0].status,'Company');
    await assert.rejects(f.service.approve({id:2,role:'admin'},order.request_id),{status:403});
  }finally{await f.close();}
});

test('approval creates member, KYC booking and shared BANK payment atomically once; refund is rechecked',async()=>{
  const f=await fixture();try{
    await f.enable();const order=await f.service.createOrder(buyer());const body=f.capture(order);
    await f.service.verifyPayment(body);
    f.payments.get(body.razorpay_payment_id).amount_refunded=100;
    await assert.rejects(f.service.approve(admin,order.request_id,'Checked'),{code:'PAYMENT_REFUNDED'});
    f.payments.get(body.razorpay_payment_id).amount_refunded=0;
    const outcomes=await Promise.all([f.service.approve(admin,order.request_id,'Verified with Razorpay'),f.service.approve(admin,order.request_id,'Retry')]);
    assert.equal(outcomes[0].booking_id,outcomes[1].booking_id);
    assert.equal((await f.db.query('SELECT count(*)::int AS count FROM bookings')).rows[0].count,1);
    assert.equal((await f.db.query('SELECT count(*)::int AS count FROM members')).rows[0].count,1);
    const pay=(await f.db.query('SELECT * FROM plot_payments')).rows[0];
    assert.equal(pay.amount,'1000');assert.equal(pay.payment_type,'BANK');assert.equal(pay.payment_from,'RAZORPAY');assert.equal(pay.status,'pending');
    const booking=(await f.db.query('SELECT * FROM bookings')).rows[0];
    assert.equal(booking.status,'KYC_PENDING');assert.equal(booking.token_payment_id,pay.id);
    assert.equal((await f.db.query('SELECT status FROM plots WHERE id=1')).rows[0].status,'BOOKED');
    assert.equal((await f.service.requestStatus(order.request_token)).booking_no,booking.booking_no);
    await assert.rejects(f.service.reject(admin,order.request_id,'reject approved'),{code:'REQUEST_CLOSED'});
  }finally{await f.close();}
});

test('late captured payment cannot steal a new reservation; rejection preserves refund obligation',async()=>{
  const f=await fixture();try{
    await f.enable();const first=await f.service.createOrder(buyer());
    await f.db.query("UPDATE website_booking_requests SET hold_expires_at=now()-interval '1 minute' WHERE id=$1",[first.request_id]);
    const second=await f.service.createOrder(buyer('A-1','second_request_key_2'));
    const body=f.capture(first);
    const status=await f.service.verifyPayment(body);assert.equal(status.status,'PAYMENT_CONFLICT');assert.equal(status.refund_required,true);
    await assert.rejects(f.service.approve(admin,first.request_id),{code:'REQUEST_NOT_READY'});
    const rejected=await f.service.reject(admin,first.request_id,'Late payment; plot already held');assert.equal(rejected.refund_required,true);
    assert.equal((await f.service.requestStatus(second.request_token)).status,'AWAITING_PAYMENT');
    assert.equal((await f.db.query('SELECT count(*)::int AS count FROM plot_payments')).rows[0].count,0);
  }finally{await f.close();}
});

test('callback loss recovers through opaque token; webhook duplicates cannot create bookings',async()=>{
  const f=await fixture();try{
    await f.enable();const order=await f.service.createOrder(buyer());const body=f.capture(order);
    assert.equal((await f.service.reconcilePublic(order.request_token)).status,'PAYMENT_REVIEW');
    const payload={event:'payment.captured',payload:{payment:{entity:f.payments.get(body.razorpay_payment_id)}}};
    assert.equal((await f.service.processWebhook(payload,'event_fixture_1')).received,true);
    assert.equal((await f.service.processWebhook(payload,'event_fixture_1')).duplicate,true);
    assert.equal((await f.db.query('SELECT count(*)::int AS count FROM bookings')).rows[0].count,0);
    await f.service.reject(admin,order.request_id,'Customer requested cancellation');
    f.payments.get(body.razorpay_payment_id).amount_refunded=order.order.amount;
    await f.service.processWebhook({event:'refund.processed',payload:{refund:{entity:{payment_id:body.razorpay_payment_id}}}},'event_refund_1');
    assert.equal((await f.service.requestStatus(order.request_token)).refund_required,false);
  }finally{await f.close();}
});

test('gateway timeout never creates a second remote order for a retry; staff can recover by receipt',async()=>{
  const f=await fixture();try{
    await f.enable();const original=f.gateway.createOrder;
    f.gateway.createOrder=async(data)=>{await original(data);throw Object.assign(new Error('Timeout'),{uncertain:true,status:503});};
    await assert.rejects(f.service.createOrder(buyer()),/Timeout/);
    await assert.rejects(f.service.createOrder(buyer()),{code:'ORDER_PREPARING'});
    assert.equal(f.orderCalls(),1);
    const row=(await f.db.query('SELECT * FROM website_booking_requests')).rows[0];
    const remote=[...f.orders.values()][0];
    f.payments.set('pay_Recovery',{id:'pay_Recovery',order_id:remote.id,amount:remote.amount,currency:'INR',status:'captured',captured:true,amount_refunded:0});
    await f.service.reconcile(admin,row.id,{razorpay_order_id:remote.id});
    assert.equal((await f.db.query('SELECT status FROM website_booking_requests')).rows[0].status,'PAYMENT_REVIEW');
  }finally{await f.close();}
});

test('invalid gateway order response retains the reservation for recovery',async()=>{
  const f=await fixture();try{
    await f.enable();
    const original=f.gateway.createOrder;
    f.gateway.createOrder=async data=>({...await original(data),amount:1});
    await assert.rejects(f.service.createOrder(buyer()),{status:500,code:'GATEWAY_ORDER_MISMATCH'});
    assert.equal((await f.db.query('SELECT status FROM website_booking_requests')).rows[0].status,'ORDER_CREATING');
    await assert.rejects(f.service.createOrder(buyer()),{code:'ORDER_PREPARING'});
    assert.equal(f.orderCalls(),1);
  }finally{await f.close();}
});

test('rate limiter rejects excess requests and resets its bounded window',()=>{
  let time=0;const limit=websiteRateLimit({limit:2,windowMs:1000,clock:()=>time});let next=0,status=0;
  const res={set(){},status(value){status=value;return this;},json(){}};
  const req={ip:'127.0.0.1'};
  for(let i=0;i<3;i++)limit(req,res,()=>next++);
  assert.equal(next,2);assert.equal(status,429);time=1001;limit(req,res,()=>next++);assert.equal(next,3);
});

test('manual and draw model creation cannot bypass website hold; duplicate mapping after payment blocks approval',async()=>{
  const f=await fixture();try{
    await f.enable();const order=await f.service.createOrder(buyer());
    await assert.rejects(bookingModel.create({site_id:5,plot_id:1,status:'KYC_PENDING'},f.db),{code:'WEBSITE_PLOT_HELD'});
    assert.equal((await f.db.query('SELECT count(*)::int AS count FROM bookings')).rows[0].count,0);
    await f.service.verifyPayment(f.capture(order));
    await f.db.query("INSERT INTO plots(site_id,plot_no,status) VALUES(5,'A-1','Registry')");
    await assert.rejects(f.service.approve(admin,order.request_id),{code:'PLOT_MAPPING_CONFLICT'});
  }finally{await f.close();}
});

test('captured receipt remains immutable and survives booking cancellation',async()=>{
  const f=await fixture();try{
    await f.enable();const order=await f.service.createOrder(buyer());await f.service.verifyPayment(f.capture(order));
    const approved=await f.service.approve(admin,order.request_id);
    assert.equal((await f.db.query('SELECT count(*)::int AS count FROM kyc_cases')).rows[0].count,1);
    await assert.rejects(bookingModel.update(approved.booking_id,{token_amount:0},f.db),{code:'WEBSITE_PAYMENT_LOCKED'});
    await assert.rejects(bookingModel.update(approved.booking_id,{plot_id:2},f.db),{code:'WEBSITE_PAYMENT_LOCKED'});
    await assert.rejects(bookingModel.create({site_id:5,plot_id:1,status:'KYC_PENDING'},f.db),{code:'PLOT_ALREADY_BOOKED'});
    const canceled=await bookingModel.update(approved.booking_id,{status:'CANCELLED'},f.db);
    const sync=await syncTokenPayment(canceled,f.db);assert.equal(sync.skipped,'website_payment_locked');
    assert.equal((await f.db.query('SELECT count(*)::int AS count FROM plot_payments')).rows[0].count,1);
    assert.equal((await f.service.requestStatus(order.request_token)).status,'CANCELLED');
    assert.equal((await f.service.requestStatus(order.request_token)).refund_required,true);
  }finally{await f.close();}
});

test('a refund recorded after gateway fetch but before approval lock blocks posting',async()=>{
  const f=await fixture();try{
    await f.enable();const order=await f.service.createOrder(buyer());const body=f.capture(order);await f.service.verifyPayment(body);
    const fetchPayment=f.gateway.fetchPayment;
    f.gateway.fetchPayment=async(id)=>{
      const snapshot=await fetchPayment(id);
      await f.db.query('UPDATE website_booking_requests SET amount_refunded_paise=100 WHERE id=$1',[order.request_id]);
      return snapshot;
    };
    await assert.rejects(f.service.approve(admin,order.request_id),{code:'PAYMENT_REFUNDED'});
    assert.equal((await f.db.query('SELECT count(*)::int AS count FROM bookings')).rows[0].count,0);
  }finally{await f.close();}
});

test('reactivating a canceled manual booking without plot_id cannot bypass website reservation',async()=>{
  const f=await fixture();try{
    await f.enable();await f.db.query("INSERT INTO bookings(site_id,plot_id,status) VALUES(5,1,'CANCELLED')");
    await f.service.createOrder(buyer());
    await assert.rejects(bookingModel.update(1,{status:'KYC_PENDING'},f.db),{code:'WEBSITE_PLOT_HELD'});
    assert.equal((await f.db.query('SELECT status FROM bookings WHERE id=1')).rows[0].status,'CANCELLED');
    await assert.rejects(bookingModel.update(1,{status:'PAID'},f.db),{code:'BOOKING_STATUS_INVALID'});
  }finally{await f.close();}
});

test('a different payment attempt refund cannot overwrite the linked receipt refund state',async()=>{
  const f=await fixture();try{
    await f.enable();const order=await f.service.createOrder(buyer());const body=f.capture(order);await f.service.verifyPayment(body);
    f.payments.set('pay_OtherAttempt',{...f.payments.get(body.razorpay_payment_id),id:'pay_OtherAttempt',amount_refunded:100});
    await assert.rejects(f.service.processWebhook({event:'refund.processed',payload:{refund:{entity:{payment_id:'pay_OtherAttempt'}}}},'event_bad_refund'),{code:'PAYMENT_MISMATCH'});
    assert.equal(Number((await f.db.query('SELECT amount_refunded_paise FROM website_booking_requests')).rows[0].amount_refunded_paise),0);
  }finally{await f.close();}
});
