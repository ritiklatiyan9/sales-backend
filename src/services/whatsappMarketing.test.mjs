import test from 'node:test';
import assert from 'node:assert/strict';
import { drawFixture } from '../test/drawFixture.mjs';
import { migrateWhatsAppMessages } from '../migrations/039_whatsapp_messages.js';
import { migrateWhatsAppStudio } from '../migrations/040_whatsapp_studio.js';
import { migrateWhatsAppMarketing } from '../migrations/041_whatsapp_marketing.js';
import { migrateWhatsAppTemplateManagement } from '../migrations/042_whatsapp_template_management.js';
import { aws, compileBody, deleteTemplate, drainWhatsApp, updateTemplate } from './whatsapp.service.js';
import { addOptOut, cancelCampaign, deleteMarketingTemplate, updateMarketingTemplate, submitMarketingTemplate, marketingCustomers, marketingState, removeOptOut, startCampaign } from './whatsappMarketing.js';

const admin = { id: 1, role: 'admin' };

test('WhatsApp marketing on isolated PostgreSQL: site audience, approval gate, quota after booking messages, opt-outs, cancel', async () => {
  const f = await drawFixture();
  const saved = Object.fromEntries(['WHATSAPP_ENABLED', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_MARKETING_DAILY_LIMIT', 'WHATSAPP_MEDIA_BUCKET'].map((k) => [k, process.env[k]]));
  const sent = [];
  const fake = async (to, template, params, { media } = {}) => { sent.push({ to, template, params, media: media || null }); return `m-${sent.length}`; };
  const statusOf = async (campaignId) => (await f.query('SELECT ref_id, status, error FROM whatsapp_messages WHERE campaign_id = $1 ORDER BY ref_id', [campaignId])).rows;
  try {
    delete process.env.WHATSAPP_PHONE_NUMBER_ID; // no AWS calls from this test
    delete process.env.WHATSAPP_ENABLED;
    process.env.WHATSAPP_MARKETING_DAILY_LIMIT = '1';
    await f.db.exec('ALTER TABLE members ADD COLUMN whatsapp TEXT');
    for (const migrate of [migrateWhatsAppMessages, migrateWhatsAppStudio, migrateWhatsAppMarketing, migrateWhatsAppMarketing]) await migrate(f.pool);
    await f.db.exec(`
      INSERT INTO members (id, site_id, member_type, status, full_name, phone, whatsapp) VALUES
        (61, 1, 'CLIENT', 'ACTIVE', 'Asha Verma', '9811111111', NULL),
        (62, 1, 'CLIENT', 'ACTIVE', 'Bina Rao', '9822222222', '9833333333'),
        (63, 1, 'CLIENT', 'ACTIVE', 'No Mobile', '12345', NULL),
        (64, 1, 'CLIENT', 'ACTIVE', 'Asha Duplicate', '+91 98111 11111', NULL),
        (65, 1, 'CLIENT', 'ACTIVE', 'Opted Out', '9844444444', NULL),
        (66, 1, 'CLIENT', 'ACTIVE', 'Chetan Das', '9855555555', NULL),
        (67, 1, 'BROKER', 'ACTIVE', 'A Broker', '9866666666', NULL),
        (68, 2, 'CLIENT', 'ACTIVE', 'Other Site', '9877777777', NULL),
        (69, 1, 'CLIENT', 'INACTIVE', 'Inactive', '9888888888', NULL);
      UPDATE whatsapp_templates SET status = 'APPROVED' WHERE event = 'REGISTERED';
    `);
    await migrateWhatsAppTemplateManagement(f.pool);
    const offer = compileBody('MARKETING', 'Hello {customer_name}, Diwali offers are live at {project}. Visit us');
    await f.query(`INSERT INTO whatsapp_templates (event, version, name, body, fields, status, category, site_id, options) VALUES
      ('MARKETING', 1, 'dgg_marketing_1', 'Hello {customer_name}, Diwali offers are live at {project}. Visit us', $1, 'APPROVED', 'MARKETING', 1, '{"title":"Diwali"}'),
      ('MARKETING', 2, 'dgg_marketing_2', 'Pending offer text here', '{}', 'PENDING', 'MARKETING', 1, '{"title":"Pending"}'),
      ('MARKETING', 3, 'dgg_marketing_3', 'Other site offer text', '{}', 'APPROVED', 'MARKETING', 2, '{"title":"Other"}')`, [offer.fields]);
    assert.deepEqual(await addOptOut({ user: admin, phone: '98444 44444', reason: 'Asked on call' }), { phone: '+919844444444' });
    await assert.rejects(addOptOut({ user: admin, phone: '123' }), /valid 10-digit/);

    // One message per valid mobile of this site's active clients; brokers, other sites and opt-outs excluded.
    const state = await marketingState(admin, 1);
    assert.equal(state.configured, false);
    assert.deepEqual(state.audience, { clients: 6, reachable: 3, no_mobile: 1, opted_out: 1 });
    assert.deepEqual(state.templates.map((t) => t.name), ['dgg_marketing_2', 'dgg_marketing_1']);
    assert.deepEqual(state.fields.map((x) => x.sample), ['Rahul Sharma', 'Defence Garden']);
    assert.equal(state.limits.daily, 1);

    await assert.rejects(startCampaign({ user: admin, siteId: 1, templateName: 'dgg_marketing_1' }), /turned off/);
    process.env.WHATSAPP_ENABLED = 'true';
    await assert.rejects(startCampaign({ user: admin, siteId: 1, templateName: 'dgg_marketing_2' }), /not approved/);
    await assert.rejects(startCampaign({ user: admin, siteId: 1, templateName: 'dgg_marketing_3' }), /of this site/);
    const campaign = await startCampaign({ user: admin, siteId: 1, templateName: 'dgg_marketing_1' });
    assert.equal(campaign.recipients, 3);
    await assert.rejects(deleteMarketingTemplate({ user: admin, siteId: 1, name: 'dgg_marketing_1' }), /still sending/);
    await assert.rejects(updateMarketingTemplate({ user: admin, siteId: 1, name: 'dgg_marketing_1', input: { archived: true } }), /still sending/);

    // A booking/KYC message queued after the campaign still goes first; then 1 campaign message (daily limit).
    await f.query(`INSERT INTO whatsapp_messages (dedupe_key, event, ref_id) VALUES ('REGISTERED:66', 'REGISTERED', 66)`);
    await addOptOut({ user: admin, phone: '9833333333' }); // Bina's WhatsApp number, added after the campaign started
    await drainWhatsApp({ send: fake });
    assert.deepEqual(sent.map((s) => s.template), ['dgg_member_id_issued', 'dgg_marketing_1']);
    assert.deepEqual(sent[1], { to: '+919811111111', template: 'dgg_marketing_1', params: ['Asha Verma', 'Defence Garden'], media: null });
    assert.deepEqual((await statusOf(campaign.id)).map((r) => `${r.ref_id}=${r.status}`), ['61=SENT', '62=QUEUED', '66=QUEUED']);

    // Quota spent for 24 hours: the rest waits (campaign rows never expire by age) until the limit allows more.
    await f.query(`UPDATE whatsapp_messages SET created_at = now() - interval '3 days' WHERE campaign_id = $1 AND status = 'QUEUED'`, [campaign.id]);
    await drainWhatsApp({ send: fake });
    assert.equal(sent.length, 2);
    assert.deepEqual((await statusOf(campaign.id)).map((r) => r.status), ['SENT', 'QUEUED', 'QUEUED']);
    process.env.WHATSAPP_MARKETING_DAILY_LIMIT = '10';
    await drainWhatsApp({ send: fake });
    assert.deepEqual(sent.at(-1).params, ['Chetan Das', 'Defence Garden']);
    const done = await statusOf(campaign.id);
    assert.deepEqual(done.map((r) => r.status), ['SENT', 'SKIPPED', 'SENT']);
    assert.match(done[1].error, /do-not-message/);

    // Cancelling skips whatever has not gone yet.
    await removeOptOut('9833333333');
    const second = await startCampaign({ user: admin, siteId: 1, templateName: 'dgg_marketing_1' });
    assert.deepEqual(await cancelCampaign({ user: admin, id: second.id }), { id: second.id, cancelled: 3 });
    await drainWhatsApp({ send: fake });
    assert.deepEqual((await statusOf(second.id)).map((r) => r.error), ['Campaign cancelled', 'Campaign cancelled', 'Campaign cancelled']);
    const listed = (await marketingState(admin, 1)).campaigns;
    assert.deepEqual(listed.map((c) => [c.status, c.sent, c.skipped, c.waiting]), [['CANCELLED', 0, 3, 0], ['SENDING', 2, 1, 0]]);

    // "Choose customers": every active client of the site with whether a campaign can reach them.
    const { customers } = await marketingCustomers(admin, 1);
    assert.deepEqual(Object.fromEntries(customers.map((c) => [c.id, c.status])),
      { 61: 'REACHABLE', 62: 'REACHABLE', 63: 'NO_MOBILE', 64: 'DUPLICATE', 65: 'OPTED_OUT', 66: 'REACHABLE' });
    assert.deepEqual(customers.map((c) => c.name), ['Asha Duplicate', 'Asha Verma', 'Bina Rao', 'Chetan Das', 'No Mobile', 'Opted Out']);
    assert.equal(customers.find((c) => c.id === 62).mobile, '+919833333333');
    // A campaign to chosen customers only; unreachable, opted-out and other-site picks are dropped.
    await assert.rejects(startCampaign({ user: admin, siteId: 1, templateName: 'dgg_marketing_1', memberIds: [63, 65, 68] }), /None of the selected/);
    const chosen = await startCampaign({ user: admin, siteId: 1, templateName: 'dgg_marketing_1', memberIds: [66, 63, 61] });
    assert.equal(chosen.recipients, 2);
    assert.deepEqual((await statusOf(chosen.id)).map((r) => r.ref_id), [61, 66]);
    await cancelCampaign({ user: admin, id: chosen.id });
    // An archive is reversible, scoped to its project, and never available for new sends.
    await assert.rejects(updateTemplate('dgg_marketing_1', { archived: true }), /not found/);
    await assert.rejects(deleteTemplate('dgg_marketing_1'), /not found/);
    await assert.rejects(updateMarketingTemplate({ user: admin, siteId: 2, name: 'dgg_marketing_1', input: { archived: true } }), /not found/);
    await assert.rejects(updateMarketingTemplate({ user: admin, siteId: 1, name: 'dgg_member_id_issued', input: { archived: true } }), /not found/);
    await assert.rejects(deleteMarketingTemplate({ user: admin, siteId: 2, name: 'dgg_marketing_1' }), /not found/);
    const archived = await updateMarketingTemplate({ user: admin, siteId: 1, name: 'dgg_marketing_1', input: { title: 'Diwali invitation', archived: true } });
    assert.ok(archived.archived_at);
    assert.equal(archived.title, 'Diwali invitation');
    const archivedState = await marketingState(admin, 1);
    assert.ok(archivedState.templates.find(t => t.name === archived.name).archived_at);
    assert.equal(archivedState.campaigns.find(c => c.id === campaign.id).template_title, 'Diwali invitation');
    await assert.rejects(startCampaign({ user: admin, siteId: 1, templateName: archived.name }), /archived/);
    const restored = await updateMarketingTemplate({ user: admin, siteId: 1, name: archived.name, input: { archived: false } });
    assert.equal(restored.archived_at, null);
    assert.equal(restored.title, 'Diwali invitation');

    // Edited versions can retain the original image without crossing project boundaries.
    const sdk = aws(), originalSend = sdk.send;
    const requests = [];
    sdk.send = async (command) => {
      requests.push(command);
      const type = command.constructor.name;
      if (type === 'GetLinkedWhatsAppBusinessAccountPhoneNumberCommand') return { linkedWhatsAppBusinessAccountId: 'test-waba', phoneNumber: {} };
      if (type === 'CreateWhatsAppMessageTemplateMediaCommand') return { metaHeaderHandle: 'test-header' };
      if (type === 'CreateWhatsAppMessageTemplateCommand') return { metaTemplateId: 'test-id', templateStatus: 'PENDING', category: 'MARKETING' };
      throw new Error('Unexpected SDK call: '+type);
    };
    try {
      process.env.WHATSAPP_PHONE_NUMBER_ID = 'test-number';
      process.env.WHATSAPP_MEDIA_BUCKET = 'test-media';
      await f.query(`UPDATE whatsapp_templates SET options = options || '{"image_key":"marketing/original.jpg"}'::jsonb WHERE name = 'dgg_marketing_1'`);
      await assert.rejects(submitMarketingTemplate({ user: admin, siteId: 2, title: 'Copy', body: 'Hello, a new offer is available.', sourceTemplateName: 'dgg_marketing_1', reuseImage: true }), /original image is unavailable/);
      await assert.rejects(submitMarketingTemplate({ user: admin, siteId: 1, title: 'Copy', body: 'Hello,\n\n\ninvalid spacing.', sourceTemplateName: 'dgg_marketing_1', reuseImage: true }), /blank line/);
      assert.equal(requests.length, 0, 'invalid copies are rejected before AWS');
      const copy = await submitMarketingTemplate({ user: admin, siteId: 1, title: 'Image copy', body: 'Hello {customer_name}, explore {project}. Visit us.', sourceTemplateName: 'dgg_marketing_1', reuseImage: true });
      assert.equal(copy.title, 'Image copy');
      assert.equal(copy.options.image_key, 'marketing/original.jpg');
      const upload = requests.find(c => c.constructor.name === 'CreateWhatsAppMessageTemplateMediaCommand');
      assert.deepEqual(upload.input.sourceS3File, { bucketName: 'test-media', key: 'marketing/original.jpg' });
      const definition = JSON.parse(Buffer.from(requests.find(c => c.constructor.name === 'CreateWhatsAppMessageTemplateCommand').input.templateDefinition).toString());
      assert.equal(definition.components[0].format, 'IMAGE');
    } finally { sdk.send = originalSend; }

  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await f.close();
  }
});
