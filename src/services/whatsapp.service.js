import { randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  SocialMessagingClient, SendWhatsAppMessageCommand, PostWhatsAppMessageMediaCommand,
  CreateWhatsAppMessageTemplateCommand, CreateWhatsAppMessageTemplateMediaCommand,
  ListWhatsAppMessageTemplatesCommand, GetWhatsAppMessageTemplateCommand, DeleteWhatsAppMessageTemplateCommand,
  GetLinkedWhatsAppBusinessAccountPhoneNumberCommand,
} from '@aws-sdk/client-socialmessaging';
import pool from '../config/db.js';
import { normalizeClientPhone } from './clientRegistry.service.js';
import { memberCodeSql } from './memberCodes.js';
import { DOCUMENTS, formatDate, money } from './whatsappDocuments.js';

/**
 * Customer WhatsApp notifications via AWS End User Messaging Social.
 *
 * Hooks call queueWhatsApp(event, id) AFTER their transaction commits; that only
 * inserts a QUEUED row into whatsapp_messages (migration 039). Accounting's KYC verify
 * inserts the same rows directly. startWhatsAppWorker() drains the queue: it checks the
 * stage's WhatsApp Studio settings (migration 040), picks the newest APPROVED template
 * version, looks the customer up, attaches the stage's PDF when the template has a
 * document header, sends, and records SENT / FAILED / SKIPPED. WhatsApp can never fail
 * or slow down a booking request.
 *
 * Env (see .env.example): WHATSAPP_ENABLED=true, WHATSAPP_PHONE_NUMBER_ID,
 * WHATSAPP_MEDIA_BUCKET (S3 bucket in the WhatsApp account + region, for PDFs), optional
 * WHATSAPP_AWS_ACCESS_KEY_ID/SECRET, WHATSAPP_AWS_REGION, WHATSAPP_TEMPLATE_LANG,
 * WHATSAPP_META_API_VERSION.
 */

// Accounting labels every unit 'plot' and plot_no already carries the block ('A1').
// The site's Document Settings "Property type" wins; draw allotments are shops.
const BOOKING_SQL = `SELECT b.booking_no, m.full_name, m.phone, m.whatsapp, ${memberCodeSql('m')} AS member_code,
       s.name AS site_name, p.plot_no,
       COALESCE(NULLIF(btrim(to_jsonb(ps)->'document_config'->>'property_type'), ''),
                CASE WHEN EXISTS (SELECT 1 FROM draw_registrations r WHERE r.booking_id = b.id) THEN 'Shop' ELSE 'Plot' END) AS unit_label
  FROM bookings b
  JOIN members m ON m.id = b.client_member_id AND 'CLIENT' = ANY(COALESCE(m.member_types, ARRAY[m.member_type]))
  JOIN sites s ON s.id = b.site_id
  LEFT JOIN plots p ON p.id = b.plot_id
  LEFT JOIN project_settings ps ON ps.site_id = b.site_id
 WHERE b.id = $1 AND b.status <> 'CANCELLED'`;

