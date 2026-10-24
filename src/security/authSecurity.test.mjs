import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

// Tests use isolated signing keys and never query the configured database.
process.env.JWT_ACCESS_SECRET = 'isolated-booking-access-key-for-security-tests';
process.env.JWT_REFRESH_SECRET = 'isolated-booking-refresh-key-for-security-tests';
const { currentStaffSession } = await import('../services/staffSession.js');
const { verifyLoginOtp } = await import('../controllers/auth.controller.js');
const { default: pool } = await import('../config/db.js');
const { default: userModel } = await import('../models/User.model.js');
const { signAccessToken } = await import('../config/jwt.js');

const user={id:2,email:'test@example.test',role:'admin',token_version:1,is_active:true};
test('sessions use the current database role, reject revoked/inactive accounts and disallow unexpected signing algorithms', async () => {
  const token=signAccessToken({id:2,version:1,role:'super_admin'});
  assert.equal((await currentStaffSession(token,{query:async()=>({rows:[user]})})).role,'admin');
  for(const row of [{...user,is_active:false},{...user,can_login_booking:false},{...user,token_version:2},{...user,role:'client'}]) await assert.rejects(currentStaffSession(token,{query:async()=>({rows:[row]})}));
  const wrongAlgorithm=jwt.sign({id:2,version:1},process.env.JWT_ACCESS_SECRET,{algorithm:'HS384',expiresIn:'5m'});
  await assert.rejects(currentStaffSession(wrongAlgorithm,{query:async()=>({rows:[user]})}));
});
test('sessions carry a per-request booking grants snapshot that hasPermission reads with unchanged semantics', async () => {
  const { hasPermission } = await import('../services/permissions.service.js');
  const db = new PGlite();
  const savedQuery = pool.query;
  try {
    await db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, role TEXT, token_version INTEGER, is_active BOOLEAN, can_login_booking BOOLEAN);
      CREATE TABLE user_permissions (user_id INTEGER, module TEXT, can_read BOOLEAN, can_write BOOLEAN, can_update BOOLEAN, can_delete BOOLEAN, UNIQUE (user_id, module));
      INSERT INTO users VALUES (2, 'sub@example.test', 'sub_admin', 1, true, true), (3, 'new@example.test', 'sub_admin', 1, true, true);
      INSERT INTO user_permissions VALUES (2, 'booking_clients', true, false, NULL, true), (2, 'bookingXclients', false, false, false, false), (2, 'accounts_ledger', false, false, false, false);`);
    let queries = 0;
    const session = token => currentStaffSession(token, { query: (sql, values) => { queries += 1; return db.query(sql, values); } });
    const sub = await session(signAccessToken({ id: 2, version: 1, role: 'sub_admin' }));
    assert.equal(queries, 1, 'grants load with the session row');
    assert.deepEqual(sub.grants, { booking_clients: [true, false, null, true] }, 'only booking_* rows; the underscore is literal');
    assert.deepEqual((await session(signAccessToken({ id: 3, version: 1, role: 'sub_admin' }))).grants, {}, 'no rows = empty snapshot, never null');
    pool.query = async () => assert.fail('a snapshot answers booking_* checks without a query');
    assert.equal(await hasPermission(sub, 'booking_clients', 'can_read'), true);
    assert.equal(await hasPermission(sub, 'booking_clients', 'can_write'), false);
    assert.equal(await hasPermission(sub, 'booking_clients', 'can_update'), true, 'NULL is not a denial');
    assert.equal(await hasPermission(sub, 'booking_members', 'can_delete'), true, 'missing row = allowed');
    assert.equal(await hasPermission({ id: 1, role: 'admin', grants: { booking_clients: [false, false, false, false] } }, 'booking_clients', 'can_read'), true, 'full admins bypass');
    await assert.rejects(hasPermission(sub, 'booking_clients', 'can_approve'), /Unknown permission flag/);
    // Without a snapshot (sockets, fake users) and for non-booking keys the stored row is queried.
    pool.query = (sql, values) => db.query(sql, values);
    assert.equal(await hasPermission({ id: 2, role: 'sub_admin' }, 'booking_clients', 'can_write'), false);
    assert.equal(await hasPermission(sub, 'accounts_ledger', 'can_read'), false);
    // A schema without the shared permissions table still authenticates; grants are then absent.
    const bare = new PGlite();
    try {
      await bare.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, role TEXT, token_version INTEGER, is_active BOOLEAN, can_login_booking BOOLEAN); INSERT INTO users VALUES (2, 'sub@example.test', 'sub_admin', 1, true, true)");
      const fallback = await currentStaffSession(signAccessToken({ id: 2, version: 1, role: 'sub_admin' }), bare);
      assert.equal(fallback.role, 'sub_admin'); assert.equal('grants' in fallback, false);
    } finally { await bare.close(); }
    await assert.rejects(currentStaffSession(signAccessToken({ id: 2, version: 1 }), { query: async () => { throw Object.assign(new Error('down'), { code: 'ECONNRESET' }); } }), { code: 'ECONNRESET' });
  } finally { pool.query = savedQuery; await db.close(); }
});
test('GET /auth/me carries exactly the GET /admin/my-permissions payload', async () => {
  const { getMe } = await import('../controllers/auth.controller.js');
  const { getMyPermissions } = await import('../controllers/admin.controller.js');
  const db = new PGlite();
  const savedQuery = pool.query;
  let queries = 0;
  pool.query = (sql, values) => { queries += 1; return db.query(sql, values); };
  const reply = (handler, user) => new Promise(resolve => handler({ user }, { statusCode: 200, status(code) { this.statusCode = code; return this; },
    json(data) { resolve({ status: this.statusCode, data }); return this; } }, error => resolve({ status: 500, data: { message: error.message } })));
  try {
    await db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT, role TEXT, password TEXT, phone TEXT, token_version INTEGER, is_active BOOLEAN, can_login_booking BOOLEAN);
      CREATE TABLE booking_staff_identities (user_id INTEGER, aadhaar_password_hash TEXT, password_fingerprint TEXT, aadhaar_last4 TEXT);
      CREATE TABLE booking_user_kyc_links (user_id INTEGER, aadhaar_last4 TEXT, kyc_case_id INTEGER, member_id INTEGER, phone TEXT);
      CREATE TABLE members (id INTEGER PRIMARY KEY, member_type TEXT, member_types TEXT[]);
      CREATE TABLE kyc_cases (id INTEGER PRIMARY KEY, client_member_id INTEGER, status TEXT);
      CREATE TABLE sites (id INTEGER PRIMARY KEY, name TEXT, code TEXT, address TEXT, city TEXT, state TEXT);
      CREATE TABLE user_sites (user_id INTEGER, site_id INTEGER);
      CREATE TABLE user_permissions (user_id INTEGER, module TEXT, can_read BOOLEAN, can_write BOOLEAN, can_update BOOLEAN, can_delete BOOLEAN, UNIQUE (user_id, module));
      INSERT INTO users VALUES (2, 'Sales Desk', 'sales@example.test', 'sub_admin', 'hash', NULL, 1, true, true);
      INSERT INTO sites VALUES (7, 'Site Seven', 'S7', NULL, NULL, NULL), (8, 'Site Eight', 'S8', NULL, NULL, NULL);
      INSERT INTO user_sites VALUES (2, 7);
      INSERT INTO user_permissions VALUES (2, 'booking_clients', true, true, true, true), (2, 'booking_item_draws_new', false, false, false, false), (2, 'booking_unlisted_key', false, false, false, false);`);
    const session = await currentStaffSession(signAccessToken({ id: 2, version: 1, role: 'sub_admin' }), db);
    queries = 0;
    const me = await reply(getMe, session);
    assert.equal(me.status, 200, JSON.stringify(me.data));
    assert.equal(queries, 2, 'user + sites in parallel; permissions come from the session snapshot');
    assert.deepEqual(me.data.sites.map(site => site.id), [7]);
    assert.equal(me.data.user.id, 2);
    const expected = { is_admin: false, permissions: {
      booking_clients: { can_read: true, can_write: true, can_update: true, can_delete: true },
      booking_item_draws_new: { can_read: false, can_write: false, can_update: false, can_delete: false } } };
    assert.deepEqual(me.data.module_permissions, expected);
    assert.deepEqual((await reply(getMyPermissions, session)).data, expected, 'snapshot path');
    assert.deepEqual((await reply(getMyPermissions, { id: 2, role: 'sub_admin' })).data, expected, 'query path');
    assert.equal((await reply(getMe, { id: 9, role: 'sub_admin', grants: {} })).status, 404);
  } finally { pool.query = savedQuery; await db.close(); }
});
const call = body => new Promise(resolve => {
  const res={statusCode:200,status(value){this.statusCode=value;return this;},json(data){resolve({status:this.statusCode,data});}};
  verifyLoginOtp({body},res,error=>resolve({status:error.status||500,data:{message:error.message}}));
});
test('OTP parallel guesses are capped and a correct code can only mint one session', async () => {
  const db=new PGlite();
  const original={query:pool.query,find:userModel.findById,save:userModel.setRefreshToken};
  let reservations=0,issued=0;
  pool.query=async(sql,values)=>{const result=await db.query(sql,values);if(sql.includes('attempts=attempts+1')&&result.rows.length)reservations++;return result;};
  userModel.findById=async()=>user;
  userModel.setRefreshToken=async()=>{issued++;};
  try {
    await db.exec('CREATE TABLE login_otps (id SERIAL PRIMARY KEY,user_id INTEGER,pending_token TEXT,otp_hash TEXT,attempts INTEGER DEFAULT 0,expires_at TIMESTAMPTZ,consumed_at TIMESTAMPTZ,last_sent_at TIMESTAMPTZ DEFAULT now())');
    const pending='a'.repeat(48),hash=await bcrypt.hash('123456',4);
    const add=()=>db.query("INSERT INTO login_otps(user_id,pending_token,otp_hash,expires_at) VALUES(2,$1,$2,now()+interval '5 minutes')",[pending,hash]);
    await add();
    const wrong=await Promise.all(Array.from({length:12},()=>call({pending_token:pending,otp:'654321'})));
    assert.ok(wrong.every(result=>result.status===401));assert.ok(reservations<=5);assert.equal(issued,0);
    await db.exec('TRUNCATE login_otps');await add();
    const correct=await Promise.all([call({pending_token:pending,otp:'123456'}),call({pending_token:pending,otp:'123456'})]);
    assert.equal(correct.filter(result=>result.status===200).length,1);
    assert.equal(correct.filter(result=>result.status===401).length,1);assert.equal(issued,1);
    assert.equal((await call({pending_token:pending,otp:'123456'})).status,401);
  } finally {pool.query=original.query;userModel.findById=original.find;userModel.setRefreshToken=original.save;await db.close();}
});

