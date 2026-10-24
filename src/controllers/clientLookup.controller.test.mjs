import test from 'node:test';
import assert from 'node:assert/strict';
import { drawFixture, TEST_BROKER_CODE } from '../test/drawFixture.mjs';
import { migrateClientRegistry } from '../migrations/030_client_registry.js';
import { signAccessToken } from '../config/jwt.js';
import { todayIST } from '../services/drawWorkflow.js';
import kycCaseModel from '../models/KycCase.model.js';
import lookupRoutes from '../routes/lookups.routes.js';
import { clientLookupLimit, clientSearchLimit } from '../middlewares/rateLimit.middleware.js';
import { clientOverview, lookupClient } from './clientLookup.controller.js';
import { listClients, uploadClientDocument } from './booking.controller.js';
import { createDraw, setDrawSettings } from './draw.controller.js';

const admin = { id: 1, role: 'admin' };
const agent = { id: 2, role: 'agent' };
const sales = { id: 3, role: 'sub_admin' }; // the shared sales login: Clients + Draws, "Enroll in Draw" hidden
const blocked = { id: 4, role: 'sub_admin' }; // Clients View denied
const viewer = { id: 5, role: 'sub_admin' }; // Draws View only
const response = resolve => ({
  statusCode: 200, headers: {},
  set(name, value) { this.headers[name] = value; return this; },
  status(code) { this.statusCode = code; return this; },
  json(data) { resolve({ status: this.statusCode, data, headers: this.headers }); return this; },
});
const call = (handler, { user = admin, query = {}, body = {}, params = {}, file, req = {} } = {}) => new Promise(resolve => {
  handler(Object.assign(req, { user, query, body, params, file }), response(resolve),
    error => resolve({ status: error.status || 500, data: { message: error.message, code: error.code } }));
});
const lookup = (query, user = admin) => call(lookupClient, { user, query });
const keysDeep = value => value && typeof value === 'object'
  ? Object.entries(value).flatMap(([key, item]) => [key, ...keysDeep(item)]) : [];

