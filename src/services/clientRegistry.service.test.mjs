import test from 'node:test';
import assert from 'node:assert/strict';
import { drawFixture } from '../test/drawFixture.mjs';
import { migrateClientRegistry } from '../migrations/030_client_registry.js';
import { normalizeClientIdentity, normalizeClientPhone } from './clientRegistry.service.js';
import { resolvePaymentCollector } from './paymentCollector.js';
import * as controller from '../controllers/booking.controller.js';

const admin = { id: 1, role: 'admin' };
const agent = { id: 2, role: 'agent' };
const stranger = { id: 3, role: 'agent' };
const subAdmin = { id: 4, role: 'sub_admin' };
const call = (handler, { user = admin, body = {}, query = {}, params = {}, file } = {}) => new Promise((resolve) => {
  const res = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(data) { resolve({ status: this.statusCode, data }); } };
  handler({ user, body, query, params, file }, res, (error) => resolve({ status: error.status || 500, data: { message: error.message, code: error.code } }));
});

test('client registry normalizes mobile and validates optional identity fields', () => {
  assert.equal(normalizeClientPhone('+91 98765-43210', { strict: true }), '9876543210');
  assert.equal(normalizeClientPhone('09876543210', { strict: true }), '9876543210');
  assert.throws(() => normalizeClientPhone('12345', { strict: true }), /10-digit/);
  assert.throws(() => normalizeClientPhone('1234567890', { strict: true }), /Indian mobile/);
  assert.throws(() => normalizeClientPhone('nine 9876543210'), /valid mobile/);
  assert.deepEqual(normalizeClientIdentity({ pan_no: 'abcde1234f', aadhar_no: '1234 5678 9012' }), { pan_no: 'ABCDE1234F', aadhar_no: '123456789012' });
  assert.throws(() => normalizeClientIdentity({ pan_no: 'ABCDE12345' }), /PAN/);
  assert.throws(() => normalizeClientIdentity({ aadhar_no: 'letters123456789012' }), /Aadhaar/);
});

