import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { requireSiteAccess, requireWorkspaceAccess } from '../services/bookingWorkspaceAccess.js';
import { validateAgreementTemplate } from '../services/agreementTemplate.js';
import { workflowError } from '../services/drawWorkflow.js';

const MODULE = 'booking_agreement_studio';
const SUMMARY = 'id, site_id, name, preset, is_default, revision, updated_at';

async function findTemplate(id) {
  const templateId = Number(id);
  if (!Number.isInteger(templateId) || templateId <= 0) throw workflowError('Select a valid agreement format');
  const { rows } = await pool.query('SELECT * FROM agreement_templates WHERE id = $1', [templateId]);
  if (!rows[0]) throw workflowError('Agreement format not found', 404);
  return rows[0];
}

// Reading needs only site access: anyone who can print a site's agreement can load its format.
export const listAgreementTemplates = asyncHandler(async (req, res) => {
  const site = await requireSiteAccess(req.user, req.query.site_id);
  const { rows } = await pool.query(`SELECT ${SUMMARY} FROM agreement_templates WHERE site_id = $1 ORDER BY is_default DESC, updated_at DESC`, [site.id]);
  res.json(rows);
});

export const getAgreementTemplate = asyncHandler(async (req, res) => {
  const template = await findTemplate(req.params.id);
  await requireSiteAccess(req.user, template.site_id);
  res.json(template);
});

export const createAgreementTemplate = asyncHandler(async (req, res) => {
  const site = await requireWorkspaceAccess(req.user, req.body?.site_id, MODULE, 'can_write');
  const t = validateAgreementTemplate(req.body);
  // The first format of a site becomes its default.
  const { rows } = await pool.query(
    `INSERT INTO agreement_templates (site_id, name, preset, design, body, is_default, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, NOT EXISTS (SELECT 1 FROM agreement_templates WHERE site_id = $1), $6, $6) RETURNING *`,
    [site.id, t.name, t.preset, JSON.stringify(t.design), t.body, req.user.id]);
  res.status(201).json(rows[0]);
});

export const updateAgreementTemplate = asyncHandler(async (req, res) => {
  const current = await findTemplate(req.params.id);
  await requireWorkspaceAccess(req.user, current.site_id, MODULE, 'can_update');
  const revision = Number(req.body?.revision);
  if (!Number.isInteger(revision)) throw workflowError('Send the current revision');
  const t = validateAgreementTemplate(req.body, { partial: true });
  const { rows } = await pool.query(
    `UPDATE agreement_templates SET name = COALESCE($1, name), preset = COALESCE($2, preset), design = COALESCE($3, design),
       body = COALESCE($4, body), revision = revision + 1, updated_by = $5, updated_at = now()
     WHERE id = $6 AND revision = $7 RETURNING *`,
    [t.name ?? null, t.preset ?? null, t.design ? JSON.stringify(t.design) : null, t.body ?? null, req.user.id, current.id, revision]);
  if (!rows[0]) throw workflowError('This format was changed by someone else. Reload it before saving.', 409);
  res.json(rows[0]);
});

export const setDefaultAgreementTemplate = asyncHandler(async (req, res) => {
  const current = await findTemplate(req.params.id);
  await requireWorkspaceAccess(req.user, current.site_id, MODULE, 'can_update');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Two statements: the partial unique index is checked per row.
    await client.query('UPDATE agreement_templates SET is_default = false WHERE site_id = $1 AND is_default', [current.site_id]);
    const { rows } = await client.query(`UPDATE agreement_templates SET is_default = true WHERE id = $1 RETURNING ${SUMMARY}`, [current.id]);
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
});

export const deleteAgreementTemplate = asyncHandler(async (req, res) => {
  const current = await findTemplate(req.params.id);
  await requireWorkspaceAccess(req.user, current.site_id, MODULE, 'can_delete');
  await pool.query('DELETE FROM agreement_templates WHERE id = $1', [current.id]);
  res.status(204).end();
});
