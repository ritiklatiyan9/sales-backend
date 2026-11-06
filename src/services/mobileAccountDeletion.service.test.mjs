import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { createMobileAccountDeletion } from './mobileAccountDeletion.service.js';
import { createMobileAccountDeletionRouter } from '../routes/mobileAccountDeletion.routes.js';

async function database(t) {
  const raw = new PGlite();
  t.after(() => raw.close());
  await raw.exec(`
    CREATE TABLE members(id integer PRIMARY KEY, full_name text);
    CREATE TABLE booking_client_accounts(id integer PRIMARY KEY, phone text);
    CREATE TABLE booking_client_members(account_id integer REFERENCES booking_client_accounts ON DELETE CASCADE, member_id integer REFERENCES members);
    CREATE TABLE booking_client_invitations(id integer PRIMARY KEY, member_id integer REFERENCES members, code_hash text);
    CREATE TABLE booking_mobile_push_events(id integer PRIMARY KEY, account_id integer);
    CREATE TABLE booking_mobile_push_devices(token_hash text PRIMARY KEY, account_id integer REFERENCES booking_client_accounts ON DELETE CASCADE);
    CREATE TABLE booking_mobile_push_deliveries(event_id integer REFERENCES booking_mobile_push_events ON DELETE CASCADE, token_hash text REFERENCES booking_mobile_push_devices ON DELETE CASCADE);
    CREATE TABLE plots(id integer PRIMARY KEY, buyer_member_id integer REFERENCES members);
    CREATE TABLE plot_payments(id integer PRIMARY KEY, plot_id integer REFERENCES plots, amount integer);
    INSERT INTO members VALUES (10, 'Asha'), (11, 'Asha'), (20, 'Ravi');
    INSERT INTO booking_client_accounts VALUES (1,'9876543210'), (2,'9876543211');
    INSERT INTO booking_client_members VALUES (1,10), (1,11), (2,20);
    INSERT INTO booking_client_invitations VALUES (1,10,'a'), (2,11,'b'), (3,20,'c');
    INSERT INTO booking_mobile_push_events VALUES (1,1), (2,2), (3,NULL);
    INSERT INTO booking_mobile_push_devices VALUES ('device1',1), ('device2',2);
    INSERT INTO booking_mobile_push_deliveries VALUES (1,'device1'), (3,'device1'), (2,'device2');
    INSERT INTO plots VALUES (101,10); INSERT INTO plot_payments VALUES (1,101,100);
  `);
  return { raw, query: (...args) => raw.query(...args), connect: async () => ({ query:(...args)=>raw.query(...args), release:()=>{} }) };
}

test('deletion validates links, fails closed, cleans related data and leaves ledger intact', async t => {
  const db=await database(t);
  const service=createMobileAccountDeletion(db, {secureEnrollmentEnabled:()=>true});
  const preview=await service.lookup(10);
  assert.deepEqual(preview, {accountId:1,phoneLast4:'3210',members:[{id:10,name:'Asha'},{id:11,name:'Asha'}],sharedClientPortalLogin:true});
  const body={accountId:1,memberId:10,expectedMemberIds:[10,11],confirmation:'DELETE APP ACCOUNT'};
  await assert.rejects(createMobileAccountDeletion(db).remove(body), {statusCode:503});
  await assert.rejects(service.remove({...body,expectedMemberIds:[10]}), {statusCode:409});
  await assert.rejects(service.remove({...body,confirmation:'yes'}), {statusCode:400});
  assert.equal((await db.raw.query('SELECT count(*)::int AS n FROM booking_client_accounts')).rows[0].n,2);
  assert.deepEqual(await service.remove(body),{ok:true});
  for (const table of ['booking_client_accounts','booking_client_members','booking_client_invitations','booking_mobile_push_devices']) {
    assert.equal((await db.raw.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,1,table);
  }
  assert.equal((await db.raw.query('SELECT count(*)::int AS n FROM booking_mobile_push_events')).rows[0].n,2);
  assert.equal((await db.raw.query('SELECT count(*)::int AS n FROM booking_mobile_push_deliveries')).rows[0].n,1);
  assert.equal((await db.raw.query('SELECT count(*)::int AS n FROM plot_payments')).rows[0].n,1);
  assert.equal((await db.raw.query('SELECT count(*)::int AS n FROM members')).rows[0].n,3);
});

test('account deletion routes restrict both inspection and mutation to super admins', async () => {
  let role='admin'; let calls=0;
  const service={lookup:async()=>{calls++;return {accountId:1};},remove:async()=>{calls++;return {ok:true};}};
  const router=createMobileAccountDeletionRouter({authenticate:(req,_res,next)=>{req.user={role};next();},service});
  const invoke=(method,url,body={})=>new Promise((resolve,reject)=>{
    const req={method,url,body,headers:{}};
    const res={statusCode:200,set(){return this;},status(n){this.statusCode=n;return this;},json(payload){resolve({status:this.statusCode,body:payload});}};
    router.handle(req,res,e=>reject(e||new Error('unmatched')));
  });
  assert.equal((await invoke('GET','/members/10')).status,403);
  assert.equal((await invoke('POST','/delete')).status,403);
  assert.equal(calls,0);
  role='super_admin';
  assert.equal((await invoke('GET','/members/10')).status,200);
  assert.equal((await invoke('POST','/delete')).status,200);
  assert.equal(calls,2);
});

test('cleanup failure rolls back the entire account deletion', async t => {
  const db=await database(t);
  const failingDb={...db,connect:async()=>({
    query:(sql,...args)=>sql.startsWith('DELETE FROM booking_client_accounts')
      ? Promise.reject(new Error('simulated failure')) : db.raw.query(sql,...args),
    release:()=>{},
  })};
  const service=createMobileAccountDeletion(failingDb,{secureEnrollmentEnabled:()=>true});
  await assert.rejects(service.remove({accountId:1,memberId:10,expectedMemberIds:[10,11],confirmation:'DELETE APP ACCOUNT'}));
  assert.equal((await db.raw.query('SELECT count(*)::int AS n FROM booking_client_accounts')).rows[0].n,2);
  assert.equal((await db.raw.query('SELECT count(*)::int AS n FROM booking_client_invitations')).rows[0].n,3);
  assert.equal((await db.raw.query('SELECT count(*)::int AS n FROM booking_mobile_push_events')).rows[0].n,3);
});