// Agents type names too, and this text goes out from the business number: only a plain name
// (no digits, links or long text) is used. The quick-add '<Role> <mobile>' placeholder and
// anything else become 'Customer'.
const customerName = (name) => {
  const n = String(name ?? '').replace(/\s+/g, ' ').trim();
  return /^[\p{L}\p{M} .'()-]{2,60}$/u.test(n) && !/\p{L}\.\p{L}{2}/u.test(n) ? n : 'Customer';
};
const unitName = (d) => (d.plot_no ? `${d.unit_label} ${d.plot_no}` : null);

// Brand frame shared by the default templates (WhatsApp *bold* / _italic_ markup).
const branded = (...parts) => [
  '🏛️ *DEFENCE GARDEN GROUP*\n_Foundations for Generations._',
  ...parts,
  '🌐 www.defencegarden.com\n📞 +91 9917665577\n\n*Team Defence Garden Group* 🌿',
].join('\n\n');

// Fields a template can use as {name}. `sample` feeds Meta's review and the Studio preview.
const field = (label, sample, value) => ({ label, sample, value });
const CUSTOMER = {
  customer_name: field('Customer name', 'Rahul Sharma', (d) => customerName(d.full_name)),
  member_id: field('Member ID', 'CLT-00123', (d) => d.member_code),
  project: field('Project', 'Mount Valley Residency', (d) => d.site_name),
};
const BOOKING = {
  booking_no: field('Booking number', 'BK-2026-000123', (d) => d.booking_no),
  unit: field('Unit', 'Plot A12', (d) => unitName(d) || 'To be allotted'),
};
const PAYMENT = {
  amount: field('Amount', '₹1,00,000.00', (d) => money(d.amount)),
  receipt_no: field('Receipt number', 'DRC-2026-000007', (d) => d.receipt_no),
  payment_date: field('Payment date', '20 Oct 2026', (d) => formatDate(d.payment_date)),
  payment_mode: field('Payment mode', 'UPI', (d) => d.payment_from),
  registration_no: field('Registration number', 'DRW-2026-000016', (d) => d.registration_no),
};

/**
 * The stages a message can follow. `body` is the default template (Studio "Reset"); the
 * live text, versions and approval status live in whatsapp_templates. `attachment` is the
 * stage's default document (DOCUMENTS key).
 */
export const EVENTS = {
  REGISTERED: {
    label: 'Client registered',
    description: 'A new client is added from New Clients, quick KYC or the paper KYC form.',
    fields: CUSTOMER,
    body: branded(
      '🆔 *Member ID Issued*',
      'Dear *{customer_name}*,',
      'Your customer record has been created at *{project}*.',
      '🆔 *Member ID:* {member_id}\n📄 *KYC Status:* Pending',
      'Please quote this Member ID for your KYC, payments and booking.',
    ),
    sql: `SELECT m.full_name, m.phone, m.whatsapp, s.name AS site_name, ${memberCodeSql('m')} AS member_code
            FROM members m JOIN sites s ON s.id = m.site_id
           WHERE m.id = $1 AND 'CLIENT' = ANY(COALESCE(m.member_types, ARRAY[m.member_type]))`,
  },
  KYC_VERIFIED: {
    label: 'KYC verified',
    description: 'A client’s KYC is verified, in the booking app or in Accountancy.',
    fields: CUSTOMER,
    body: branded(
      '🎉 *Welcome to Defence Garden!*',
      'Dear *{customer_name}*,',
      'Congratulations! 🎉 *Your registration and KYC verification have been successfully completed.*',
      '✅ *Registration:* Successful\n🛡️ *KYC Status:* Verified\n🆔 *Member ID:* {member_id}',
      'Your account is now officially verified and ready to use.',
      '🤝 We are delighted to welcome you to the *Defence Garden family*, where trust builds lasting relationships.',
    ),
    sql: `SELECT m.full_name, m.phone, m.whatsapp, s.name AS site_name, ${memberCodeSql('m')} AS member_code
            FROM kyc_cases k
            JOIN members m ON m.id = k.client_member_id AND 'CLIENT' = ANY(COALESCE(m.member_types, ARRAY[m.member_type]))
            JOIN sites s ON s.id = COALESCE(k.site_id, m.site_id)
           WHERE k.id = $1`,
  },
  PAYMENT_RECEIVED: {
    label: 'Draw payment received',
    description: 'A payment is added to a lucky-draw ledger. Can attach the payment receipt PDF.',
    fields: { ...CUSTOMER, ...PAYMENT },
    attachment: 'DRAW_RECEIPT',
    body: branded(
      '💳 *Payment Received*',
      'Dear *{customer_name}*,',
      'Thank you! We have received your payment for *{project}*.',
      '💰 *Amount:* {amount}\n🧾 *Receipt No:* {receipt_no}\n📅 *Date:* {payment_date}\n💳 *Mode:* {payment_mode}\n🎫 *Registration No:* {registration_no}',
      'Your payment receipt is attached. Please keep it safe for future reference.',
    ),
    sql: `SELECT dp.id, dp.receipt_no, dp.payment_date, dp.amount::float AS amount, dp.payment_from, dp.cheque_no,
                 dp.bank_details, dp.bank_name, dp.branch, dp.received_by, dp.narration, u.name AS created_by_name,
                 r.registration_no, r.scheme_name, r.required_amount::float AS required_amount, r.draw_opening_date,
                 r.status AS registration_status, m.full_name, m.phone, m.whatsapp, ${memberCodeSql('m')} AS member_code,
                 s.name AS site_name, to_jsonb(ps) AS settings
            FROM draw_payments dp
            JOIN draw_registrations r ON r.id = dp.draw_registration_id
            JOIN members m ON m.id = r.client_member_id AND 'CLIENT' = ANY(COALESCE(m.member_types, ARRAY[m.member_type]))
            JOIN sites s ON s.id = r.site_id
            LEFT JOIN project_settings ps ON ps.site_id = r.site_id
            LEFT JOIN users u ON u.id = dp.created_by
           WHERE dp.id = $1`,
  },
  BOOKING_CREATED: {
    label: 'Booking made',
    description: 'A booking is created, or a website booking request is approved.',
    fields: { ...CUSTOMER, ...BOOKING },
    body: branded(
      '🏡 *Booking Confirmed*',
      'Dear *{customer_name}*,',
      'Your booking has been recorded successfully.',
      '🏢 *Project:* {project}\n📍 *Unit:* {unit}\n🔖 *Booking No:* {booking_no}',
      'Please keep this booking number for all future communication with us.',
    ),
    sql: BOOKING_SQL,
  },
  ALLOTTED: {
    label: 'Plot / shop allotted',
    description: 'A draw winner is allotted a unit, or a unit is assigned or changed on a booking.',
    fields: { ...CUSTOMER, ...BOOKING },
    body: branded(
      '🔑 *Allotment Confirmed*',
      'Dear *{customer_name}*,',
      'Congratulations! 🎉 Your unit has been allotted to you successfully.',
      '📍 *Unit:* {unit}\n🏢 *Project:* {project}\n🔖 *Booking No:* {booking_no}',
      'Our office will contact you about the allotment letter and next steps.',
    ),
    sql: `${BOOKING_SQL} AND b.plot_id IS NOT NULL`,
  },
};

/** Fields a marketing template can use; campaign messages look the customer up by member id. */
export const MARKETING = {
  label: 'Marketing',
  fields: { customer_name: CUSTOMER.customer_name, project: CUSTOMER.project },
  sql: `SELECT m.full_name, m.phone, m.whatsapp, s.name AS site_name
          FROM members m JOIN sites s ON s.id = m.site_id
         WHERE m.id = $1 AND 'CLIENT' = ANY(COALESCE(m.member_types, ARRAY[m.member_type]))`,
};
const specOf = (event) => EVENTS[event] || (event === 'MARKETING' ? MARKETING : null);

export const studioError = (message, status = 400) => Object.assign(new Error(message), { status });

/**
 * Studio text uses {field} tokens; Meta wants {{1}}..{{n}}. Each occurrence becomes the next
 * number, and `fields` records which value fills it at send time.
 */
export function compileBody(event, body) {
  const spec = specOf(event);
  if (!spec) throw studioError('Unknown stage', 404);
  const fields = [];
  const text = String(body ?? '').trim().replace(/\{([a-z_]+)\}/g, (token, name) => {
    if (!spec.fields[name]) throw studioError(`{${name}} is not available for "${spec.label}"`);
    fields.push(name);
    return `{{${fields.length}}}`;
  });
  if (!text) throw studioError('Write the message text');
  if (text.length > 1024) throw studioError(`The message is ${text.length} characters; WhatsApp allows 1024`);
  if (/^\{\{/.test(text) || /\}\}[^\p{L}\p{N}]*$/u.test(text)) throw studioError('Start and end the message with text, not a {field}');
  if (/\}\}\s*\{\{/.test(text)) throw studioError('Put some text between two {fields}');
  return { text, fields };
}

/** '+91XXXXXXXXXX' for a valid Indian mobile (the strict client-registration rule), else null. */
export const toE164 = (value) => {
  try {
    const digits = normalizeClientPhone(value, { strict: true });
    return digits ? `+91${digits}` : null;
  } catch {
    return null;
  }
};

// WhatsApp rejects empty template parameters and newlines/tabs inside them.
export const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim() || '-';
export const lang = () => process.env.WHATSAPP_TEMPLATE_LANG || 'en';

/**
 * Queue one customer message. Call it AFTER the business transaction commits and never
 * await it in a request: it cannot throw, and the dedupe key makes repeats harmless.
 * Off unless WHATSAPP_ENABLED=true; never runs under `node --test` (tests load the real .env).
 */
export async function queueWhatsApp(event, refId, dedupeKey = `${event}:${refId}`) {
  if (process.env.WHATSAPP_ENABLED !== 'true' || process.env.NODE_TEST_CONTEXT) return;
  try {
    await pool.query(
      'INSERT INTO whatsapp_messages (dedupe_key, event, ref_id) VALUES ($1, $2, $3) ON CONFLICT (dedupe_key) DO NOTHING',
      [dedupeKey, event, Number(refId)],
    );
  } catch (error) {
    console.error(`[whatsapp] queue ${dedupeKey} failed:`, error.message);
  }
}

/** WhatsApp can live in another AWS account than S3: WHATSAPP_AWS_* keys win, else the default chain. */
export const whatsappAwsConfig = () => ({
  region: process.env.WHATSAPP_AWS_REGION || process.env.AWS_REGION || 'ap-south-1',
  ...(process.env.WHATSAPP_AWS_ACCESS_KEY_ID ? {
    credentials: {
      accessKeyId: process.env.WHATSAPP_AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.WHATSAPP_AWS_SECRET_ACCESS_KEY,
    },
  } : {}),
});

let social = null;
let storage = null;
export const aws = () => (social ??= new SocialMessagingClient(whatsappAwsConfig()));

let senderCache = null;
/** The linked number and its WhatsApp Business Account id (cached 10 minutes). */
export async function sender() {
  if (!senderCache || Date.now() - senderCache.at > 600_000) {
    const out = await aws().send(new GetLinkedWhatsAppBusinessAccountPhoneNumberCommand({ id: process.env.WHATSAPP_PHONE_NUMBER_ID }));
    senderCache = {
      at: Date.now(), wabaId: out.linkedWhatsAppBusinessAccountId,
      number: out.phoneNumber?.displayPhoneNumber, name: out.phoneNumber?.displayPhoneNumberName, quality: out.phoneNumber?.qualityRating,
    };
  }
  return senderCache;
}

/**
 * Media goes through S3 (bucket in the WhatsApp account and region, per AWS) before Meta.
 * `whatsapp/` expires after 30 days (per-message PDFs); `marketing/` keeps campaign images.
 */
export async function putMedia(buffer, filename, { contentType = 'application/pdf', prefix = 'whatsapp' } = {}) {
  const bucketName = process.env.WHATSAPP_MEDIA_BUCKET;
  if (!bucketName) throw studioError('Set WHATSAPP_MEDIA_BUCKET to send documents or images on WhatsApp', 409);
  const key = `${prefix}/${new Date().toISOString().slice(0, 7)}/${randomUUID()}-${filename.replace(/[^\w.-]/g, '_')}`;
  storage ??= new S3Client(whatsappAwsConfig());
  await storage.send(new PutObjectCommand({ Bucket: bucketName, Key: key, Body: buffer, ContentType: contentType }));
  return { bucketName, key };
}

/** Hand a stored S3 file to WhatsApp; resolves with the media id (valid 30 days). */
export async function mediaIdFor(sourceS3File) {
  const { mediaId } = await aws().send(new PostWhatsAppMessageMediaCommand({
    originationPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID, sourceS3File,
  }));
  return mediaId;
}

/** Upload a PDF for one message; resolves with the WhatsApp media id. */
export async function uploadWhatsAppMedia(buffer, filename) {
  return mediaIdFor(await putMedia(buffer, filename));
}

/**
 * Send an APPROVED template. `media` fills a document or image header:
 * { type: 'document', id, filename } or { type: 'image', id }.
 * Resolves with AWS's message id (accepted by AWS, not yet delivered).
 */
export async function sendWhatsAppTemplate(to, template, params = [], { lang: language = lang(), ref, media } = {}) {
  const header = media && (media.type === 'image' ? { id: media.id } : { id: media.id, filename: media.filename });
  const components = [
    ...(media ? [{ type: 'header', parameters: [{ type: media.type, [media.type]: header }] }] : []),
    ...(params.length ? [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }] : []),
  ];
  const message = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: { name: template, language: { code: language }, ...(components.length ? { components } : {}) },
    ...(ref ? { biz_opaque_callback_data: ref } : {}),
  };
  const { messageId } = await aws().send(new SendWhatsAppMessageCommand({
    originationPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    // AWS's docs still show v20.0, which Meta retired on 2026-09-24.
    metaApiVersion: process.env.WHATSAPP_META_API_VERSION || 'v23.0',
    message: Buffer.from(JSON.stringify(message)),
  }));
  return messageId;
}

