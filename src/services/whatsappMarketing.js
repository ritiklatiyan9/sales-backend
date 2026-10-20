import { CreateWhatsAppMessageTemplateCommand, CreateWhatsAppMessageTemplateMediaCommand } from '@aws-sdk/client-socialmessaging';
import pool from '../config/db.js';
import { requireSiteAccess } from './bookingWorkspaceAccess.js';
import {
  MARKETING, aws, clean, compileBody, lang, marketingDailyLimit, mediaIdFor, putMedia, refreshTemplates,
  sendWhatsAppTemplate, sender, studioError, toE164, viaAws,
} from './whatsapp.service.js';

/**
 * WhatsApp Marketing: site-based MARKETING templates and bulk campaigns (migration 041).
 * A campaign queues one whatsapp_messages row per reachable customer of the site; the
 * worker in whatsapp.service.js sends them after booking/KYC messages, within the daily
 * marketing limit, skipping numbers on the do-not-message list.
 */

// About ₹1.35 per delivered marketing message to India: Meta $0.0088799 + AWS $0.005
// (AWS WhatsApp rate sheet, 1 Oct 2026, ~₹97 per USD). GST extra. An estimate for the UI.
export const MARKETING_PRICE_INR = 1.35;

const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png' };
const sample = (site, name) => (name === 'project' ? site.name : MARKETING.fields[name].sample);
const buttonText = (value) => {
  const text = String(value).trim();
  if (!text || text.length > 25) throw studioError('Button text must be 1–25 characters');
  return text;
};

/** The site's customers a campaign would reach: one per valid mobile, minus the do-not-message list. */
async function audience(siteId, db) {
  const { rows } = await db.query(
    `SELECT id, phone, whatsapp FROM members
      WHERE site_id = $1 AND member_type = 'CLIENT' AND COALESCE(status, 'ACTIVE') = 'ACTIVE' ORDER BY id`,
    [siteId],
  );
  const blocked = new Set((await db.query('SELECT phone FROM whatsapp_opt_outs')).rows.map((r) => r.phone));
  const seen = new Set();
  const members = [];
  let noMobile = 0;
  let optedOut = 0;
  for (const member of rows) {
    const phone = toE164(member.whatsapp) || toE164(member.phone);
    if (!phone) noMobile += 1;
    else if (blocked.has(phone)) optedOut += 1;
    else if (!seen.has(phone)) { seen.add(phone); members.push(member.id); }
  }
  return { clients: rows.length, reachable: members.length, no_mobile: noMobile, opted_out: optedOut, members };
}

/**
 * Every active client of the site for the "Choose customers" table, with whether a campaign
 * can reach them (same rules as audience()) and a few facts to filter by.
 */
export async function marketingCustomers(user, siteId, db = pool) {
  const site = await requireSiteAccess(user, siteId, db);
  const { rows } = await db.query(
    `SELECT m.id, m.full_name, m.phone, m.whatsapp, k.status AS kyc_status,
            COALESCE(b.n, 0)::int AS bookings, COALESCE(d.n, 0)::int AS draws
       FROM members m
       LEFT JOIN LATERAL (SELECT status FROM kyc_cases WHERE client_member_id = m.id
                           ORDER BY (status = 'VERIFIED') DESC, id DESC LIMIT 1) k ON true
       LEFT JOIN (SELECT client_member_id, count(*) AS n FROM bookings WHERE status <> 'CANCELLED' GROUP BY 1) b ON b.client_member_id = m.id
       LEFT JOIN (SELECT client_member_id, count(*) AS n FROM draw_registrations WHERE status <> 'CANCELLED' GROUP BY 1) d ON d.client_member_id = m.id
      WHERE m.site_id = $1 AND m.member_type = 'CLIENT' AND COALESCE(m.status, 'ACTIVE') = 'ACTIVE'
      ORDER BY m.id`,
    [site.id],
  );
  const blocked = new Set((await db.query('SELECT phone FROM whatsapp_opt_outs')).rows.map((r) => r.phone));
  const seen = new Set();
  const customers = rows.map((r) => {
    const mobile = toE164(r.whatsapp) || toE164(r.phone);
    const status = !mobile ? 'NO_MOBILE' : blocked.has(mobile) ? 'OPTED_OUT' : seen.has(mobile) ? 'DUPLICATE' : 'REACHABLE';
    if (status === 'REACHABLE') seen.add(mobile);
    return { id: r.id, name: r.full_name, mobile: mobile || r.phone || null, kyc_status: r.kyc_status, bookings: r.bookings, draws: r.draws, status };
  });
  return { site, customers: customers.sort((a, b) => String(a.name).localeCompare(String(b.name))) };
}

async function siteTemplate(siteId, name, db) {
  const { rows: [template] } = await db.query(
    `SELECT name, fields, status, options FROM whatsapp_templates
      WHERE name = $1 AND event = 'MARKETING' AND site_id = $2 AND status <> 'DELETED'`,
    [name, siteId],
  );
  if (!template) throw studioError('Choose a marketing template of this site', 404);
  if (template.status !== 'APPROVED') throw studioError('Meta has not approved this template yet', 409);
  return template;
}

