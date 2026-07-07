import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { isAdminRole, logActivity } from '../services/agentNetwork.service.js';

/**
 * Access-control panel for the booking app (admin / super_admin only):
 *  - Site access        → the shared user_sites table (drives /auth/me site scoping)
 *  - Module permissions → the shared user_permissions table, namespaced with a
 *    "booking_" prefix so accounting's own module keys are never touched.
 *
 * Rule of least surprise: a user with NO permission row for a module can see it
 * (backwards compatible); an explicit can_read=false hides/blocks it.
 */

// Booking-app sidebar modules — keep keys in sync with booking-ui Layout.jsx.
export const BOOKING_MODULES = [
  'booking_dashboard', 'booking_bookings', 'booking_new_booking', 'booking_members',
  'booking_kyc_new', 'booking_kyc_all',
  'booking_plot_documents', 'booking_agreements', 'booking_network', 'booking_teams',
  'booking_company_details', 'booking_payment_details',
  'booking_new_entry', 'booking_draws',
];

const requireAdmin = (req, res) => {
  if (!isAdminRole(req.user.role)) {
    res.status(403).json({ message: 'Admin access required' });
    return false;
  }
  return true;
};

/** Only a super_admin may manage another admin/super_admin's access. */
const canManageTarget = (actorRole, targetRole) => {
  if (actorRole === 'super_admin') return true;
  return !['super_admin', 'admin'].includes(targetRole);
};

/** GET /admin/users — everyone manageable from the panel, with site/team context. */
export const listUsers = asyncHandler(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { rows } = await pool.query(`
    SELECT u.id, u.name, u.email, u.phone, u.role, u.is_active, u.agent_status,
           u.designation, u.referral_code, u.team_id, t.name AS team_name,
           COALESCE(us.site_ids, '{}') AS site_ids
    FROM users u
    LEFT JOIN teams t ON t.id = u.team_id
    LEFT JOIN LATERAL (
      SELECT array_agg(site_id ORDER BY site_id) AS site_ids
      FROM user_sites WHERE user_id = u.id
    ) us ON true
    ORDER BY (u.role = 'super_admin') DESC, (u.role = 'admin') DESC, u.name ASC
  `);
  res.json(rows);
});

/** GET /admin/users/:id/access — assigned sites + booking module permissions. */
export const getUserAccess = asyncHandler(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = Number(req.params.id);
  const [sites, perms] = await Promise.all([
    pool.query('SELECT site_id FROM user_sites WHERE user_id = $1 ORDER BY site_id', [id]),
    pool.query(
      `SELECT module, can_read, can_write, can_update, can_delete
       FROM user_permissions WHERE user_id = $1 AND module = ANY($2)`,
      [id, BOOKING_MODULES]
    ),
  ]);
  const permissions = {};
  for (const p of perms.rows) {
    permissions[p.module] = {
      can_read: p.can_read, can_write: p.can_write, can_update: p.can_update, can_delete: p.can_delete,
    };
  }
  res.json({ user_id: id, site_ids: sites.rows.map((r) => r.site_id), permissions, modules: BOOKING_MODULES });
});

/** PUT /admin/users/:id/sites — replace the user's assigned sites. Body: { site_ids: [] } */
export const setUserSites = asyncHandler(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = Number(req.params.id);
  const { rows: target } = await pool.query('SELECT id, role FROM users WHERE id = $1', [id]);
  if (!target[0]) return res.status(404).json({ message: 'User not found' });
  if (!canManageTarget(req.user.role, target[0].role)) {
    return res.status(403).json({ message: 'Only a super admin can manage another admin' });
  }

  const siteIds = [...new Set((req.body?.site_ids || []).map(Number).filter(Number.isFinite))];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM user_sites WHERE user_id = $1', [id]);
    for (const sid of siteIds) {
      await client.query('INSERT INTO user_sites (user_id, site_id) VALUES ($1, $2)', [id, sid]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  logActivity(req.user.id, id, 'SITE_ACCESS_UPDATED', { site_ids: siteIds });
  res.json({ user_id: id, site_ids: siteIds });
});

/**
 * PUT /admin/users/:id/permissions — upsert ONE module's CRUD flags.
 * Body: { module, can_read, can_write, can_update, can_delete }
 */
export const setUserPermission = asyncHandler(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = Number(req.params.id);
  const { module: mod, can_read, can_write, can_update, can_delete } = req.body || {};
  if (!BOOKING_MODULES.includes(mod)) {
    return res.status(400).json({ message: `module must be one of: ${BOOKING_MODULES.join(', ')}` });
  }
  const { rows: target } = await pool.query('SELECT id, role FROM users WHERE id = $1', [id]);
  if (!target[0]) return res.status(404).json({ message: 'User not found' });
  if (!canManageTarget(req.user.role, target[0].role)) {
    return res.status(403).json({ message: 'Only a super admin can manage another admin' });
  }

  const { rows } = await pool.query(
    `INSERT INTO user_permissions (user_id, module, can_read, can_write, can_update, can_delete, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (user_id, module)
     DO UPDATE SET can_read = $3, can_write = $4, can_update = $5, can_delete = $6, updated_at = now()
     RETURNING module, can_read, can_write, can_update, can_delete`,
    [id, mod, !!can_read, !!can_write, !!can_update, !!can_delete]
  );
  logActivity(req.user.id, id, 'MODULE_PERMISSION_UPDATED', { module: mod, can_read: !!can_read, can_write: !!can_write, can_update: !!can_update, can_delete: !!can_delete });
  res.json(rows[0]);
});

/**
 * GET /admin/my-permissions — the CALLER's booking-module permission map (any
 * authenticated user; used by the sidebar). Admin roles bypass with allow-all.
 */
export const getMyPermissions = asyncHandler(async (req, res) => {
  if (isAdminRole(req.user.role)) {
    return res.json({ is_admin: true, permissions: {} });
  }
  const { rows } = await pool.query(
    `SELECT module, can_read, can_write, can_update, can_delete
     FROM user_permissions WHERE user_id = $1 AND module = ANY($2)`,
    [req.user.id, BOOKING_MODULES]
  );
  const permissions = {};
  for (const p of rows) {
    permissions[p.module] = {
      can_read: p.can_read, can_write: p.can_write, can_update: p.can_update, can_delete: p.can_delete,
    };
  }
  res.json({ is_admin: false, permissions });
});