async function stageSettings(event, db = pool) {
  const { rows: [row] } = await db.query('SELECT enabled, attachment FROM whatsapp_stage_settings WHERE event = $1', [event]);
  return row || { enabled: true, attachment: EVENTS[event]?.attachment || null };
}

/** The newest APPROVED version of a stage's template; older approved versions keep working until then. */
async function activeTemplate(event, db = pool) {
  const { rows: [row] } = await db.query(
    `SELECT name, fields, has_document FROM whatsapp_templates WHERE event = $1 AND status = 'APPROVED' ORDER BY version DESC LIMIT 1`,
    [event],
  );
  return row || null;
}

// The stage's chosen document, when it can follow this stage.
async function stageDocument(event, db) {
  const { attachment } = await stageSettings(event, db);
  const doc = DOCUMENTS[attachment];
  return doc?.events.includes(event) ? doc : null;
}

// A stage message (row.event) or one customer of a marketing campaign (row.campaign_id).
async function deliver(row, { db, send, upload }) {
  let template = null;
  let phone = null;
  let messageId;
  const finish = (status, error = null) => db.query(
    `UPDATE whatsapp_messages SET status = $2, phone = $3, template = $4, provider_message_id = $5, error = $6, updated_at = now()
      WHERE id = $1`,
    [row.id, status, phone, template?.name || null, messageId || null, error && String(error).slice(0, 500)],
  );
  const lookup = async (spec) => {
    const data = (await db.query(spec.sql, [row.ref_id])).rows[0];
    phone = data && (toE164(data.whatsapp) || toE164(data.phone));
    return data;
  };
  try {
    let spec;
    let data;
    let media = null;
    if (row.campaign_id) {
      spec = MARKETING;
      const { rows: [campaign] } = await db.query(
        `SELECT c.status, c.media_id, t.name, t.fields FROM whatsapp_campaigns c
           JOIN whatsapp_templates t ON t.name = c.template_name WHERE c.id = $1`,
        [row.campaign_id],
      );
      if (!campaign || campaign.status === 'CANCELLED') return await finish('SKIPPED', 'Campaign cancelled');
      template = campaign;
      data = await lookup(spec);
      if (!phone) return await finish('SKIPPED', data ? 'No valid Indian mobile on the client' : 'No matching client record');
      if ((await db.query('SELECT 1 FROM whatsapp_opt_outs WHERE phone = $1', [phone])).rows.length) {
        return await finish('SKIPPED', 'Customer is on the do-not-message list');
      }
      if (campaign.media_id) media = { type: 'image', id: campaign.media_id };
    } else {
      spec = EVENTS[row.event];
      if (!spec) return await finish('SKIPPED', `Unknown event ${row.event}`);
      if (!(await stageSettings(row.event, db)).enabled) return await finish('SKIPPED', 'Stage is turned off in WhatsApp Studio');
      template = await activeTemplate(row.event, db);
      if (!template) return await finish('SKIPPED', 'No approved template for this stage yet');
      data = await lookup(spec);
      if (!phone) return await finish('SKIPPED', data ? 'No valid Indian mobile on the client' : 'No matching client record');
      if (template.has_document) {
        const doc = await stageDocument(row.event, db);
        if (!doc) return await finish('SKIPPED', 'This template sends a document: choose an attachment in WhatsApp Studio');
        const filename = doc.filename(data);
        media = { type: 'document', id: await upload(await doc.render(data), filename), filename };
      }
    }
    const params = template.fields.map((name) => clean(spec.fields[name].value(data)));
    messageId = await send(phone, template.name, params, { ref: `wa:${row.id}`, media });
  } catch (error) {
    // ponytail: no auto-retry. The SDK already retries throttling/5xx; what is left is
    // permanent (template not approved, IAM, wrong number id). Fix it, then requeue by SQL.
    console.error(`[whatsapp] ${row.event} #${row.ref_id} failed: ${error.name}: ${error.message}`);
    return finish('FAILED', `${error.name}: ${error.message}`).catch(() => {});
  }
  // AWS accepted it: a bookkeeping error must not relabel it FAILED (a requeue would send it twice).
  await finish('SENT')
    .catch((error) => console.error(`[whatsapp] #${row.id} sent (${messageId}) but not recorded: ${error.message}`));
}

