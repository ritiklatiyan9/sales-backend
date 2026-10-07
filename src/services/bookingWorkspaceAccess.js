import pool from '../config/db.js';
import { isAdminRole } from './agentNetwork.service.js';
import { workflowError } from './drawWorkflow.js';

export async function requireSiteAccess(user, siteId, db = pool) {
  const id = Number(siteId);
  if (!Number.isInteger(id) || id <= 0) throw workflowError('Select a valid site');
  const { rows } = await db.query('SELECT id, name FROM sites WHERE id = $1', [id]);
  if (!rows[0]) throw workflowError('Site not found', 404);
  if (!isAdminRole(user?.role)) {
    const assigned = await db.query('SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2', [user.id, id]);
    if (!assigned.rows.length) throw workflowError('You do not have access to this site', 403);
  }
  return rows[0];
}

export async function requireWorkspaceAccess(user, siteId, module, action = 'can_read', db = pool) {
  const site = await requireSiteAccess(user, siteId, db);
  if (isAdminRole(user?.role)) return site;
  const { rows } = await db.query('SELECT can_read, can_write, can_update, can_delete FROM user_permissions WHERE user_id = $1 AND module = $2', [user.id, module]);
  if (rows[0]?.can_read !== true || rows[0]?.[action] !== true) throw workflowError('Access Control has not granted this action for your account', 403);
  return site;
}
