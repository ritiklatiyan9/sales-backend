import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import sharp from 'sharp';
import { requireSiteAccess, requireWorkspaceAccess } from '../services/bookingWorkspaceAccess.js';
import { validateBookingTemplate, requirePublishableBookingTemplate } from '../services/bookingFormTemplate.js';
import { workflowError } from '../services/drawWorkflow.js';
import { uploadKycDocument, getPublicKycUrl } from '../utils/s3.js';

const MODULE = 'booking_document_studio';
export const getPublishedForm = asyncHandler(async (req, res) => {
  await requireSiteAccess(req.user, req.params.siteId);
  const { rows } = await pool.query('SELECT published AS template, published_revision AS revision, published_at FROM booking_form_templates WHERE site_id = $1', [req.params.siteId]);
  res.json(rows[0] || { template:null, revision:0, published_at:null });
});
export const getFormStudio = asyncHandler(async (req, res) => {
  const site = await requireWorkspaceAccess(req.user, req.params.siteId, MODULE);
  const { rows } = await pool.query('SELECT * FROM booking_form_templates WHERE site_id = $1', [site.id]);
  const { rows:settings } = await pool.query('SELECT company_brand_name, company_legal_name, company_address, company_city, company_phone, company_email, company_gstin, logo_url, document_config, payment_terms FROM project_settings WHERE site_id = $1', [site.id]);
  res.json({ site, template:rows[0] || null, source_settings:settings[0] || {} });
});
export const saveFormDraft = asyncHandler(async (req, res) => {
  const revision = Number(req.body.revision);
  if (!Number.isInteger(revision) || revision < 0) throw workflowError('Send the current draft revision');
  await requireWorkspaceAccess(req.user, req.params.siteId, MODULE, revision === 0 ? 'can_write' : 'can_update');
  const content = validateBookingTemplate(req.body.template);
  const { rows } = revision === 0
    ? await pool.query(`INSERT INTO booking_form_templates (site_id,draft,updated_by) VALUES ($1,$2,$3) ON CONFLICT (site_id) DO NOTHING RETURNING *`, [req.params.siteId, JSON.stringify(content), req.user.id])
    : await pool.query(`UPDATE booking_form_templates SET draft=$1, revision=revision+1, updated_by=$2, updated_at=now() WHERE site_id=$3 AND revision=$4 RETURNING *`, [JSON.stringify(content), req.user.id, req.params.siteId, revision]);
  if (!rows[0]) throw workflowError('This form was changed by someone else. Reload the latest draft before saving.', 409);
  res.json(rows[0]);
});
export const publishForm = asyncHandler(async (req, res) => {
  await requireWorkspaceAccess(req.user, req.params.siteId, MODULE, 'can_update');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM booking_form_templates WHERE site_id=$1 FOR UPDATE', [req.params.siteId]);
    const row = rows[0];
    if (!row) throw workflowError('Save a draft first', 409);
    if (row.revision !== Number(req.body.revision)) throw workflowError('The draft changed. Reload it before publishing.', 409);
    const template = validateBookingTemplate(row.draft);
    requirePublishableBookingTemplate(template);
    const result = await client.query(`UPDATE booking_form_templates SET published=$1,published_revision=revision,published_by=$2,published_at=now() WHERE site_id=$3 RETURNING *`, [JSON.stringify(template), req.user.id, req.params.siteId]);
    await client.query('COMMIT');
    res.json(result.rows[0]);
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
});
export const uploadFormImage = asyncHandler(async (req, res) => {
  const existing = await pool.query('SELECT revision FROM booking_form_templates WHERE site_id=$1', [req.params.siteId]);
  await requireWorkspaceAccess(req.user, req.params.siteId, MODULE, existing.rows.length ? 'can_update' : 'can_write');
  if (!req.file) throw workflowError('Choose a JPG, PNG or WebP image');
  let bytes;
  try {
    bytes = await sharp(req.file.buffer, { limitInputPixels:40_000_000 }).rotate().resize(2400,2400,{fit:'inside',withoutEnlargement:true}).webp({quality:90}).toBuffer();
  } catch { throw workflowError('This image cannot be opened. Choose another JPG, PNG or WebP image.'); }
  const key = await uploadKycDocument(bytes, `booking-form-${req.params.siteId}.webp`, 'image/webp');
  res.status(201).json({ url:getPublicKycUrl(key) });
});