/**
 * Marketing messages per rolling 24 hours. Meta lets an unverified business message 250
 * different people a day in total; the default leaves room for booking/KYC updates.
 */
export const marketingDailyLimit = () => Number(process.env.WHATSAPP_MARKETING_DAILY_LIMIT) || 200;

/** Send up to `max` queued rows, one claim at a time (SKIP LOCKED keeps several API instances apart). */
export async function drainWhatsApp({ db = pool, send = sendWhatsAppTemplate, upload = uploadWhatsAppMedia, max = 20 } = {}) {
  // A row still SENDING after 10 minutes was cut off mid-send (deploy, crash): surface it, never auto-resend.
  await db.query(`UPDATE whatsapp_messages SET status = 'FAILED', updated_at = now(),
        error = 'Interrupted while sending; check the customer did not receive it before requeueing'
      WHERE status = 'SENDING' AND updated_at < now() - interval '10 minutes'`);
  const { rows: [{ sent }] } = await db.query(`SELECT count(*)::int AS sent FROM whatsapp_messages
      WHERE campaign_id IS NOT NULL AND status = 'SENT' AND updated_at > now() - interval '1 day'`);
  let quota = marketingDailyLimit() - sent;
  let claimed = 0;
  for (; claimed < max; claimed++) {
    // One row per claim, so a process exit can strand only the message actually in flight.
    // Booking/KYC rows go first; campaign rows only while today's marketing quota lasts.
    // Stage rows older than a day EXPIRE (stale news); campaign rows wait for quota instead.
    const { rows: [row] } = await db.query(`UPDATE whatsapp_messages w
          SET status = CASE WHEN w.campaign_id IS NULL AND w.created_at < now() - interval '1 day' THEN 'EXPIRED' ELSE 'SENDING' END,
              updated_at = now()
        WHERE w.id = (SELECT id FROM whatsapp_messages WHERE status = 'QUEUED' AND (campaign_id IS NULL OR $1::boolean)
                       ORDER BY campaign_id IS NOT NULL, id LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING w.id, w.event, w.ref_id, w.campaign_id, w.status`, [quota > 0]);
    if (!row) break;
    if (row.campaign_id) quota -= 1;
    if (row.status === 'SENDING') await deliver(row, { db, send, upload });
  }
  return claimed;
}

