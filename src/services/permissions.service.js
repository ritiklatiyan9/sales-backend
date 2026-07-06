import pool from '../config/db.js';
import { isAdminRole } from './agentNetwork.service.js';

/**
 * Module-level CRUD permission check (the shared user_permissions table, same rows
 * Access Control edits). Admin roles always pass. No stored row for a module = full
 * access (default-allow), matching the sidebar visibility rule in admin.controller.js.
 */
const FLAGS = new Set(['can_read', 'can_write', 'can_update', 'can_delete']);

export const hasPermission = async (user, moduleKey, flag) => {
  if (!FLAGS.has(flag)) throw new Error(`Unknown permission flag: ${flag}`);
  if (isAdminRole(user?.role)) return true;
  const { rows } = await pool.query(
    `SELECT ${flag} AS allowed FROM user_permissions WHERE user_id = $1 AND module = $2`,
    [user.id, moduleKey]
  );
  if (!rows.length) return true;
  return rows[0].allowed !== false;
};
