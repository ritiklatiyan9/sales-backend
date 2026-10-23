import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { drawFixture } from '../test/drawFixture.mjs';
import { migrateWhatsAppMessages } from '../migrations/039_whatsapp_messages.js';
import { migrateWhatsAppStudio } from '../migrations/040_whatsapp_studio.js';
import { migrateWhatsAppMarketing } from '../migrations/041_whatsapp_marketing.js';
import { migrateWhatsAppTemplateManagement } from '../migrations/042_whatsapp_template_management.js';
import { EVENTS, compileBody, deleteTemplate, drainWhatsApp, queueWhatsApp, saveStage, studioState, toE164, updateTemplate } from './whatsapp.service.js';
import { SAMPLE_RECEIPT, amountInWords, money, receiptTerms, renderDrawReceipt } from './whatsappDocuments.js';

test('toE164 accepts valid Indian mobiles only', () => {
  for (const ok of ['9876543210', '+91 98765-43210', '919876543210', '09876543210']) assert.equal(toE164(ok), '+919876543210');
  for (const bad of [null, '', '12345', '5876543210', '449876543210', 'call 9876543210']) assert.equal(toE164(bad), null);
});

test('Studio text compiles to Meta positional templates and enforces Meta rules', () => {
  for (const [event, spec] of Object.entries(EVENTS)) {
    const { text, fields } = compileBody(event, spec.body);
    assert.deepEqual([...text.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])), fields.map((_, i) => i + 1), event);
    assert.ok(fields.every((name) => spec.fields[name]), event);
  }
  assert.deepEqual(compileBody('BOOKING_CREATED', 'Hi {customer_name}, unit {unit} is yours, {customer_name}. Thanks'),
    { text: 'Hi {{1}}, unit {{2}} is yours, {{3}}. Thanks', fields: ['customer_name', 'unit', 'customer_name'] });
  for (const [body, message] of [
    ['Hi {amount} today.', /not available/],
    ['Hello {customer_name}.', /Start and end/],
    ['{customer_name}, hello', /Start and end/],
    ['Hello {customer_name}', /Start and end/],
    ['Hi {customer_name} {member_id} ok', /between two/],
    ['x'.repeat(1025), /1024/],
    ['Hello,\n\n\nWe received your payment.', /blank line/],
    ['Hello,\r\n \r\n \r\nThank you.', /blank line/],
    ['Hello '+ '🌿'.repeat(11), /11 emojis/],
    ['Hi {{1}}, welcome aboard.', /supported \{field\}/],
    ['Hi {customer_name, welcome aboard.', /supported \{field\}/],
    ['Hi {Customer_name}, welcome aboard.', /supported \{field\}/],
    ['   ', /Write the message/],
  ]) assert.throws(() => compileBody('REGISTERED', body), message);
});

