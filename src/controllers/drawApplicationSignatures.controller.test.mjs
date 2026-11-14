import { applicationSigningContext } from '../services/applicationFormSnapshot.js';
import { migrateFormStudioAttendance } from '../migrations/025_form_studio_attendance.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { drawFixture } from '../test/drawFixture.mjs';
import { normalizeApplicationSignature, getDrawApplicationSignatures } from '../services/drawApplicationSignatures.js';
import { migrateDrawApplicationSignatures } from '../migrations/050_draw_application_signatures.js';
import { saveApplicationSignatures, getDraw, publicVerifyDraw } from './draw.controller.js';
import { subAdminPermission } from '../middlewares/subAdminPermission.middleware.js';

const admin = { id: 1, role: 'admin' };
const agent = { id: 2, role: 'agent' };
const call = (handler, { id = 1, body = {}, user = admin, query = {} } = {}) => new Promise(resolve => {
  handler({ params: { id: String(id) }, body, user, query }, {
    statusCode: 200, status(value) { this.statusCode = value; return this; },
    json(data) { resolve({ status: this.statusCode, data }); },
  }, error => resolve({ status: error.status || 500, data: { message: error.message } }));
});
const png = async background => `data:image/png;base64,${(await sharp({ create: {
  width: 100, height: 40, channels: 4, background,
} }).png().toBuffer()).toString('base64')}`;

test('application signing rejects blank, malformed and oversized drawings', async () => {
  const ink = await png({ r: 20, g: 30, b: 50, alpha: 1 });
  assert.match(await normalizeApplicationSignature(ink, 'Applicant'), /^data:image\/png;base64,/);
  for (const image of [await png({ r: 255, g: 255, b: 255, alpha: 1 }), await png({ r: 0, g: 0, b: 0, alpha: 0 })]) {
    await assert.rejects(normalizeApplicationSignature(image, 'Applicant'), { status: 400, message: /empty/ });
  }
  for (const image of ['', null, 'https://example.test/signature.png', 'data:image/png;base64,YmFk', 'data:image/svg+xml;base64,YmFk']) {
    await assert.rejects(normalizeApplicationSignature(image, 'Applicant'), { status: 400 });
  }
  await assert.rejects(normalizeApplicationSignature(`data:image/png;base64,${'A'.repeat(700_000)}`, 'Applicant'), { status: 413 });
  const oversized = await sharp({ create: { width: 2401, height: 10, channels: 4, background: 'black' } }).png().toBuffer();
  await assert.rejects(normalizeApplicationSignature(`data:image/png;base64,${oversized.toString('base64')}`, 'Applicant'), { status: 400 });
});