const headerImage = async (template) => (template.options?.image_key
  ? { type: 'image', id: await viaAws(mediaIdFor({ bucketName: process.env.WHATSAPP_MEDIA_BUCKET, key: template.options.image_key })) }
  : null);

/** Everything the Marketing page shows for one site. Refreshes Meta review statuses first. */
export async function marketingState(user, siteId, db = pool) {
  const site = await requireSiteAccess(user, siteId, db);
  const configured = Boolean(process.env.WHATSAPP_PHONE_NUMBER_ID);
  let error = null;
  if (configured) {
    try { await refreshTemplates(db); } catch (e) { error = `${e.name}: ${e.message}`; }
  }
  const { rows: templates } = await db.query(
    `SELECT version, name, body, fields, status, category, rejected_reason, options, created_at FROM whatsapp_templates
      WHERE event = 'MARKETING' AND site_id = $1 AND status <> 'DELETED' ORDER BY version DESC`,
    [site.id],
  );
  const { rows: campaigns } = await db.query(
    `SELECT c.id, c.template_name, c.status, c.recipients, c.created_at,
            count(*) FILTER (WHERE m.status = 'SENT')::int AS sent,
            count(*) FILTER (WHERE m.status IN ('QUEUED', 'SENDING'))::int AS waiting,
            count(*) FILTER (WHERE m.status = 'SKIPPED')::int AS skipped,
            count(*) FILTER (WHERE m.status IN ('FAILED', 'EXPIRED'))::int AS failed
       FROM whatsapp_campaigns c LEFT JOIN whatsapp_messages m ON m.campaign_id = c.id
      WHERE c.site_id = $1 GROUP BY c.id ORDER BY c.id DESC LIMIT 20`,
    [site.id],
  );
  const { rows: optOuts } = await db.query('SELECT phone, reason, created_at FROM whatsapp_opt_outs ORDER BY created_at DESC LIMIT 500');
  const { rows: [{ sent }] } = await db.query(`SELECT count(*)::int AS sent FROM whatsapp_messages
      WHERE campaign_id IS NOT NULL AND status = 'SENT' AND updated_at > now() - interval '1 day'`);
  const { members, ...reach } = await audience(site.id, db);
  return {
    site,
    enabled: process.env.WHATSAPP_ENABLED === 'true',
    configured,
    error,
    media_bucket: Boolean(process.env.WHATSAPP_MEDIA_BUCKET),
    fields: Object.entries(MARKETING.fields).map(([name, f]) => ({ name, label: f.label, sample: sample(site, name) })),
    templates,
    campaigns,
    opt_outs: optOuts,
    audience: reach,
    limits: { daily: marketingDailyLimit(), sent_24h: sent },
    price_inr: MARKETING_PRICE_INR,
  };
}

/** Submit a MARKETING template for this site: body with {fields}, optional image header and buttons. */
export async function submitMarketingTemplate({ user, siteId, title, body, image = null, website = {}, call = {} }, db = pool) {
  const site = await requireSiteAccess(user, siteId, db);
  const label = String(title || '').trim();
  if (!label || label.length > 60) throw studioError('Give the template a title (up to 60 characters)');
  const { text, fields } = compileBody('MARKETING', body);
  const buttons = [];
  if (website.url || website.text) {
    if (!/^https?:\/\/\S+$/i.test(website.url || '') || website.url.length > 2000) throw studioError('The website button needs a full https:// link');
    buttons.push({ type: 'URL', text: buttonText(website.text || 'Visit website'), url: website.url });
  }
  if (call.phone || call.text) {
    const phone = toE164(call.phone);
    if (!phone) throw studioError('The call button needs a valid 10-digit Indian mobile number');
    buttons.push({ type: 'PHONE_NUMBER', text: buttonText(call.text || 'Call us'), phone_number: phone });
  }
  if (image && !IMAGE_TYPES[image.mimetype]) throw studioError('The image must be a JPG or PNG');
  if (image && image.size > 5 * 1024 * 1024) throw studioError('The image must be 5 MB or smaller (WhatsApp limit)');

  const { wabaId } = await viaAws(sender());
  const components = [];
  let imageKey = null;
  if (image) {
    const stored = await putMedia(image.buffer, `header.${IMAGE_TYPES[image.mimetype]}`, { contentType: image.mimetype, prefix: 'marketing' });
    imageKey = stored.key;
    const { metaHeaderHandle } = await viaAws(aws().send(new CreateWhatsAppMessageTemplateMediaCommand({ id: wabaId, sourceS3File: stored })));
    components.push({ type: 'HEADER', format: 'IMAGE', example: { header_handle: [metaHeaderHandle] } });
  }
  components.push({ type: 'BODY', text, ...(fields.length ? { example: { body_text: [fields.map((name) => sample(site, name))] } } : {}) });
  if (buttons.length) components.push({ type: 'BUTTONS', buttons });

  const { rows: [{ version }] } = await db.query(`SELECT COALESCE(MAX(version), 0) + 1 AS version FROM whatsapp_templates WHERE event = 'MARKETING'`);
  const name = `dgg_marketing_${version}`;
  const created = await viaAws(aws().send(new CreateWhatsAppMessageTemplateCommand({
    id: wabaId,
    templateDefinition: Buffer.from(JSON.stringify({ name, language: lang(), category: 'MARKETING', parameter_format: 'positional', components })),
  })));
  const options = { title: label, image_key: imageKey, buttons };
  const { rows: [row] } = await db.query(
    `INSERT INTO whatsapp_templates (event, version, name, body, fields, status, category, meta_template_id, created_by, site_id, options)
     VALUES ('MARKETING', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING version, name, body, fields, status, category, rejected_reason, options, created_at`,
    [version, name, String(body).trim(), fields, created.templateStatus || 'PENDING', created.category || 'MARKETING',
      created.metaTemplateId, user?.id || null, site.id, JSON.stringify(options)],
  );
  return row;
}