test('payment receipt PDF renders one page with the site terms, ₹ amounts and amount in words', async () => {
  for (const variant of [
    SAMPLE_RECEIPT,
    { ...SAMPLE_RECEIPT, registration_status: 'CANCELLED', narration: 'Second instalment',
      settings: { ...SAMPLE_RECEIPT.settings, document_config: { receipt_terms: '*₹50,000 is non-refundable.*\nPlain clause', receipt_note: 'Project note' } } },
  ]) {
    const pdf = await renderDrawReceipt(variant);
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    assert.equal((pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length, 1, 'fits on one A4 page');
  }
  assert.equal(money(100000), '₹1,00,000.00');
  assert.equal(receiptTerms({})[0], '*₹1,00,000 (Rupees One Lakh only) of the booking amount is non-refundable.*');
  assert.deepEqual(receiptTerms({ receipt_terms: ' A \n\n B ' }), ['A', 'B']);
  assert.equal(amountInWords(1234567.5), 'Rupees Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven and Fifty Paise Only');
});

test('template management migration pins latest approved once and retains existing stage settings', async () => {
  const db = new PGlite();
  try {
    await migrateWhatsAppStudio(db);
    await db.exec(`
      UPDATE whatsapp_templates SET status = 'APPROVED' WHERE event = 'REGISTERED';
      INSERT INTO whatsapp_templates (event, version, name, body, status) VALUES
        ('REGISTERED', 2, 'registered_v2', 'New approved version', 'APPROVED'),
        ('REGISTERED', 3, 'registered_v3', 'Pending version', 'PENDING');
      INSERT INTO whatsapp_stage_settings (event, enabled, attachment, updated_by) VALUES ('KYC_VERIFIED', FALSE, NULL, 17);
    `);
    await migrateWhatsAppTemplateManagement(db);
    const rows = (await db.query('SELECT event, enabled, attachment, template_name, updated_by FROM whatsapp_stage_settings')).rows;
    assert.equal(rows.length, Object.keys(EVENTS).length);
    assert.equal(rows.find((s) => s.event === 'REGISTERED').template_name, 'registered_v2');
    assert.deepEqual(rows.find((s) => s.event === 'KYC_VERIFIED'),
      { event: 'KYC_VERIFIED', enabled: false, attachment: null, template_name: null, updated_by: 17 });
    assert.equal(rows.find((s) => s.event === 'PAYMENT_RECEIVED').attachment, 'DRAW_RECEIPT');
    await db.exec(`
      UPDATE whatsapp_stage_settings SET template_name = NULL WHERE event = 'REGISTERED';
      UPDATE whatsapp_templates SET status = 'APPROVED' WHERE name = 'registered_v3';
    `);
    await migrateWhatsAppTemplateManagement(db);
    assert.equal((await db.query(`SELECT template_name FROM whatsapp_stage_settings WHERE event = 'REGISTERED'`)).rows[0].template_name, null);
    assert.equal((await db.query(`SELECT title FROM whatsapp_templates WHERE name = 'registered_v2'`)).rows[0].title, 'Client registered · v2');
  } finally {
    await db.close();
  }
});

test('WhatsApp outbox on isolated PostgreSQL: stages, approved versions, attachments, skips, failures, expiry', async () => {
  const f = await drawFixture();
  const saved = { enabled: process.env.WHATSAPP_ENABLED, ctx: process.env.NODE_TEST_CONTEXT, phoneId: process.env.WHATSAPP_PHONE_NUMBER_ID };
  const sent = [];
  const uploads = [];
  const fake = async (to, template, params, { media } = {}) => { sent.push({ to, template, params, ...(media ? { media } : {}) }); return `m-${sent.length}`; };
  const upload = async (buffer, filename) => { uploads.push({ pdf: buffer.subarray(0, 5).toString(), filename }); return `media-${uploads.length}`; };
  const row = async (key) => (await f.query('SELECT status, error, phone, provider_message_id FROM whatsapp_messages WHERE dedupe_key = $1', [key])).rows[0];
  const statuses = async () => (await f.query('SELECT dedupe_key, status FROM whatsapp_messages ORDER BY id')).rows
    .map((r) => `${r.dedupe_key}=${r.status}`);
  try {
    await f.db.exec('ALTER TABLE members ADD COLUMN whatsapp TEXT');
    for (const migrate of [migrateWhatsAppMessages, migrateWhatsAppMessages, migrateWhatsAppStudio, migrateWhatsAppStudio, migrateWhatsAppMarketing, migrateWhatsAppMarketing]) await migrate(f.pool);
    // The four templates submitted before the Studio are adopted as version 1; Meta approves them.
    assert.deepEqual((await f.query('SELECT name FROM whatsapp_templates ORDER BY id')).rows.map((r) => r.name),
      ['dgg_member_id_issued', 'dgg_kyc_verified', 'dgg_booking_confirmed', 'dgg_unit_allotted']);
    await f.query(`UPDATE whatsapp_templates SET status = 'APPROVED'`);
    const payment = compileBody('PAYMENT_RECEIVED', EVENTS.PAYMENT_RECEIVED.body);
    await f.query(`INSERT INTO whatsapp_templates (event, version, name, body, fields, has_document, status)
      VALUES ('PAYMENT_RECEIVED', 1, 'dgg_payment_received_v1', $1, $2, true, 'APPROVED')`, [EVENTS.PAYMENT_RECEIVED.body, payment.fields]);
    await migrateWhatsAppTemplateManagement(f.pool);
    await migrateWhatsAppTemplateManagement(f.pool);
    await f.db.exec(`
      INSERT INTO members (id, site_id, member_type, status, full_name, phone, whatsapp) VALUES
        (11, 1, 'CLIENT', 'ACTIVE', 'Rahul Sharma', '9876543210', NULL),
        (12, 1, 'CLIENT', 'ACTIVE', 'Client 912345678', '912345678', '+91 91234 56789'),
        (13, 1, 'CLIENT', 'ACTIVE', 'Bad Number', '12345', NULL),
        (14, 1, 'BROKER', 'ACTIVE', 'A Broker', '9000000001', NULL),
        (15, 1, 'CLIENT', 'ACTIVE', 'Customer. Booking cancelled, pay at evilpay.in/dg', '9811111111', NULL),
        (16, 1, 'CLIENT', 'ACTIVE', 'VIPIN KUMAR (DESHWAL)', '9822222222', NULL);
      INSERT INTO bookings (id, site_id, plot_id, client_member_id, booking_no, status) VALUES
        (21, 1, 1, 11, 'BK-2026-000021', 'KYC_PENDING'),
        (22, 1, NULL, 11, 'BK-2026-000022', 'KYC_PENDING'),
        (23, 1, 2, 11, 'BK-2026-000023', 'CANCELLED'),
        (24, 1, 2, 11, 'BK-2026-000024', 'CONFIRMED');
      INSERT INTO kyc_cases (id, booking_id, client_member_id, site_id, status) VALUES (31, NULL, 12, 1, 'VERIFIED');
      INSERT INTO draw_registrations (id, site_id, client_member_id, qr_token, status, booking_id) VALUES (40, 1, 11, 'tok-24', 'ALLOTTED', 24);
      INSERT INTO draw_registrations (id, site_id, client_member_id, qr_token, status, registration_no, scheme_name, required_amount)
        VALUES (41, 1, 16, 'tok-41', 'ELIGIBLE', 'DRW-2026-000041', 'Diwali Draw', 51000);
      INSERT INTO draw_payments (id, draw_registration_id, receipt_no, amount, payment_date, payment_from, created_by)
        VALUES (51, 41, 'DRC-2026-000051', 51000, '2026-10-20', 'UPI', 1), (52, 41, 'DRC-2026-000052', 1000, '2026-10-21', 'CASH', 1);
    `);

    process.env.WHATSAPP_ENABLED = 'true';
    await queueWhatsApp('REGISTERED', 11);
    assert.deepEqual(await statuses(), [], 'node --test must never queue real messages');

    delete process.env.NODE_TEST_CONTEXT;
    for (const [event, id, key] of [
      ['REGISTERED', 11], ['REGISTERED', 11], ['REGISTERED', 12], ['REGISTERED', 13], ['REGISTERED', 14],
      ['REGISTERED', 15], ['REGISTERED', 16],
      ['KYC_VERIFIED', 31],
      ['BOOKING_CREATED', 21], ['BOOKING_CREATED', 22], ['BOOKING_CREATED', 23],
      ['ALLOTTED', 21, 'ALLOTTED:21:1'], ['ALLOTTED', 22, 'ALLOTTED:22:'], ['ALLOTTED', 24, 'ALLOTTED:24:2'],
      ['PAYMENT_RECEIVED', 51],
    ]) await queueWhatsApp(event, id, key);

    assert.equal(await drainWhatsApp({ send: fake, upload }), 14);
    assert.deepEqual(sent, [
      { to: '+919876543210', template: 'dgg_member_id_issued', params: ['Rahul Sharma', 'Defence Garden', 'CLT-00011'] },
      { to: '+919123456789', template: 'dgg_member_id_issued', params: ['Customer', 'Defence Garden', 'CLT-00012'] },
      { to: '+919811111111', template: 'dgg_member_id_issued', params: ['Customer', 'Defence Garden', 'CLT-00015'] },
      { to: '+919822222222', template: 'dgg_member_id_issued', params: ['VIPIN KUMAR (DESHWAL)', 'Defence Garden', 'CLT-00016'] },
      { to: '+919123456789', template: 'dgg_kyc_verified', params: ['Customer', 'CLT-00012'] },
      { to: '+919876543210', template: 'dgg_booking_confirmed', params: ['Rahul Sharma', 'Defence Garden', 'Plot A-01', 'BK-2026-000021'] },
      { to: '+919876543210', template: 'dgg_booking_confirmed', params: ['Rahul Sharma', 'Defence Garden', 'To be allotted', 'BK-2026-000022'] },
      { to: '+919876543210', template: 'dgg_unit_allotted', params: ['Rahul Sharma', 'Plot A-01', 'Defence Garden', 'BK-2026-000021'] },
      { to: '+919876543210', template: 'dgg_unit_allotted', params: ['Rahul Sharma', 'Shop A-02', 'Defence Garden', 'BK-2026-000024'] },
      { to: '+919822222222', template: 'dgg_payment_received_v1',
        params: ['VIPIN KUMAR (DESHWAL)', 'Defence Garden', '₹51,000.00', 'DRC-2026-000051', '20 Oct 2026', 'UPI', 'DRW-2026-000041'],
        media: { type: 'document', id: 'media-1', filename: 'Receipt-DRC-2026-000051.pdf' } },
    ]);
    assert.deepEqual(uploads, [{ pdf: '%PDF-', filename: 'Receipt-DRC-2026-000051.pdf' }]);
    assert.deepEqual(await statuses(), [
      'REGISTERED:11=SENT', 'REGISTERED:12=SENT', 'REGISTERED:13=SKIPPED', 'REGISTERED:14=SKIPPED',
      'REGISTERED:15=SENT', 'REGISTERED:16=SENT',
      'KYC_VERIFIED:31=SENT', 'BOOKING_CREATED:21=SENT', 'BOOKING_CREATED:22=SENT', 'BOOKING_CREATED:23=SKIPPED',
      'ALLOTTED:21:1=SENT', 'ALLOTTED:22:=SKIPPED', 'ALLOTTED:24:2=SENT', 'PAYMENT_RECEIVED:51=SENT',
    ]);
    assert.equal(await drainWhatsApp({ send: fake, upload }), 0, 'nothing is sent twice');

    // The site's Document Settings "Property type" names the unit.
    await f.query(`INSERT INTO project_settings (site_id, document_config) VALUES (1, '{"property_type":"Commercial Shop"}')
      ON CONFLICT (site_id) DO UPDATE SET document_config = EXCLUDED.document_config`);
    await queueWhatsApp('ALLOTTED', 21, 'ALLOTTED:21:typed');
    await drainWhatsApp({ send: fake, upload });
    assert.deepEqual(sent.at(-1).params, ['Rahul Sharma', 'Commercial Shop A-01', 'Defence Garden', 'BK-2026-000021']);

    // New approval never silently changes the applied version; applying is explicit.
    await f.query(`INSERT INTO whatsapp_templates (event, version, name, body, fields, status) VALUES
      ('BOOKING_CREATED', 2, 'dgg_booking_created_v2', 'Hi {customer_name}.', '{customer_name}', 'APPROVED'),
      ('BOOKING_CREATED', 3, 'dgg_booking_created_v3', 'Hello {customer_name}.', '{customer_name}', 'PENDING')`);
    await queueWhatsApp('BOOKING_CREATED', 21, 'BOOKING_CREATED:21:v2');
    await drainWhatsApp({ send: fake, upload });
    assert.equal(sent.at(-1).template, 'dgg_booking_confirmed');
    await assert.rejects(saveStage('BOOKING_CREATED', { template_name: 'dgg_booking_created_v3' }), /Only Meta-approved/);
    await assert.rejects(saveStage('BOOKING_CREATED', { template_name: 'dgg_kyc_verified' }), /created for this module/);
    await saveStage('BOOKING_CREATED', { template_name: 'dgg_booking_created_v2' }, 1);
    await queueWhatsApp('BOOKING_CREATED', 21, 'BOOKING_CREATED:21:applied');
    await drainWhatsApp({ send: fake, upload });
    assert.deepEqual(sent.at(-1), { to: '+919876543210', template: 'dgg_booking_created_v2', params: ['Rahul Sharma'] });
    await f.query(`UPDATE whatsapp_templates SET status = 'APPROVED' WHERE name = 'dgg_booking_created_v3'`);
    await queueWhatsApp('BOOKING_CREATED', 21, 'BOOKING_CREATED:21:new-approval');
    await drainWhatsApp({ send: fake, upload });
    assert.equal(sent.at(-1).template, 'dgg_booking_created_v2');

    // Applied templates are protected, even on a paused module. Archive is reversible,
    // and an explicit unapply remains unassigned across migration reruns and approvals.
    await saveStage('BOOKING_CREATED', { enabled: false });
    await assert.rejects(updateTemplate('dgg_booking_created_v2', { archived: true }), /Unapply it/);
    await assert.rejects(deleteTemplate('dgg_booking_created_v2'), /Unapply it/);
    await saveStage('BOOKING_CREATED', { enabled: true, template_name: null });
    await f.query(`INSERT INTO whatsapp_messages (dedupe_key, event, ref_id, status)
      VALUES ('BOOKING_CREATED:21:inflight-template', 'BOOKING_CREATED', 21, 'SENDING')`);
    await assert.rejects(deleteTemplate('dgg_booking_created_v2'), /module is still sending/);
    await assert.rejects(updateTemplate('dgg_booking_created_v2', { archived: true }), /module is still sending/);
    await f.query(`UPDATE whatsapp_messages SET status = 'SKIPPED' WHERE dedupe_key = 'BOOKING_CREATED:21:inflight-template'`);
    await migrateWhatsAppTemplateManagement(f.pool);
    const archived = await updateTemplate('dgg_booking_created_v2', { archived: true, title: 'Booking confirmation — current' });
    assert.ok(archived.archived_at);
    assert.equal(archived.title, 'Booking confirmation — current');
    await assert.rejects(saveStage('BOOKING_CREATED', { template_name: archived.name }), /Restore the archived/);
    await queueWhatsApp('BOOKING_CREATED', 21, 'BOOKING_CREATED:21:unassigned');
    const beforeUnassigned = sent.length;
    await drainWhatsApp({ send: fake, upload });
    assert.equal(sent.length, beforeUnassigned);
    assert.match((await row('BOOKING_CREATED:21:unassigned')).error, /No approved template applied/);
    const restored = await updateTemplate(archived.name, { archived: false });
    assert.equal(restored.archived_at, null);
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    assert.equal((await studioState()).stages.find((s) => s.key === 'BOOKING_CREATED').active_template, null);
    await assert.rejects(updateTemplate(archived.name, { title: ' ' }), /title/);
    await assert.rejects(updateTemplate(archived.name, { title: 'x'.repeat(81) }), /80/);
    await assert.rejects(updateTemplate(archived.name, { archived: 'true' }), /true or false/);
    await assert.rejects(updateTemplate('missing', { archived: true }), /not found/);
    await saveStage('BOOKING_CREATED', { template_name: restored.name });

    // Defensive delivery check: an externally archived assignment never falls back.
    await f.query('UPDATE whatsapp_templates SET archived_at = now() WHERE name = $1', [restored.name]);
    await queueWhatsApp('BOOKING_CREATED', 21, 'BOOKING_CREATED:21:externally-archived');
    await drainWhatsApp({ send: fake, upload });
    assert.match((await row('BOOKING_CREATED:21:externally-archived')).error, /No approved template applied/);
    await f.query('UPDATE whatsapp_templates SET archived_at = NULL WHERE name = $1', [restored.name]);

    // Studio switches: a stage turned off, a document template without an attachment, no approved version.
    assert.deepEqual(await saveStage('KYC_VERIFIED', { enabled: false }, 1), { event: 'KYC_VERIFIED', enabled: false, attachment: null, template_name: 'dgg_kyc_verified' });
    await assert.rejects(saveStage('PAYMENT_RECEIVED', { enabled: true, attachment: null }, 1), /Choose an attachment/);
    await f.query(`UPDATE whatsapp_stage_settings SET attachment = NULL WHERE event = 'PAYMENT_RECEIVED'`);
    await f.query(`UPDATE whatsapp_templates SET status = 'REJECTED' WHERE event = 'ALLOTTED'`);
    for (const [event, id] of [['KYC_VERIFIED', 31], ['PAYMENT_RECEIVED', 52], ['ALLOTTED', 24]]) await queueWhatsApp(event, id, `${event}:${id}:switch`);
    const sentBefore = sent.length;
    await drainWhatsApp({ send: fake, upload });
    assert.equal(sent.length, sentBefore);
    assert.match((await row('KYC_VERIFIED:31:switch')).error, /turned off/);
    assert.match((await row('PAYMENT_RECEIVED:52:switch')).error, /choose an attachment/);
    assert.match((await row('ALLOTTED:24:switch')).error, /No approved template/);
    await assert.rejects(saveStage('KYC_VERIFIED', { enabled: true, attachment: 'DRAW_RECEIPT' }), /cannot be attached/);
    await assert.rejects(saveStage('NOPE', { enabled: true }), /Unknown stage/);
    await saveStage('KYC_VERIFIED', { enabled: true }, 1);

    // Studio payload without AWS (no phone number id): stages, versions and settings from the database.
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    const studio = await studioState();
    assert.equal(studio.configured, false);
    assert.deepEqual(studio.stages.map((s) => s.key), Object.keys(EVENTS));
    const paymentStage = studio.stages.find((s) => s.key === 'PAYMENT_RECEIVED');
    assert.deepEqual(paymentStage.documents, [{ key: 'DRAW_RECEIPT', label: 'Payment receipt (PDF)' }]);
    assert.deepEqual(paymentStage.settings, { enabled: true, attachment: null, template_name: 'dgg_payment_received_v1' });
    assert.equal(paymentStage.module, 'Lucky draw');
    assert.equal(paymentStage.submodule, 'Payment receipts');
    assert.equal(paymentStage.trigger, 'New draw ledger payment recorded');
    assert.equal(studio.stages.find((s) => s.key === 'BOOKING_CREATED').active_template.name, 'dgg_booking_created_v2');
    assert.equal(studio.stages.find((s) => s.key === 'BOOKING_CREATED').active_template.title, 'Booking confirmation — current');
    assert.deepEqual(studio.stages.find((s) => s.key === 'BOOKING_CREATED').templates.map((t) => t.name),
      ['dgg_booking_created_v3', 'dgg_booking_created_v2', 'dgg_booking_confirmed']);

    await queueWhatsApp('KYC_VERIFIED', 31, 'KYC_VERIFIED:31:fails');
    await drainWhatsApp({ send: async () => { throw Object.assign(new Error('Template not approved'), { name: 'ValidationException' }); }, upload });
    assert.deepEqual(await row('KYC_VERIFIED:31:fails'),
      { status: 'FAILED', error: 'ValidationException: Template not approved', phone: '+919123456789', provider_message_id: null });

    // Accepted by AWS but the SENT update fails: never relabelled FAILED (a requeue would send twice).
    await queueWhatsApp('KYC_VERIFIED', 31, 'KYC_VERIFIED:31:unrecorded');
    const flaky = { query: (sql, values) => (values?.[1] === 'SENT' ? Promise.reject(new Error('Connection terminated')) : f.query(sql, values)) };
    await drainWhatsApp({ db: flaky, send: fake, upload });
    assert.equal((await row('KYC_VERIFIED:31:unrecorded')).status, 'SENDING');

    // A send cut off mid-flight surfaces as FAILED after 10 minutes; a fresh in-flight one is left alone.
    await f.query(`UPDATE whatsapp_messages SET updated_at = now() - interval '11 minutes' WHERE dedupe_key = 'KYC_VERIFIED:31:unrecorded'`);
    await f.query(`INSERT INTO whatsapp_messages (dedupe_key, event, ref_id, status) VALUES ('REGISTERED:inflight', 'REGISTERED', 11, 'SENDING')`);
    await f.query(`INSERT INTO whatsapp_messages (dedupe_key, event, ref_id, created_at) VALUES ('REGISTERED:old', 'REGISTERED', 11, now() - interval '2 days')`);
    const before = sent.length;
    await drainWhatsApp({ send: fake, upload });
    assert.equal(sent.length, before, 'stranded, in-flight and day-old rows are never auto-sent');
    assert.match((await row('KYC_VERIFIED:31:unrecorded')).error, /^Interrupted while sending/);
    assert.equal((await row('KYC_VERIFIED:31:unrecorded')).status, 'FAILED');
    assert.equal((await row('REGISTERED:inflight')).status, 'SENDING');
    assert.equal((await row('REGISTERED:old')).status, 'EXPIRED');
  } finally {
    for (const [key, value] of [['WHATSAPP_ENABLED', saved.enabled], ['NODE_TEST_CONTEXT', saved.ctx], ['WHATSAPP_PHONE_NUMBER_ID', saved.phoneId]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await f.close();
  }
});