test('confirmed application signatures persist with audit and enforce the issued form, site and network', async () => {
  const f = await drawFixture();
  try {
    await f.db.exec(`INSERT INTO members (site_id, member_type, full_name) VALUES (1, 'CLIENT', 'Signature Applicant');
      INSERT INTO draw_registrations (site_id, client_member_id, registration_no, qr_token, slip_no, terms_snapshot, status, created_by)
      VALUES (1, 1, 'APP-SIGN-1', 'signature-test-token', 'SIGN-SLIP-1', '1. Agreed terms.', 'SLIP_ISSUED', 1),
             (1, 1, 'APP-SIGN-2', 'unsigned-test-token', NULL, NULL, 'REGISTERED', 1),
             (1, 1, 'APP-SIGN-3', 'cancelled-test-token', 'SIGN-SLIP-3', '1. Agreed terms.', 'CANCELLED', 1),
             (2, 1, 'APP-SIGN-4', 'other-site-test-token', 'SIGN-SLIP-4', '1. Agreed terms.', 'SLIP_ISSUED', 2);`);
    const applicant = await png({ r: 20, g: 30, b: 50, alpha: 1 });
    const authority = await png({ r: 40, g: 50, b: 70, alpha: 1 });
    await migrateFormStudioAttendance(f.pool);
    await f.query(`INSERT INTO application_form_templates(site_id,published,published_revision) VALUES(1,$1,1),(2,$1,1)`,[JSON.stringify({form_title:'Frozen original',payment_plan:{title:'Original plan'}})]);
    const context=await applicationSigningContext({id:1,user:admin,db:f.pool});
    const body = { applicant, authority, context_hash:context.context_hash };
    assert.equal((await call(getDraw)).data.application_signatures, null);
    assert.equal((await call(saveApplicationSignatures, { body, user: agent })).status, 403, 'another network cannot sign');
    assert.equal((await call(saveApplicationSignatures, { id: 4, body, user: agent })).status, 403, 'site assignment still applies to an owned entry');
    assert.equal((await call(saveApplicationSignatures, { id: 2, body })).status, 409, 'the application must be issued');
    assert.equal((await call(saveApplicationSignatures, { id: 3, body })).status, 409, 'cancelled applications cannot be signed');
    assert.equal((await call(saveApplicationSignatures, { id: 999, body })).status, 404);
    assert.equal((await call(saveApplicationSignatures, { body: { applicant,context_hash:context.context_hash } })).status, 400, 'both fields must be confirmed');

    const saved = await call(saveApplicationSignatures, { body });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.equal(saved.data.application_signatures.signed_by, admin.id);
    assert.ok(saved.data.application_signatures.signed_at);
    assert.match(saved.data.application_signatures.applicant, /^data:image\/png;base64,/);
    assert.match(saved.data.application_signatures.authority, /^data:image\/png;base64,/);
    const loaded = await call(getDraw);
    assert.deepEqual(loaded.data.application_signatures, saved.data.application_signatures, 'reopening restores both saved drawings');
    await migrateDrawApplicationSignatures(f.pool);
    await migrateDrawApplicationSignatures(f.pool);
    assert.deepEqual(await getDrawApplicationSignatures(1), saved.data.application_signatures, 'migration is idempotent and retains ink');
    assert.equal((await call(getDraw, { user: agent })).status, 403, 'saved drawings stay private to their network');
    const publicView = await call(publicVerifyDraw, { query: { token: 'signature-test-token' } });
    assert.equal(publicView.status, 200);
    assert.equal(publicView.data.application_signatures, undefined, 'public QR verification never exposes signature images');

    const replaced = await call(saveApplicationSignatures, { body: { ...body,applicant: authority, authority: applicant } });
    assert.equal(replaced.status, 200);
    assert.equal((await f.query('SELECT count(*)::int AS n FROM draw_application_signatures')).rows[0].n, 1);
    const events = (await f.query("SELECT detail FROM draw_events WHERE event_type = 'APPLICATION_SIGNED'")).rows;
    assert.equal(events.length, 2);
    assert.deepEqual(events[0].detail.fields, ['applicant','authority']);
    assert.equal(events[0].detail.form_hash,context.context_hash);
    assert.equal(saved.data.application_signatures.form_snapshot.template.form_title,'Frozen original');
    assert.equal((await f.query('SELECT count(*)::int AS n FROM draw_application_signature_versions')).rows[0].n,2);
    await f.query(`UPDATE application_form_templates SET published=$1,published_revision=2 WHERE site_id=1`,[JSON.stringify({form_title:'New wording'})]);
    assert.equal((await call(saveApplicationSignatures,{body})).status,409,'a stale reviewed version cannot be signed');
    assert.equal((await getDrawApplicationSignatures(1)).form_snapshot.template.form_title,'Frozen original','later publication cannot alter the signed form');
    const latestContext=await applicationSigningContext({id:1,user:admin,db:f.pool});
    assert.equal((await call(saveApplicationSignatures, { body: { ...body,context_hash:latestContext.context_hash, authority: await png({ r: 0, g: 0, b: 0, alpha: 0 }) } })).status, 400);
    assert.deepEqual(await getDrawApplicationSignatures(1), replaced.data.application_signatures, 'a failed replacement preserves earlier signatures');
  } finally { await f.close(); }
});

test('sub-admins need update access to capture application signatures', async () => {
  const middleware = subAdminPermission('booking_draws', 'can_update');
  const user = { id: 2, role: 'sub_admin', grants: { booking_draws: [true, true, false, false] } };
  const denied = await call(middleware, { user });
  assert.equal(denied.status, 403);
});