/** Send an approved marketing template, with sample values, to one number. */
export async function sendMarketingTest({ user, siteId, templateName, phone }, db = pool) {
  const site = await requireSiteAccess(user, siteId, db);
  const to = toE164(phone);
  if (!to) throw studioError('Enter a valid 10-digit Indian mobile number');
  const template = await siteTemplate(site.id, templateName, db);
  const params = template.fields.map((name) => clean(sample(site, name)));
  const messageId = await viaAws(sendWhatsAppTemplate(to, template.name, params, { media: await headerImage(template) }));
  return { to, template: template.name, message_id: messageId };
}

/**
 * Queue an approved template for every reachable customer of the site, or only for the
 * chosen `memberIds` (unreachable, opted-out and other-site ids are dropped).
 */
export async function startCampaign({ user, siteId, templateName, memberIds = null }, db = pool) {
  const site = await requireSiteAccess(user, siteId, db);
  if (process.env.WHATSAPP_ENABLED !== 'true') throw studioError('Customer messages are turned off on this server (WHATSAPP_ENABLED)', 409);
  const template = await siteTemplate(site.id, templateName, db);
  let { members } = await audience(site.id, db);
  if (memberIds) {
    const chosen = new Set(memberIds.map(Number));
    members = members.filter((id) => chosen.has(id));
    if (!members.length) throw studioError('None of the selected customers can be messaged', 409);
  }
  if (!members.length) throw studioError('No customer of this site has a valid mobile number', 409);
  const media = await headerImage(template); // one upload, reused for every recipient (valid 30 days)
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: [campaign] } = await client.query(
      `INSERT INTO whatsapp_campaigns (site_id, template_name, media_id, recipients, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, template_name, status, recipients, created_at`,
      [site.id, template.name, media?.id || null, members.length, user?.id || null],
    );
    await client.query(
      `INSERT INTO whatsapp_messages (dedupe_key, event, ref_id, campaign_id)
       SELECT $1::text || id, 'MARKETING', id, $3::int FROM unnest($2::int[]) AS id ON CONFLICT (dedupe_key) DO NOTHING`,
      [`CAMPAIGN:${campaign.id}:`, members, campaign.id],
    );
    await client.query('COMMIT');
    return campaign;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Stop a campaign: messages not yet sent are skipped. */
export async function cancelCampaign({ user, id }, db = pool) {
  const { rows: [campaign] } = await db.query('SELECT id, site_id FROM whatsapp_campaigns WHERE id = $1', [Number(id) || 0]);
  if (!campaign) throw studioError('Campaign not found', 404);
  await requireSiteAccess(user, campaign.site_id, db);
  await db.query(`UPDATE whatsapp_campaigns SET status = 'CANCELLED', cancelled_at = now() WHERE id = $1`, [campaign.id]);
  const { rows } = await db.query(
    `UPDATE whatsapp_messages SET status = 'SKIPPED', error = 'Campaign cancelled', updated_at = now()
      WHERE campaign_id = $1 AND status = 'QUEUED' RETURNING id`,
    [campaign.id],
  );
  return { id: campaign.id, cancelled: rows.length };
}

/** Do-not-message list (all sites): marketing skips these numbers; booking/KYC updates still go. */
export async function addOptOut({ user, phone, reason }, db = pool) {
  const e164 = toE164(phone);
  if (!e164) throw studioError('Enter a valid 10-digit Indian mobile number');
  await db.query(
    `INSERT INTO whatsapp_opt_outs (phone, reason, created_by) VALUES ($1, $2, $3)
     ON CONFLICT (phone) DO UPDATE SET reason = EXCLUDED.reason`,
    [e164, String(reason || '').trim().slice(0, 200) || null, user?.id || null],
  );
  return { phone: e164 };
}

export async function removeOptOut(phone, db = pool) {
  const e164 = toE164(phone);
  if (!e164) throw studioError('Enter a valid 10-digit Indian mobile number');
  await db.query('DELETE FROM whatsapp_opt_outs WHERE phone = $1', [e164]);
  return { phone: e164 };
}