test('session middleware distinguishes database outages from rejected credentials and denies both requests', async () => {
  const { default: authMiddleware } = await import('../middlewares/auth.middleware.js');
  const savedQuery = pool.query;
  const token = signAccessToken({ id: 2, version: 1, role: 'admin' });
  async function request(bearer = token) {
    const output = { status: 200, headers: {}, next: false };
    const res = { set(name,value){ output.headers[name]=value;return this; },status(value){output.status=value;return this;},json(body){output.body=body;return this;} };
    await authMiddleware({ header: () => `Bearer ${bearer}` }, res, () => { output.next=true; });
    return output;
  }
  try {
    for (const code of ['ECONNRESET', '57P01', '53300']) {
      pool.query = async () => { throw Object.assign(new Error('Private database detail'), { code }); };
      const unavailable = await request();
      assert.equal(unavailable.status,503); assert.equal(unavailable.next,false);
      assert.equal(unavailable.body.code,'AUTH_SERVICE_UNAVAILABLE'); assert.equal(unavailable.headers['Retry-After'],'3');
      assert.doesNotMatch(JSON.stringify(unavailable.body),/Private database detail/);
    }
    pool.query=async()=>{assert.fail('Invalid signatures must be rejected before looking up users');};
    assert.equal((await request('invalid-token')).status,401);
    pool.query=async()=>({rows:[{...user,token_version:2}]});
    assert.equal((await request()).status,401);
    pool.query=async()=>({rows:[user]});
    assert.equal((await request()).next,true);
    // Routers mounted after the '/' lookups router re-run authMiddleware: no second lookup.
    pool.query=async()=>{assert.fail('An authenticated request is not looked up twice');};
    let passed=false;
    await authMiddleware({ user:{ id:2, role:'admin' }, header:()=>assert.fail('No second token check') }, {}, ()=>{ passed=true; });
    assert.equal(passed,true);
  } finally { pool.query=savedQuery; }
});
