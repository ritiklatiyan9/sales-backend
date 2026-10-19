import asyncHandler from '../utils/asyncHandler.js';
import * as projectSettings from '../models/ProjectSettings.model.js';
import { requireSiteAccess } from '../services/bookingWorkspaceAccess.js';
import { hasPermission } from '../services/permissions.service.js';
import { validateDocumentConfig } from '../services/documentSettings.js';

/** GET /project-settings?site_id= — Company + Payment details for a site (Project Details). */
export const getProjectSettings = asyncHandler(async (req, res) => {
  const siteId = req.query.site_id;
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });
  await requireSiteAccess(req.user, siteId);
  const row = await projectSettings.getBySite(siteId);
  res.json(row || { site_id: Number(siteId), milestones: [] });
});

/** PUT /project-settings — upsert Company + Payment details for a site. */
export const saveProjectSettings = asyncHandler(async (req, res) => {
  const { site_id, ...data } = req.body;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });
  if (!['admin', 'super_admin', 'sub_admin'].includes(req.user?.role)) return res.status(403).json({ message: 'Only administrators can change booking settings' });
  await requireSiteAccess(req.user, site_id);
  if (req.user.role === 'sub_admin') {
    const existing = await projectSettings.getBySite(site_id) || {};
    const banking = new Set(['payable_to', 'bank_name', 'bank_account_no', 'bank_ifsc', 'bank_branch', 'payment_terms', 'milestones']);
    const company = new Set(['company_legal_name', 'company_brand_name', 'company_address', 'company_city', 'company_phone', 'company_email', 'company_gstin', 'company_website', 'logo_url', 'document_config']);
    const changes = Object.keys(data).filter(key => (banking.has(key) || company.has(key)) && JSON.stringify(data[key] ?? '') !== JSON.stringify(existing[key] ?? ''));
    for (const module of new Set(changes.map(key => banking.has(key) ? 'booking_payment_details' : 'booking_company_details'))) {
      if (!await hasPermission(req.user, module, 'can_read') || !await hasPermission(req.user, module, 'can_update')) return res.status(403).json({ message: 'Access Control has not granted permission to update these settings.' });
    }
  }
  const limits = { company_legal_name: 255, company_brand_name: 255, company_address: 1000, company_city: 160, company_phone: 60, company_email: 160, company_gstin: 40, company_website: 160, payable_to: 160, logo_url: 500, bank_name: 160, bank_account_no: 60, bank_ifsc: 40, bank_branch: 160, payment_terms: 5000 };
  for (const [key, max] of Object.entries(limits)) {
    if (data[key] != null && (typeof data[key] !== 'string' || data[key].length > max)) return res.status(400).json({ message: key + ' must be text up to ' + max + ' characters' });
  }
  if (data.document_config !== undefined) data.document_config = validateDocumentConfig(data.document_config);
  if (data.logo_url && !/^(https?:\/\/|\/[^/])/i.test(data.logo_url)) return res.status(400).json({ message: 'Logo must use an http(s) URL or a local asset path' });
  const row = await projectSettings.upsertBySite(site_id, data);
  res.json(row);
});