const rejectionReason = async (wabaId, metaTemplateId) => {
  try {
    const { template } = await aws().send(new GetWhatsAppMessageTemplateCommand({ id: wabaId, metaTemplateId }));
    return JSON.parse(template).rejected_reason || null;
  } catch {
    return null;
  }
};

/** Copy Meta's review status (and rejection reason) onto the Studio's template versions. */
export async function refreshTemplates(db = pool) {
  const { wabaId } = await sender();
  const remote = new Map();
  let nextToken;
  do {
    const page = await aws().send(new ListWhatsAppMessageTemplatesCommand({ id: wabaId, nextToken, maxResults: 100 }));
    for (const t of page.templates || []) remote.set(t.templateName, t);
    nextToken = page.nextToken;
  } while (nextToken);
  const { rows } = await db.query(`SELECT id, name, status, category, rejected_reason FROM whatsapp_templates WHERE status <> 'DELETED'`);
  for (const row of rows) {
    const t = remote.get(row.name);
    if (!t) continue; // ponytail: deleted outside the Studio stays listed; delete it here too
    const rejected = t.templateStatus === 'REJECTED';
    const reason = rejected ? row.rejected_reason || await rejectionReason(wabaId, t.metaTemplateId) : null;
    if (t.templateStatus !== row.status || t.templateCategory !== row.category || reason !== row.rejected_reason) {
      await db.query(
        'UPDATE whatsapp_templates SET status = $2, category = $3, rejected_reason = $4, meta_template_id = $5 WHERE id = $1',
        [row.id, t.templateStatus, t.templateCategory, reason, t.metaTemplateId],
      );
    }
  }
}

