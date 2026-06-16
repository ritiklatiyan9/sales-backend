import asyncHandler from '../utils/asyncHandler.js';
import * as projectSettings from '../models/ProjectSettings.model.js';

/** GET /project-settings?site_id= — Company + Payment details for a site (Project Details). */
export const getProjectSettings = asyncHandler(async (req, res) => {
  const siteId = req.query.site_id;
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });
  const row = await projectSettings.getBySite(siteId);
  res.json(row || { site_id: Number(siteId), milestones: [] });
});

/** PUT /project-settings — upsert Company + Payment details for a site. */
export const saveProjectSettings = asyncHandler(async (req, res) => {
  const { site_id, ...data } = req.body;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });
  const row = await projectSettings.upsertBySite(site_id, data);
  res.json(row);
});
