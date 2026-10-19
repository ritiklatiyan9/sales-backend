import pool from '../config/db.js';
import { isFullAdmin, isSubAdmin } from './subAdminPermissions.js';
import { workflowError } from './drawWorkflow.js';

export async function requireSiteAccess(user, siteId, db = pool) {
  const id = Number(siteId);
  if (!Number.isInteger(id) || id <= 0) throw workflowError('Select a valid site');
  // One round trip: this guard runs on almost every site-scoped request.
  const { rows } = await db.query(
    'SELECT s.id, s.name, EXISTS (SELECT 1 FROM user_sites us WHERE us.user_id = $2 AND us.site_id = s.id) AS assigned FROM sites s WHERE s.id = $1',
    [id, user?.id ?? null]
  );
  if (!rows[0]) throw workflowError('Site not found', 404);
  // Sub-admins operate only in assigned sites, matching /auth/me's site list.
  if (!['admin', 'super_admin'].includes(user?.role) && !rows[0].assigned) throw workflowError('You do not have access to this site', 403);
  return { id: rows[0].id, name: rows[0].name };
}

export async function requireWorkspaceAccess(user, siteId, module, action = 'can_read', db = pool) {
  const site = await requireSiteAccess(user, siteId, db);
  if (isFullAdmin(user)) return site;
  const { rows } = await db.query('SELECT can_read, can_write, can_update, can_delete FROM user_permissions WHERE user_id = $1 AND module = $2', [user.id, module]);
  if (!rows.length && isSubAdmin(user)) return site;
  if (rows[0]?.can_read !== true || rows[0]?.[action] !== true) throw workflowError('Access Control has not granted this action for your account', 403);
  return site;
}

/** Shared resources used by more than one opt-in workspace need either View grant. */
export async function requireAnyWorkspaceReadAccess(user, siteId, modules, db = pool) {
  const site = await requireSiteAccess(user, siteId, db);
  if (isFullAdmin(user)) return site;
  const { rows } = await db.query(
    'SELECT module, can_read FROM user_permissions WHERE user_id = $1 AND module = ANY($2::text[])',
    [user.id, modules]
  );
  const allowed = modules.some(module => {
    const permission = rows.find(row => row.module === module);
    return permission ? permission.can_read === true : isSubAdmin(user);
  });
  if (!allowed) throw workflowError('Access Control has not granted agreement access for your account', 403);
  return site;
}