// AWS/Meta refusals are actionable for the admin (approval, IAM, bucket), so show them.
export const viaAws = (promise) => promise.catch((error) => {
  throw error.$metadata ? studioError(`WhatsApp (AWS) ${error.name}: ${error.message}`, 422) : error;
});

/**
 * Submit a new version of a stage's template to Meta. The current approved version keeps
 * sending until this one is approved. A document header needs a sample PDF for review.
 */
export async function submitTemplate({ event, body, hasDocument = false, userId = null }, db = pool) {
  const spec = EVENTS[event];
  if (!spec) throw studioError('Unknown stage', 404); // marketing templates go through whatsappMarketing.js
  const { text, fields } = compileBody(event, body);
  const { wabaId } = await viaAws(sender());
  const components = [];
  if (hasDocument) {
    const doc = (await stageDocument(event, db)) || DOCUMENTS[spec.attachment];
    if (!doc) throw studioError(`"${spec.label}" has no document to attach`);
    const sample = await putMedia(await doc.render(doc.sample), doc.filename(doc.sample));
    const { metaHeaderHandle } = await viaAws(aws().send(new CreateWhatsAppMessageTemplateMediaCommand({ id: wabaId, sourceS3File: sample })));
    components.push({ type: 'HEADER', format: 'DOCUMENT', example: { header_handle: [metaHeaderHandle] } });
  }
  components.push({ type: 'BODY', text, ...(fields.length ? { example: { body_text: [fields.map((name) => spec.fields[name].sample)] } } : {}) });
  const { rows: [{ version }] } = await db.query('SELECT COALESCE(MAX(version), 0) + 1 AS version FROM whatsapp_templates WHERE event = $1', [event]);
  const name = `dgg_${event.toLowerCase()}_v${version}`;
  // allow_category_change: Meta re-labels instead of rejecting with INCORRECT_CATEGORY where it can.
  const created = await viaAws(aws().send(new CreateWhatsAppMessageTemplateCommand({
    id: wabaId,
    templateDefinition: Buffer.from(JSON.stringify({
      name, language: lang(), category: 'UTILITY', allow_category_change: true, parameter_format: 'positional', components,
    })),
  })));
  const status = created.templateStatus || 'PENDING';
  const reason = status === 'REJECTED' ? await rejectionReason(wabaId, created.metaTemplateId) : null;
  const { rows: [row] } = await db.query(
    `INSERT INTO whatsapp_templates (event, version, name, body, fields, has_document, status, category, rejected_reason, meta_template_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING event, version, name, body, fields, has_document, status, category, rejected_reason, created_at`,
    [event, version, name, String(body).trim(), fields, hasDocument, status, created.category || 'UTILITY', reason, created.metaTemplateId, userId],
  );
  return row;
}

