import pool from '../config/db.js';
import { isFullAdmin } from './subAdminPermissions.js';

/**
 * Module-level CRUD permission check (the shared user_permissions table, same rows
 * Access Control edits). Only admin and super_admin bypass the stored flags. No stored row for a module = full
 * access (default-allow), matching the sidebar visibility rule in admin.controller.js.
 */
// Index order matches the per-request `grants` snapshot built in staffSession.js.
export const PERMISSION_FLAGS = ['can_read', 'can_write', 'can_update', 'can_delete'];

export const hasPermission = async (user, moduleKey, flag) => {
  const index = PERMISSION_FLAGS.indexOf(flag);
  if (index < 0) throw new Error(`Unknown permission flag: ${flag}`);
  if (isFullAdmin(user)) return true;
  // Session-loaded snapshot (authMiddleware): same row, same rule, no extra round trip.
  if (user?.grants && String(moduleKey).startsWith('booking_')) {
    const row = user.grants[moduleKey];
    return !row || row[index] !== false;
  }
  const { rows } = await pool.query(
    `SELECT ${flag} AS allowed FROM user_permissions WHERE user_id = $1 AND module = $2`,
    [user.id, moduleKey]
  );
  if (!rows.length) return true;
  return rows[0].allowed !== false;
};