test('number-first client lookup, Home overview and the KYC directory filter on isolated PostgreSQL', async t => {
  const f = await drawFixture({ broker: true });
  const insert = async (table, row) => {
    const columns = Object.keys(row);
    const { rows } = await f.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, Object.values(row));
    return rows[0].id;
  };
  const member = (site_id, member_type, full_name, phone, extra = {}) =>
    insert('members', { site_id, member_type, full_name, phone, status: 'ACTIVE', created_by: 1, ...extra });
  const kycCase = (client_member_id, status, extra = {}) =>
    insert('kyc_cases', { client_member_id, site_id: 1, status, created_by: 1, mode: 'MANUAL_OCR', ...extra });
  const doc = (kyc_case_id, client_member_id, type, member_document_field = null) =>
    insert('documents', { kyc_case_id, client_member_id, site_id: 1, type, member_document_field, file_path: `test/${kyc_case_id}-${type}-${member_document_field}` });
  const allDocs = async (caseId, memberId) => {
    await doc(caseId, memberId, 'AADHAAR', 'aadhar_front_url');
    await doc(caseId, memberId, 'AADHAAR', 'aadhar_back_url');
    await doc(caseId, memberId, 'PAN', 'pan_card_url');
  };
  const settings = body => call(setDrawSettings, { body: { site_id: 1, required_amount: 5000, wait_days: 10, scheme_name: 'A1', ...body } });
  const ids = {};
  try {
    await f.db.exec(`
      ALTER TABLE users ADD COLUMN token_version INTEGER DEFAULT 1;
      ALTER TABLE members ADD COLUMN created_at TIMESTAMPTZ DEFAULT now(), ADD COLUMN occupation TEXT;
      CREATE TABLE user_permissions(user_id INTEGER, module TEXT, can_read BOOLEAN, can_write BOOLEAN, can_update BOOLEAN, can_delete BOOLEAN, updated_at TIMESTAMPTZ, UNIQUE(user_id, module));
      INSERT INTO users (id, name, email, role) VALUES (3, 'Sales Desk', 'sales@example.test', 'sub_admin'),
        (4, 'Blocked Desk', 'blocked@example.test', 'sub_admin'), (5, 'Viewer Desk', 'viewer@example.test', 'sub_admin');
      INSERT INTO user_sites VALUES (3, 1), (3, 2), (4, 1), (5, 1);
      INSERT INTO user_permissions (user_id, module, can_read, can_write, can_update, can_delete) VALUES
        (3, 'booking_clients', true, true, true, true), (3, 'booking_draws', true, true, true, true),
        (3, 'booking_item_draws_new', false, false, false, false),
        (4, 'booking_clients', false, true, true, true),
        (5, 'booking_draws', true, false, false, false);`);
    await migrateClientRegistry(f.pool);
    assert.equal((await settings({})).status, 200);

    ids.employee = await member(1, 'EMPLOYEE', 'Staff Buyer', '9811111112', { member_types: ['EMPLOYEE'] });
    ids.employeeCase = await kycCase(ids.employee, 'OPEN');
    await doc(ids.employeeCase, ids.employee, 'AADHAAR', 'aadhar_front_url');
    ids.pending = await member(1, 'CLIENT', 'Pending Client', '9811111113');
    ids.pendingCase = await kycCase(ids.pending, 'OPEN');
    await doc(ids.pendingCase, ids.pending, 'AADHAAR', 'aadhar_front_url');
    await doc(ids.pendingCase, ids.pending, 'PAN', 'pan_card_url');
    ids.registered = await member(1, 'CLIENT', 'Registered Client', '9811111114', { city: 'Shamli' });
    ids.registeredCase = await kycCase(ids.registered, 'VERIFIED');
    await allDocs(ids.registeredCase, ids.registered);
    ids.reverified = await member(1, 'CLIENT', 'Verified Earlier', '9811111115');
    ids.reverifiedCase = await kycCase(ids.reverified, 'VERIFIED');
    await doc(ids.reverifiedCase, ids.reverified, 'AADHAAR', 'aadhar_front_url');
    ids.reverifiedOpen = await kycCase(ids.reverified, 'OPEN'); // newer, empty: where the next upload would land
    ids.restarted = await member(1, 'CLIENT', 'Restarted Client', '9811111116');
    const olderCase = await kycCase(ids.restarted, 'OPEN');
    await doc(olderCase, ids.restarted, 'AADHAAR', 'aadhar_front_url');
    await doc(olderCase, ids.restarted, 'AADHAAR', 'aadhar_back_url');
    ids.restartedCase = await kycCase(ids.restarted, 'OPEN');
    ids.rejected = await member(1, 'CLIENT', 'Rejected Client', '9811111117');
    ids.rejectedCase = await kycCase(ids.rejected, 'REJECTED');
    await doc(ids.rejectedCase, ids.rejected, 'AADHAAR', 'aadhar_front_url');
    ids.identity = await member(1, 'CLIENT', 'Identity Client', '+91 98111-11118', {
      aadhar_no: '123456789012', pan_no: 'ABCDE1234F', email: 'identity@example.test', address: '12 Private Road',
      father_name: 'Private Father', photo: 'https://example.test/photo.jpg', referred_by_member_id: 900 });
    ids.otherSite = await member(2, 'CLIENT', 'Other Site Client', '9811111119', { created_at: new Date(Date.now() - 40 * 864e5).toISOString() });
    await kycCase(ids.otherSite, 'VERIFIED', { site_id: 2 });

    await t.test('an unknown number is NEW with the site-level draw block only', async () => {
      const result = await lookup({ site_id: 1, phone: '+91 98111-11111' });
      assert.equal(result.status, 200, JSON.stringify(result.data));
      assert.equal(result.headers['Cache-Control'], 'private, no-store');
      assert.deepEqual(result.data, { state: 'NEW', phone: '9811111111', client: null, kyc: null, draw: {
        open: true, reason: null, can_enroll: true, scheme_name: 'A1', opening_date: '',
        client_block: null, enrolled: false, entry_count: 0, entries: [] } });
      assert.equal((await lookup({ site_id: 1, phone: '9811111119' })).data.state, 'NEW', 'another site’s member is not visible here');
    });

    await t.test('a non-client profile is NEW, keeps its row and reports its KYC case', async () => {
      const { status, data } = await lookup({ site_id: 1, phone: '09811111112' });
      assert.equal(status, 200, JSON.stringify(data));
      assert.equal(data.state, 'NEW');
      assert.deepEqual([data.client.id, data.client.is_client, data.client.member_type, data.client.member_types], [ids.employee, false, 'EMPLOYEE', ['EMPLOYEE']]);
      assert.deepEqual(data.kyc, { case_id: ids.employeeCase, status: 'OPEN', verified: false,
        documents: { aadhaar_front: true, aadhaar_back: false, pan: false }, missing: ['aadhaar_back', 'pan'] });
      assert.equal(data.draw.client_block, 'NOT_CLIENT');
    });

    await t.test('KYC_PENDING describes the upload-target case; REGISTERED follows any VERIFIED case', async () => {
      const pending = (await lookup({ site_id: 1, phone: '9811111113' })).data;
      assert.equal(pending.state, 'KYC_PENDING');
      assert.deepEqual(pending.kyc, { case_id: ids.pendingCase, status: 'OPEN', verified: false,
        documents: { aadhaar_front: true, aadhaar_back: false, pan: true }, missing: ['aadhaar_back'] });
      const registered = (await lookup({ site_id: 1, phone: '9811111114' })).data;
      assert.equal(registered.state, 'REGISTERED');
      assert.deepEqual(registered.kyc, { case_id: ids.registeredCase, status: 'VERIFIED', verified: true,
        documents: { aadhaar_front: true, aadhaar_back: true, pan: true }, missing: [] });
      assert.equal(registered.client.city, 'Shamli');
      const reverified = (await lookup({ site_id: 1, phone: '9811111115' })).data;
      assert.equal(reverified.state, 'REGISTERED', 'an older VERIFIED case wins over a newer empty OPEN one');
      assert.deepEqual([reverified.kyc.case_id, reverified.kyc.status, reverified.kyc.missing], [ids.reverifiedCase, 'VERIFIED', []]);
      const restarted = (await lookup({ site_id: 1, phone: '9811111116' })).data;
      assert.equal(restarted.state, 'KYC_PENDING');
      assert.deepEqual([restarted.kyc.case_id, restarted.kyc.missing], [ids.restartedCase, ['aadhaar_front', 'aadhaar_back', 'pan']],
        'documents on an older case do not count: uploads go to the newest booking-less case');
      const rejected = (await lookup({ site_id: 1, phone: '9811111117' })).data;
      assert.deepEqual([rejected.state, rejected.kyc.status, rejected.kyc.missing], ['KYC_PENDING', 'REJECTED', ['aadhaar_back', 'pan']]);
    });

    await t.test('agents see the case their own upload would use, exactly like getOrCreateForMember', async () => {
      const own = (await lookup({ site_id: 1, phone: '9811111113' }, agent)).data;
      assert.equal(own.state, 'KYC_PENDING');
      assert.deepEqual(own.kyc, { case_id: null, status: null, verified: false,
        documents: { aadhaar_front: false, aadhaar_back: false, pan: false }, missing: ['aadhaar_front', 'aadhaar_back', 'pan'] });
      const agentCase = await kycCase(ids.pending, 'OPEN', { created_by: 2 });
      await doc(agentCase, ids.pending, 'PAN', 'pan_card_url');
      for (const [user, visibleUserIds] of [[agent, [2]], [admin, null]]) {
        const { data } = await lookup({ site_id: 1, phone: '9811111113' }, user);
        const target = await kycCaseModel.getOrCreateForMember({ memberId: ids.pending, siteId: 1, createdBy: user.id, visibleUserIds }, f.pool);
        assert.equal(data.kyc.case_id, target.id, `${user.role}: checklist is the upload target`);
        assert.deepEqual(data.kyc.documents, { aadhaar_front: false, aadhaar_back: false, pan: true });
      }
    });

    await t.test('lookup by id returns the same view and stays inside the site', async () => {
      const byPhone = (await lookup({ site_id: 1, phone: '9811111114' })).data;
      const byId = await lookup({ site_id: 1, id: String(ids.registered) });
      assert.equal(byId.status, 200, JSON.stringify(byId.data));
      assert.deepEqual(byId.data, byPhone);
      const elsewhere = await lookup({ site_id: 1, id: ids.otherSite });
      assert.deepEqual([elsewhere.status, elsewhere.data.message], [404, 'Client not found at this site']);
      assert.equal((await lookup({ site_id: 1, id: 999999 })).status, 404);
    });

    await t.test('bad input is a 400; other sites and denied Clients View are a 403', async () => {
      for (const [query, message] of [
        [{ site_id: 1, phone: '12345' }, 'Enter a valid 10-digit Indian mobile number'],
        [{ site_id: 1, phone: '1234567890' }, 'Enter a valid 10-digit Indian mobile number'],
        [{ site_id: 1, phone: '98111 1111x' }, 'Enter a valid mobile number'],
        [{ site_id: 1, phone: '9811111114', id: ids.registered }, 'Send either phone or id'],
        [{ site_id: 1 }, 'Send either phone or id'],
        [{ site_id: 1, id: 'abc' }, 'Enter a valid client ID'],
        [{ site_id: 1, id: '0' }, 'Enter a valid client ID'],
        [{ site_id: 'x', phone: '9811111114' }, 'Select a valid site'],
      ]) {
        const result = await lookup(query);
        assert.deepEqual([result.status, result.data.message], [400, message], JSON.stringify(query));
      }
      const otherSite = await lookup({ site_id: 2, phone: '9811111119' }, agent);
      assert.deepEqual([otherSite.status, otherSite.data.message], [403, 'You do not have access to this site']);
      const denied = await lookup({ site_id: 1, phone: '9811111114' }, blocked);
      assert.deepEqual([denied.status, denied.data.message], [403, 'Access Control has not granted this Clients action for your account']);
      assert.equal((await call(clientOverview, { user: blocked, query: { site_id: 1 } })).status, 403);
      assert.equal((await lookup({ site_id: 1, phone: '9811111114' }, sales)).status, 200);
    });

    await t.test('the payload is minimal and masked', async () => {
      const { data } = await lookup({ site_id: 1, phone: '9811111118' });
      assert.equal(data.state, 'KYC_PENDING');
      assert.deepEqual(Object.keys(data).sort(), ['client', 'draw', 'kyc', 'phone', 'state']);
      assert.deepEqual(Object.keys(data.client).sort(), ['aadhaar_last4', 'city', 'code_id', 'full_name', 'id', 'is_client', 'member_type',
        'member_types', 'pan_masked', 'phone', 'photo', 'referred_by_code', 'referred_by_name', 'registered_at', 'site_id']);
      assert.deepEqual(Object.keys(data.kyc).sort(), ['case_id', 'documents', 'missing', 'status', 'verified']);
      assert.deepEqual(Object.keys(data.draw).sort(), ['can_enroll', 'client_block', 'enrolled', 'entries', 'entry_count', 'open', 'opening_date', 'reason', 'scheme_name']);
      assert.deepEqual([data.client.aadhaar_last4, data.client.pan_masked, data.client.phone, data.client.code_id], ['9012', 'AB******4F', '9811111118', ids.identity]);
      assert.deepEqual([data.client.referred_by_name, data.client.referred_by_code], ['Test Broker', TEST_BROKER_CODE]);
      const forbidden = ['aadhar_no', 'pan_no', 'email', 'address', 'father_name', 'aadhar_front_url', 'aadhar_back_url', 'pan_card_url', 'file_url', 'file_path', 'account_no', 'ifsc_code'];
      assert.deepEqual(keysDeep(data).filter(key => forbidden.includes(key)), []);
      const text = JSON.stringify(data);
      for (const secret of ['123456789012', 'ABCDE1234F', 'identity@example.test', 'Private Road', 'Private Father']) assert.ok(!text.includes(secret), secret);
    });

    await t.test('can_enroll reads raw draw rows: the Enroll in Draw switch and the sub-admin Create grant', async () => {
      const draw = async user => (await lookup({ site_id: 1, phone: '9811111114' }, user)).data.draw;
      assert.equal((await draw(admin)).can_enroll, true, 'admin, no rows');
      assert.equal((await draw(sales)).can_enroll, false, 'sales: Clients + Draws granted, Enroll in Draw hidden');
      assert.equal((await draw(viewer)).can_enroll, false, 'sub-admin without Draws Create');
      assert.equal((await draw(agent)).can_enroll, true, 'agents are not sub-admin gated');
      await f.query("UPDATE user_permissions SET can_read = true WHERE user_id = 3 AND module = 'booking_item_draws_new'");
      assert.equal((await draw(sales)).can_enroll, true);
      await f.query("UPDATE user_permissions SET can_read = false WHERE user_id = 3 AND module = 'booking_item_draws_new'");
      await f.query("INSERT INTO user_permissions (user_id, module, can_read) VALUES (1, 'booking_item_draws_new', false)");
      assert.equal((await draw(admin)).can_enroll, false, 'the Module Show switch hides the page from admins too');
      await f.query('DELETE FROM user_permissions WHERE user_id = 1');
    });

    await t.test('open and reason come from the server gate plus the scheme name', async () => {
      const reason = async (query = { site_id: 1, phone: '9811111114' }) => {
        const { data } = await lookup(query);
        assert.equal(data.draw.open, data.draw.reason === null);
        return data.draw.reason;
      };
      assert.equal(await reason({ site_id: 2, phone: '9811111119' }), 'NOT_CONFIGURED');
      await settings({ enabled: false });
      assert.equal(await reason(), 'DRAW_DISABLED');
      await settings({ enabled: true, scheme_name: null });
      assert.equal(await reason(), 'NO_SCHEME');
      await settings({});
      await f.query('UPDATE project_settings SET draw_opening_date = $1::date - 1 WHERE site_id = 1', [todayIST()]);
      assert.equal(await reason(), 'OPENING_DATE_PASSED');
      await f.query('UPDATE project_settings SET draw_opening_date = $1::date WHERE site_id = 1', [todayIST()]);
      const { data } = await lookup({ site_id: 1, phone: '9811111114' });
      assert.deepEqual([data.draw.reason, data.draw.opening_date], [null, todayIST()]);
      await settings({ opening_date: null });
    });

    await t.test('enrolled and entry_count follow POST /draws; entries respect agent visibility', async () => {
      const enroll = (body, user = admin) => call(createDraw, { user, body: { site_id: 1, client_member_id: ids.registered, broker_code: TEST_BROKER_CODE, ...body } });
      const first = await enroll({ scheme_name: 'A1' });
      assert.equal(first.status, 201, JSON.stringify(first.data));
      let draw = (await lookup({ site_id: 1, phone: '9811111114' })).data.draw;
      assert.deepEqual([draw.enrolled, draw.entry_count, draw.client_block], [true, 1, null]);
      assert.deepEqual(draw.entries, [{ id: first.data.id, registration_no: first.data.registration_no, status: 'REGISTERED', slip_no: null, scheme_name: 'A1' }]);
      assert.equal((await enroll({ scheme_name: 'A1', additional_entry: true })).status, 201);
      assert.equal((await enroll({ scheme_name: 'B5' })).status, 201);
      draw = (await lookup({ site_id: 1, phone: '9811111114' })).data.draw;
      assert.deepEqual([draw.enrolled, draw.entry_count, draw.entries.length], [true, 2, 3], 'entry_count is the current draw only');
      const hidden = (await lookup({ site_id: 1, phone: '9811111114' }, agent)).data.draw;
      assert.deepEqual([hidden.enrolled, hidden.entry_count, hidden.entries], [true, 2, []], 'POST /draws would still refuse a duplicate');
      const own = await enroll({ scheme_name: 'C3' }, agent);
      assert.equal(own.status, 201, JSON.stringify(own.data));
      assert.deepEqual((await lookup({ site_id: 1, phone: '9811111114' }, agent)).data.draw.entries.map(entry => entry.id), [own.data.id]);
      await call(setDrawSettings, { body: { site_id: 1, required_amount: 5000, wait_days: 10, scheme_name: 'C3' } });
      draw = (await lookup({ site_id: 1, phone: '9811111114' })).data.draw;
      assert.deepEqual([draw.enrolled, draw.entry_count, draw.entries.length], [true, 1, 4]);
      await settings({});
    });

    await t.test('uploads hand the resolved upload-target case to uploadDocument', async () => {
      const req = {};
      const result = await call(uploadClientDocument, { req, params: { id: ids.restarted }, body: { type: 'AADHAAR', member_document_field: 'not_a_field' },
        file: { buffer: Buffer.from('test'), mimetype: 'image/jpeg', size: 4, originalname: 'front.jpg' } });
      assert.equal(result.status, 400, 'stops at field validation, before storage');
      assert.equal(req.kycCase.id, ids.restartedCase);
      assert.equal(req.kycCase.status, 'OPEN');
      assert.equal(req.verifyOnIdentityComplete, true);
      assert.equal((await call(uploadClientDocument, { user: blocked, params: { id: ids.restarted } })).status, 403, 'permission before the file check');
      assert.equal((await call(uploadClientDocument, { params: { id: ids.restarted } })).data.message, 'Upload a supporting document in the file field');
    });

    const midnight = new Date(`${todayIST()}T00:00:00+05:30`);
    const daysAgo = days => new Date(Date.now() - days * 864e5).toISOString();
    const site2 = {};
    await t.test('overview counts today in IST, pending KYC and recent verified clients not yet in the current draw', async () => {
      const verified = async (name, phone, created_at) => {
        const id = await member(2, 'CLIENT', name, phone, { created_at });
        await kycCase(id, 'VERIFIED', { site_id: 2 });
        return id;
      };
      const entry = (client_member_id, scheme_name, enrollment_key, status = 'REGISTERED') => insert('draw_registrations', {
        site_id: 2, client_member_id, scheme_name, enrollment_key, required_amount: 5000, status, qr_token: `overview-${client_member_id}-${status}-${enrollment_key}` });
      site2.today = await member(2, 'CLIENT', 'Registered at IST midnight', '9822222201', { created_at: midnight.toISOString() });
      site2.yesterday = await verified('Registered just before', '9822222202', new Date(midnight.getTime() - 1000).toISOString());
      site2.old = await verified('Older than 30 days', '9822222203', daysAgo(31));
      site2.entered = await verified('Already in the draw', '9822222204', daysAgo(2));
      await entry(site2.entered, 'Lucky Draw', 'name:LUCKY DRAW');
      site2.extra = await verified('Extra entry only', '9822222205', daysAgo(2));
      await entry(site2.extra, 'Lucky Draw', 'name:LUCKY DRAW#ENTRY-2');
      site2.otherDraw = await verified('Other draw', '9822222206', daysAgo(2));
      await entry(site2.otherDraw, 'Other', 'name:OTHER');
      site2.cancelled = await verified('Cancelled entry', '9822222207', daysAgo(2));
      await entry(site2.cancelled, 'Lucky Draw', 'name:LUCKY DRAW', 'CANCELLED');
      site2.legacy = await verified('Legacy entry', '9822222208', daysAgo(2));
      await entry(site2.legacy, ' lucky   draw ', null);
      await member(2, 'EMPLOYEE', 'Not a client', '9822222209', { created_at: midnight.toISOString() });
      site2.rejected = await member(2, 'CLIENT', 'Rejected KYC', '9822222210', { created_at: daysAgo(3) });
      await kycCase(site2.rejected, 'REJECTED', { site_id: 2 });
      const elsewhere = await member(2, 'CLIENT', 'Verified at another site only', '9822222211', { created_at: daysAgo(3) });
      await kycCase(elsewhere, 'VERIFIED', { site_id: 1 });
      site2.pending = [site2.today, site2.rejected, elsewhere];

      const overview = async (user = admin) => {
        const result = await call(clientOverview, { user, query: { site_id: 2 } });
        assert.equal(result.status, 200, JSON.stringify(result.data));
        assert.equal(result.headers['Cache-Control'], 'private, no-store');
        return result.data;
      };
      const unconfigured = await overview();
      assert.deepEqual([unconfigured.awaiting_draw, unconfigured.draw.reason], [null, 'NOT_CONFIGURED']);
      await call(setDrawSettings, { body: { site_id: 2, required_amount: 5000, wait_days: 10, scheme_name: 'Lucky  Draw' } });
      const data = await overview();
      assert.match(data.generated_at, /^\d{4}-\d{2}-\d{2}T/);
      assert.deepEqual({ ...data, generated_at: undefined }, { site_id: 2, registered_today: 1, pending_kyc: 3, awaiting_draw: 3,
        draw: { open: true, reason: null, can_enroll: true, scheme_name: 'Lucky Draw', opening_date: '' }, generated_at: undefined });
      const salesView = await overview(sales);
      assert.deepEqual([salesView.awaiting_draw, salesView.draw.can_enroll, salesView.pending_kyc], [null, false, 3]);
      await call(setDrawSettings, { body: { site_id: 2, required_amount: 5000, wait_days: 10, scheme_name: 'Lucky Draw', enabled: false } });
      const closed = await overview();
      assert.deepEqual([closed.awaiting_draw, closed.draw.open, closed.draw.reason], [null, false, 'DRAW_DISABLED']);
      assert.equal((await call(clientOverview, { user: viewer, query: { site_id: 2 } })).status, 403, 'site not assigned');
    });

    await t.test('the directory filters by KYC with the same rule and labels every row', async () => {
      const list = async kyc => {
        const result = await call(listClients, { query: { site_id: 2, kyc, limit: 100 } });
        assert.equal(result.status, 200, JSON.stringify(result.data));
        return result.data;
      };
      const pending = await list('pending');
      assert.deepEqual(pending.items.map(item => item.id).sort((a, b) => a - b), [...site2.pending].sort((a, b) => a - b));
      assert.equal(pending.total, 3);
      assert.ok(pending.items.every(item => item.kyc_verified === false));
      const verified = await list('VERIFIED');
      assert.equal(verified.total, 8);
      assert.ok(verified.items.every(item => item.kyc_verified === true));
      const all = await list(undefined);
      assert.equal(all.total, 11);
      assert.equal(all.items.find(item => item.id === site2.cancelled).draw_count, 1, 'draw_count still counts every registration');
      assert.equal(all.items.find(item => item.id === site2.today).draw_count, 0);
      const bad = await call(listClients, { query: { site_id: 2, kyc: 'done' } });
      assert.deepEqual([bad.status, bad.data.message], [400, 'kyc must be pending or verified']);
      assert.equal((await call(listClients, { user: blocked, query: { site_id: 1, kyc: 'done' } })).status, 403, 'the gate runs first');
    });

    await t.test('lookup and overview are routed ahead of /clients/:id behind auth', async () => {
      const token = signAccessToken({ id: 3, version: 1, role: 'sub_admin' });
      const request = (url, query) => new Promise(resolve => {
        const req = { method: 'GET', url, originalUrl: url, query, ip: '10.1.1.1', headers: { authorization: `Bearer ${token}` }, header(name) { return this.headers[name.toLowerCase()]; } };
        lookupRoutes.handle(req, response(resolve), error => resolve({ status: error?.status || 404, data: { message: error?.message } }));
      });
      const found = await request('/clients/lookup', { site_id: '1', phone: '9811111114' });
      assert.equal(found.status, 200, JSON.stringify(found.data));
      assert.deepEqual([found.data.state, found.data.draw.can_enroll], ['REGISTERED', false]);
      const overview = await request('/clients/overview', { site_id: '1' });
      assert.equal(overview.status, 200, JSON.stringify(overview.data));
      assert.equal(typeof overview.data.pending_kyc, 'number');
    });
  } finally { await f.close(); }
});

test('lookup and search limits key on account + address, separately', async () => {
  const hit = (limit, ip, id = 77) => new Promise(resolve => {
    const res = response(resolve);
    limit({ user: { id }, ip }, res, () => resolve({ status: 'next' }));
  });
  for (let i = 0; i < 120; i += 1) assert.equal((await hit(clientLookupLimit, '10.9.9.9')).status, 'next');
  const limited = await hit(clientLookupLimit, '10.9.9.9');
  assert.deepEqual([limited.status, limited.data.code], [429, 'RATE_LIMITED']);
  assert.ok(Number(limited.headers['Retry-After']) >= 1);
  assert.equal((await hit(clientLookupLimit, '10.9.9.8')).status, 'next', 'another device address keeps its budget');
  assert.equal((await hit(clientLookupLimit, '10.9.9.9', 78)).status, 'next', 'another account keeps its budget');
  for (let i = 0; i < 240; i += 1) assert.equal((await hit(clientSearchLimit, '10.9.9.9')).status, 'next', 'search has its own, larger budget');
  assert.equal((await hit(clientSearchLimit, '10.9.9.9')).status, 429);
});