/** Delete a version from Meta and hide it in the Studio (its name is never reused). */
export async function deleteTemplate(name, db = pool) {
  const { rows: [row] } = await db.query(`SELECT id FROM whatsapp_templates WHERE name = $1 AND status <> 'DELETED'`, [name]);
  if (!row) throw studioError('Template not found', 404);
  const { rows: busy } = await db.query(`SELECT 1 FROM whatsapp_messages m JOIN whatsapp_campaigns c ON c.id = m.campaign_id
      WHERE c.template_name = $1 AND m.status IN ('QUEUED', 'SENDING') LIMIT 1`, [name]);
  if (busy.length) throw studioError('A campaign is still sending with this template. Cancel it first.', 409);
  const { wabaId } = await viaAws(sender());
  await viaAws(aws().send(new DeleteWhatsAppMessageTemplateCommand({ id: wabaId, templateName: name, deleteAllLanguages: true })))
    .catch((error) => { if (!/ResourceNotFound/.test(error.message)) throw error; });
  await db.query(`UPDATE whatsapp_templates SET status = 'DELETED' WHERE id = $1`, [row.id]);
}

/** Turn a stage on/off and choose its attachment. */
export async function saveStage(event, { enabled, attachment = null }, userId = null, db = pool) {
  if (!EVENTS[event]) throw studioError('Unknown stage', 404);
  if (typeof enabled !== 'boolean') throw studioError('enabled must be true or false');
  if (attachment !== null && !DOCUMENTS[attachment]?.events.includes(event)) throw studioError('That document cannot be attached to this stage');
  const { rows: [row] } = await db.query(
    `INSERT INTO whatsapp_stage_settings (event, enabled, attachment, updated_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (event) DO UPDATE SET enabled = EXCLUDED.enabled, attachment = EXCLUDED.attachment,
       updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING event, enabled, attachment`,
    [event, enabled, attachment, userId],
  );
  return row;
}