test('reusable client registration and bounded site directory on isolated PostgreSQL', async (t) => {
  const fixture = await drawFixture();
  let member;
  try {
    await fixture.db.exec(`
      ALTER TABLE users ADD COLUMN agent_status TEXT DEFAULT 'ACTIVE';
      ALTER TABLE members ADD COLUMN created_at TIMESTAMPTZ DEFAULT now(), ADD COLUMN occupation TEXT, ADD COLUMN gender TEXT, ADD COLUMN date_of_birth DATE;
      CREATE TABLE IF NOT EXISTS user_sites(user_id INTEGER, site_id INTEGER);
      CREATE TABLE user_permissions(user_id INTEGER,module TEXT,can_read BOOLEAN,can_write BOOLEAN,can_update BOOLEAN,can_delete BOOLEAN);
      INSERT INTO users(id,name,email,role,referral_code) VALUES
        (3,'Other Agent','other@example.test','agent','AGT-OTHER'),
        (4,'Site Subadmin','sub@example.test','sub_admin','AGT-SUB');
      UPDATE users SET referral_code='AGT-TEST' WHERE id=2;
      INSERT INTO user_sites VALUES(3,2),(4,1);
      INSERT INTO members(site_id,member_type,full_name,phone) VALUES
        (1,'CLIENT','Legacy One','7777777777'),(1,'CLIENT','Legacy Two','+91 7777777777');
    `);
    await migrateClientRegistry(fixture.pool);
    await migrateClientRegistry(fixture.pool);

    await t.test('migration preserves legacy duplicates and blocks new direct duplicate writes', async () => {
      assert.equal((await fixture.query('SELECT count(*)::int AS n FROM members')).rows[0].n, 2);
      await assert.rejects(fixture.query("INSERT INTO members(site_id,member_type,full_name,phone) VALUES(1,'CLIENT','Duplicate','07777777777')"), (error) => error.code === '23505');
      await fixture.query("UPDATE members SET phone='77777 77777',full_name='Legacy Updated' WHERE id=1");
      await fixture.query("INSERT INTO members(site_id,member_type,full_name,phone) VALUES(2,'CLIENT','Separate Site','7777777777')");
    });

    await t.test('member lookup preserves one canonical code ID across formatted mobiles and site copies', async () => {
      const sameSite = await call(controller.searchClients, { query: { site_id: 1, q: '7777777777' } });
      assert.equal(sameSite.status, 200);
      assert.equal(sameSite.data.length, 2);
      assert.ok(sameSite.data.every(member => member.code_id === 1));
      const otherSite = await call(controller.searchClients, { query: { site_id: 2, q: '7777777777' } });
      assert.equal(otherSite.status, 200);
      assert.equal(otherSite.data[0].code_id, 1);
    });

    await t.test('directory and detail sign private photos without changing stored URLs', async () => {
      const names = ['AWS_S3_BUCKET_NAME', 'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'];
      const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
      const photo = 'https://booking-photos.s3.ap-south-1.amazonaws.com/kyc_documents/avatar.jpg';
      Object.assign(process.env, { AWS_S3_BUCKET_NAME: 'booking-photos', AWS_REGION: 'ap-south-1', AWS_ACCESS_KEY_ID: 'test-key', AWS_SECRET_ACCESS_KEY: 'test-secret' });
      try {
        await fixture.query('UPDATE members SET photo=$1 WHERE id=1', [photo]);
        const search = await call(controller.searchClients, { query: { site_id: 1 } });
        assert.match(search.data.find(row => row.id === 1).photo, /X-Amz-Signature=/);
        const directory = await call(controller.listClients, { query: { site_id: 1 } });
        assert.match(directory.data.items.find(row => row.id === 1).photo, /X-Amz-Signature=/);
        const detail = await call(controller.getClient, { params: { id: 1 } });
        assert.match(detail.data.photo, /X-Amz-Signature=/);
        const otherSite = (await fixture.query('SELECT id FROM members WHERE site_id=2 LIMIT 1')).rows[0];
        assert.equal((await call(controller.getClient, { user: subAdmin, params: { id: otherSite.id } })).status, 403);
        assert.equal((await fixture.query('SELECT photo FROM members WHERE id=1')).rows[0].photo, photo);
      } finally {
        await fixture.query('UPDATE members SET photo=NULL WHERE id=1');
        for (const [name, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[name]; else process.env[name] = value;
        }
      }
    });

    await t.test('registration requires a broker code before creating a client', async () => {
      for (const agent_referral_code of [undefined, '', '   ']) {
        const rejected = await call(controller.createClient, { body: { site_id: 1, registration: true,
          full_name: 'Missing broker', phone: '9876543299', agent_referral_code } });
        assert.equal(rejected.status, 400, JSON.stringify(rejected.data));
        assert.equal(rejected.data.code, 'BROKER_CODE_REQUIRED');
      }
      assert.equal((await fixture.query("SELECT count(*)::int AS n FROM members WHERE phone='9876543299'")).rows[0].n, 0);
    });

    await t.test('any site-authorized user registers once with normalized identity, explicit referral and reusable KYC', async () => {
      const created = await call(controller.createClient, { user: agent, body: {
        site_id: 1, registration: true, full_name: 'Asha Client', phone: '+91 98765 43210',
        pan_no: 'abcde1234f', aadhar_no: '1234 5678 9012', agent_referral_code: 'agt-sub',
      } });
      assert.equal(created.status, 201, JSON.stringify(created.data));
      member = created.data;
      assert.equal(member.phone, '9876543210');
      assert.equal(member.pan_no, 'ABCDE1234F');
      assert.equal(member.referred_by_user_id, 4);
      assert.equal(member.referral_agent_name, 'Site Subadmin');
      assert.equal(member.referral_code, 'AGT-SUB');
      assert.equal(member.kyc_status, 'OPEN');
      assert.ok(member.kyc_case_id);
      const repeat = await call(controller.createClient, { user: agent, body: { site_id: 1, registration: true, full_name: 'Accidental Different Name', phone: '09876543210', agent_referral_code: 'AGT-SUB' } });
      assert.equal(repeat.status, 200, JSON.stringify(repeat.data));
      assert.equal(repeat.data.id, member.id);
      assert.equal(repeat.data.kyc_case_id, member.kyc_case_id);
      assert.equal(repeat.data.full_name, 'Asha Client');
      assert.equal(repeat.data.reused, true);
      assert.equal((await fixture.query('SELECT count(*)::int AS n FROM members WHERE phone=$1', ['9876543210'])).rows[0].n, 1);
    });

    await t.test('referral validation preserves an existing attribution and rejects another site', async () => {
      const conflicting = await call(controller.createClient, { body: { site_id: 1, registration: true, full_name: 'Asha Client', phone: '9876543210', agent_referral_code: 'AGT-TEST' } });
      assert.equal(conflicting.status, 409);
      assert.equal(conflicting.data.code, 'CLIENT_REFERRAL_CONFLICT');
      const invalid = await call(controller.createClient, { body: { site_id: 1, registration: true, full_name: 'New Client', phone: '9876543211', agent_referral_code: 'AGT-OTHER' } });
      assert.equal(invalid.status, 400);
      assert.equal(invalid.data.code, 'INVALID_AGENT_REFERRAL');
      assert.equal((await call(controller.lookupClientReferral, { user: agent, query: { site_id: 1, code: 'agt-sub' } })).data.id, 4);
    });

    await t.test('reused registration fills missing KYC identities and rejects conflicting identities atomically', async () => {
      const first = await call(controller.createClient, { body: { site_id: 1, registration: true, full_name: 'Incomplete Client', phone: '9876543218', agent_referral_code: 'AGT-TEST' } });
      assert.equal(first.status, 201, JSON.stringify(first.data));
      const completed = await call(controller.createClient, { body: { site_id: 1, registration: true, full_name: 'Retyped Name', phone: '9876543218', agent_referral_code: 'AGT-TEST', pan_no: 'pqrst1234u', aadhar_no: '222233334444' } });
      assert.equal(completed.status, 200, JSON.stringify(completed.data));
      assert.equal(completed.data.id, first.data.id);
      assert.equal(completed.data.full_name, 'Incomplete Client');
      assert.equal(completed.data.pan_no, 'PQRST1234U');
      assert.equal(completed.data.aadhar_no, '222233334444');
      for (const fields of [{ pan_no: 'ABCDE1234F' }, { aadhar_no: '333344445555' }]) {
        const conflict = await call(controller.createClient, { body: { site_id: 1, registration: true, full_name: 'Retyped Name', phone: '9876543218', agent_referral_code: 'AGT-TEST', ...fields } });
        assert.equal(conflict.status, 409, JSON.stringify(conflict.data));
        assert.equal(conflict.data.code, 'CLIENT_IDENTITY_CONFLICT');
      }
      const stored = (await fixture.query('SELECT pan_no,aadhar_no FROM members WHERE id=$1', [first.data.id])).rows[0];
      assert.deepEqual(stored, { pan_no: 'PQRST1234U', aadhar_no: '222233334444' });
    });

    await t.test('reviewed OCR details complete a sparse KYC profile and retain confirmed values on reuse', async () => {
      const first = await call(controller.createClient, { body: { site_id: 1, registration: true,
        full_name: 'OCR Reviewed Client', phone: '9876543219', agent_referral_code: 'AGT-TEST', father_name: 'Confirmed Father' } });
      assert.equal(first.status, 201, JSON.stringify(first.data));
      const details = { father_name: 'Replacement Father', date_of_birth: '1995-08-14', gender: 'FEMALE',
        address: '12 Sample Road', city: 'Sample City', state: 'Sample State', pincode: '110001' };
      const completed = await call(controller.createClient, { body: { site_id: 1, registration: true,
        full_name: 'Retyped Client', phone: '9876543219', agent_referral_code: 'AGT-TEST', ...details } });
      assert.equal(completed.status, 200, JSON.stringify(completed.data));
      const stored = (await fixture.query(`SELECT father_name,date_of_birth::text,gender,address,city,state,pincode
        FROM members WHERE id=$1`, [first.data.id])).rows[0];
      assert.deepEqual(stored, { ...details, father_name: 'Confirmed Father' });
      assert.equal(completed.data.id, first.data.id);
      assert.equal(completed.data.kyc_case_id, first.data.kyc_case_id);
    });

    await t.test('site checks apply to create, directory, search, detail, update and supporting documents', async () => {
      for (const [handler, options] of [
        [controller.createClient, { body: { site_id: 1, full_name: 'Forbidden', phone: '9876543212', registration: true } }],
        [controller.listClients, { query: { site_id: 1 } }],
        [controller.searchClients, { query: { site_id: 1, q: '9876' } }],
        [controller.getClient, { params: { id: member.id } }],
        [controller.updateClient, { params: { id: member.id }, body: { full_name: 'Forbidden' } }],
        [controller.getClientDocuments, { params: { id: member.id } }],
        [controller.uploadClientDocument, { params: { id: member.id }, file: { buffer: Buffer.from('test') }, body: { type: 'PAN' } }],
      ]) {
        const denied = await call(handler, { ...options, user: stranger });
        assert.equal(denied.status, 403, `${handler.name}: ${JSON.stringify(denied.data)}`);
      }
      assert.equal((await call(controller.getClient, { user: subAdmin, params: { id: member.id } })).status, 200);
      assert.equal((await call(controller.searchClients, { user: subAdmin, query: { site_id: 2 } })).status, 403);
    });

    await t.test('phone prefixes use bounded lookup and masked identities, while detail supplies the selected record', async () => {
      const search = await call(controller.searchClients, { user: agent, query: { site_id: 1, q: '+91 9876543210', member_type: 'CLIENT', phone_only: true } });
      assert.equal(search.status, 200, JSON.stringify(search.data));
      assert.equal(search.data.length, 1);
      assert.equal(search.data[0].id, member.id);
      assert.equal(search.data[0].aadhar_no, 'XXXX XXXX 9012');
      assert.equal(search.data[0].pan_no, 'AB******4F');
      const detail = await call(controller.getClient, { user: agent, params: { id: member.id } });
      assert.equal(detail.data.aadhar_no, '123456789012');
      const directory = await call(controller.listClients, { user: agent, query: { site_id: 1, limit: 1, page: 1, q: 'Asha' } });
      assert.equal(directory.status, 200, JSON.stringify(directory.data));
      assert.equal(directory.data.total, 1);
      assert.equal(directory.data.items.length, 1);
      assert.equal(directory.data.items[0].draw_count, 0);
      assert.equal(directory.data.items[0].pan_no, 'AB******4F');
      assert.equal((await call(controller.searchClients, { user: agent, query: { site_id: 1, q: '%' } })).data.length, 0);
    });

    await t.test('legacy shared lookups preserve substring, PAN, Aadhaar, role search and the 100-row default', async () => {
      for (const q of ['sha', 'CDE123', '5678 9012'.replace(/ /g, ''), 'LIENT']) {
        const search = await call(controller.searchClients, { user: agent, query: { site_id: 1, q } });
        assert.equal(search.status, 200, JSON.stringify(search.data));
        assert.ok(search.data.some(row => row.id === member.id), `Expected legacy match for ${q}`);
      }
      const prefixOnly = await call(controller.searchClients, { user: agent, query: { site_id: 1, q: '543210', phone_only: true } });
      assert.equal(prefixOnly.data.length, 0);
      const generalPhone = await call(controller.searchClients, { user: agent, query: { site_id: 1, q: '543210' } });
      assert.equal(generalPhone.data[0].id, member.id);
      await fixture.query(`INSERT INTO members(site_id,member_type,full_name,phone)
        SELECT 1,'CLIENT','Bulk Client ' || n, (9000000000::bigint+n)::text FROM generate_series(1,105) n`);
      const general = await call(controller.searchClients, { user: agent, query: { site_id: 1, q: 'Bulk Client' } });
      assert.equal(general.data.length, 100);
      const bounded = await call(controller.searchClients, { user: agent, query: { site_id: 1, q: '900', phone_only: true } });
      assert.equal(bounded.data.length, 25);
    });

    await t.test('supporting document list preserves case ownership and returns file URLs without storage keys', async () => {
      await fixture.query(`INSERT INTO documents(kyc_case_id,client_member_id,site_id,type,file_path,ocr_status)
        VALUES($1,$2,1,'PAN','local::registry-test.pdf','DONE')`, [member.kyc_case_id, member.id]);
      const docs = await call(controller.getClientDocuments, { user: agent, params: { id: member.id } });
      assert.equal(docs.status, 200, JSON.stringify(docs.data));
      assert.equal(docs.data.length, 1);
      assert.match(docs.data[0].file_url, /registry-test\.pdf$/);
      assert.equal(docs.data[0].file_path, undefined);
      await fixture.query('INSERT INTO user_sites(user_id,site_id) VALUES(3,1)');
      const other = await call(controller.getClientDocuments, { user: stranger, params: { id: member.id } });
      assert.deepEqual(other.data, []);
      assert.equal((await call(controller.searchClients, { user: stranger, query: { site_id: 1, q: '9876' } })).data[0].id, member.id);
    });

    await t.test('updates cannot steal another client phone, and invalid identity never persists', async () => {
      const duplicate = await call(controller.updateClient, { user: agent, params: { id: member.id }, body: { phone: '7777777777' } });
      assert.equal(duplicate.status, 409, JSON.stringify(duplicate.data));
      const invalid = await call(controller.createClient, { body: { site_id: 1, full_name: 'Invalid', registration: true, phone: '9876543212', aadhar_no: '123' } });
      assert.equal(invalid.status, 400);
      assert.equal((await fixture.query('SELECT count(*)::int AS n FROM members WHERE phone=$1', ['9876543212'])).rows[0].n, 0);
    });
    await t.test('Clients grants protect its directory and intake without blocking shared booking and KYC lookups', async () => {
      await fixture.query("INSERT INTO user_permissions VALUES(2,'booking_clients',false,true,true,true)");
      assert.equal((await call(controller.listClients, { user: agent, query: { site_id: 1 } })).status, 403);
      const intake = { user: agent, body: { site_id: 1, full_name: 'Permission blocked', phone: '9876543212', registration: true, agent_referral_code: 'AGT-TEST' } };
      assert.equal((await call(controller.createClient, intake)).status, 403);
      assert.equal((await call(controller.previewClientIdentity, { user: agent, body: { site_id: 1 } })).status, 403);
      assert.equal((await call(controller.uploadClientDocument, { user: agent, params: { id: member.id } })).status, 403);
      assert.equal((await call(controller.searchClients, { user: agent, query: { site_id: 1, q: '9876543210', phone_only: true } })).status, 200);
      assert.equal((await call(controller.getClient, { user: agent, params: { id: member.id } })).status, 200);
      assert.equal((await call(controller.listClients, { user: subAdmin, query: { site_id: 1 } })).status, 200);

      await fixture.query("UPDATE user_permissions SET can_read=true,can_write=false WHERE user_id=2 AND module='booking_clients'");
      assert.equal((await call(controller.listClients, { user: agent, query: { site_id: 1 } })).status, 200);
      assert.equal((await call(controller.createClient, intake)).status, 403);
      assert.equal((await call(controller.previewClientIdentity, { user: agent, body: { site_id: 1 } })).status, 403);
      assert.equal((await call(controller.uploadClientDocument, { user: agent, params: { id: member.id } })).status, 403);
      assert.equal((await fixture.query('SELECT count(*)::int AS n FROM members WHERE phone=$1', ['9876543212'])).rows[0].n, 0);
      await fixture.query("DELETE FROM user_permissions WHERE user_id=2 AND module='booking_clients'");
      assert.equal((await call(controller.createClient, intake)).status, 201);
    });
    await t.test('broker member codes work as referrals without creating staff logins', async () => {
      const broker = (await fixture.query("INSERT INTO members(site_id,member_type,status,full_name,phone) VALUES(1,'BROKER','ACTIVE','Member Broker','9765432100') RETURNING id")).rows[0];
      const code = `BRK-${String(broker.id).padStart(5,'0')}`;
      const lookup = await call(controller.lookupClientReferral,{query:{site_id:1,code}});
      assert.equal(lookup.status,200,JSON.stringify(lookup.data));
      assert.equal(lookup.data.name,'Member Broker');
      assert.equal(lookup.data.member_id,broker.id);
      const collector = await resolvePaymentCollector({received_by_agent_code:code},1,fixture.pool);
      assert.equal(collector.memberId,broker.id);
      assert.equal(collector.receivedBy,`Member Broker (${code})`);
      const saved = await call(controller.createClient,{body:{site_id:1,registration:true,full_name:'Broker referred Client',phone:'9765432101',agent_referral_code:code}});
      assert.equal(saved.status,201,JSON.stringify(saved.data));
      assert.equal(saved.data.referred_by_member_id,broker.id);
      assert.equal(saved.data.referred_by_code,code);
      const detail=await call(controller.getClient,{params:{id:saved.data.id}});
      assert.equal(detail.data.referred_by_code,code);
      const clientCode=`CLT-${String(saved.data.id).padStart(5,'0')}`;
      const search=await call(controller.searchClients,{query:{site_id:1,q:clientCode,member_type:'CLIENT'}});
      assert.equal(search.status,200,JSON.stringify(search.data));
      assert.deepEqual(search.data.map(r=>r.id),[saved.data.id]);
      assert.equal(search.data[0].referred_by_code,code);
      assert.equal((await call(controller.lookupClientReferral,{query:{site_id:2,code}})).status,400);
      assert.equal((await call(controller.lookupClientReferral,{query:{site_id:1,code:clientCode}})).status,400);
      await fixture.query("UPDATE members SET status='INACTIVE' WHERE id=$1",[broker.id]);
      assert.equal((await call(controller.lookupClientReferral,{query:{site_id:1,code}})).status,400);
    });
    await t.test('shared broker code resolves an existing active Member at this site without changing roles', async () => {
      const local = (await fixture.query("INSERT INTO members(site_id,member_type,status,full_name,phone) VALUES(1,'MEMBER','ACTIVE','Shared broker identity','9654321000') RETURNING id")).rows[0];
      const code = `BRK-${String(local.id).padStart(5,'0')}`;
      assert.equal((await call(controller.lookupClientReferral,{query:{site_id:1,code}})).status,400);
      await fixture.query("INSERT INTO members(site_id,member_type,status,full_name,phone) VALUES(2,'BROKER','ACTIVE','Shared broker identity','+91 9654321000')");
      const lookup = await call(controller.lookupClientReferral,{query:{site_id:1,code}});
      assert.equal(lookup.status,200,JSON.stringify(lookup.data));
      assert.equal(lookup.data.member_id,local.id);
      assert.equal(lookup.data.referral_code,code);
      const registered=await call(controller.createClient,{body:{site_id:1,registration:true,full_name:'Shared broker customer',phone:'9654321001',agent_referral_code:code}});
      assert.equal(registered.status,201,JSON.stringify(registered.data));
      assert.equal(registered.data.referred_by_member_id,local.id);
      assert.equal(registered.data.referred_by_code,code);
      const detail=await call(controller.getClient,{params:{id:registered.data.id}});
      assert.equal(detail.data.referred_by_code,code);
      const search=await call(controller.searchClients,{query:{site_id:1,q:'9654321001'}});
      assert.equal(search.data[0].referred_by_code,code);
      assert.equal((await fixture.query('SELECT member_type FROM members WHERE id=$1',[local.id])).rows[0].member_type,'MEMBER');
      await fixture.query("UPDATE members SET status='INACTIVE' WHERE id=$1",[local.id]);
      assert.equal((await call(controller.lookupClientReferral,{query:{site_id:1,code}})).status,400);
    });
  } finally { await fixture.close(); }
});