/** Send a stage's approved template, filled with sample values, to one number. */
export async function sendTestMessage(event, phone, db = pool) {
  const spec = EVENTS[event];
  if (!spec) throw studioError('Unknown stage', 404);
  const to = toE164(phone);
  if (!to) throw studioError('Enter a valid 10-digit Indian mobile number');
  const template = await activeTemplate(event, db);
  if (!template) throw studioError('This stage has no approved template yet', 409);
  let media = null;
  if (template.has_document) {
    const doc = await stageDocument(event, db);
    if (!doc) throw studioError('Choose an attachment for this stage first', 409);
    const filename = doc.filename(doc.sample);
    media = { type: 'document', id: await viaAws(uploadWhatsAppMedia(await doc.render(doc.sample), filename)), filename };
  }
  const params = template.fields.map((name) => clean(spec.fields[name].sample));
  const messageId = await viaAws(sendWhatsAppTemplate(to, template.name, params, { media }));
  return { to, template: template.name, message_id: messageId };
}

/** Everything the Studio page shows. Refreshes Meta review statuses first. */
export async function studioState(db = pool) {
  const configured = Boolean(process.env.WHATSAPP_PHONE_NUMBER_ID);
  let info = null;
  let error = null;
  if (configured) {
    try {
      await refreshTemplates(db);
      info = await sender();
    } catch (e) {
      error = `${e.name}: ${e.message}`;
    }
  }
  const { rows: templates } = await db.query(`SELECT event, version, name, body, fields, has_document, status, category, rejected_reason, created_at
    FROM whatsapp_templates WHERE status <> 'DELETED' ORDER BY version DESC`);
  const { rows: settings } = await db.query('SELECT event, enabled, attachment FROM whatsapp_stage_settings');
  const { rows: recent } = await db.query(`SELECT id, event, ref_id, status, phone, template, error, created_at
    FROM whatsapp_messages ORDER BY id DESC LIMIT 30`);
  return {
    enabled: process.env.WHATSAPP_ENABLED === 'true',
    configured,
    error,
    media_bucket: Boolean(process.env.WHATSAPP_MEDIA_BUCKET),
    sender: info && { number: info.number, name: info.name, quality: info.quality },
    stages: Object.entries(EVENTS).map(([key, spec]) => {
      const saved = settings.find((s) => s.event === key);
      return {
        key, label: spec.label, description: spec.description, default_body: spec.body,
        fields: Object.entries(spec.fields).map(([name, f]) => ({ name, label: f.label, sample: f.sample })),
        documents: Object.entries(DOCUMENTS).filter(([, d]) => d.events.includes(key)).map(([docKey, d]) => ({ key: docKey, label: d.label })),
        settings: saved ? { enabled: saved.enabled, attachment: saved.attachment } : { enabled: true, attachment: spec.attachment || null },
        templates: templates.filter((t) => t.event === key),
      };
    }),
    recent,
  };
}

let started = false;
let lastRefresh = 0;

/** Boot hook (server.js): drain the queue every 10 s and refresh template approvals every 10 min. */
export function startWhatsAppWorker(intervalMs = 10_000) {
  if (started || process.env.WHATSAPP_ENABLED !== 'true') return;
  if (!process.env.WHATSAPP_PHONE_NUMBER_ID) {
    console.warn('[booking-api] WHATSAPP_ENABLED=true but WHATSAPP_PHONE_NUMBER_ID is missing — WhatsApp messages stay queued');
    return;
  }
  started = true;
  const tick = async () => {
    try {
      if (Date.now() - lastRefresh > 600_000) {
        lastRefresh = Date.now();
        await refreshTemplates().catch((error) => console.error('[whatsapp] template refresh failed:', error.message));
      }
      await drainWhatsApp();
    } catch (error) {
      console.error('[whatsapp] drain failed:', error.message);
    } finally {
      setTimeout(tick, intervalMs).unref();
    }
  };
  tick();
  console.log('[booking-api] WhatsApp notifications ready');
}
