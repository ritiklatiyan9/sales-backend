import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { isAdminRole, logActivity } from '../services/agentNetwork.service.js';

/** Admin-only guard for the whole module (server-side, never trust the client). */
const requireAdmin = (req, res) => {
  if (!isAdminRole(req.user.role)) {
    res.status(403).json({ message: 'Admin access required' });
    return false;
  }
  return true;
};

/** GET /teams — teams with members/heads/booking stats in one query. */
export const listTeams = asyncHandler(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { rows } = await pool.query(`
    SELECT t.*,
           s.name AS site_name,
           (SELECT count(*)::int FROM team_members tm WHERE tm.team_id = t.id) AS member_count,
           (SELECT COALESCE(string_agg(u.name, ', '), '')
              FROM team_members tm JOIN users u ON u.id = tm.user_id
             WHERE tm.team_id = t.id AND tm.is_head = true) AS heads,
           (SELECT count(*)::int FROM bookings b WHERE b.team_id = t.id) AS booking_count,
           (SELECT COALESCE(SUM(b.token_amount), 0)::float FROM bookings b WHERE b.team_id = t.id) AS token_total
    FROM teams t
    LEFT JOIN sites s ON s.id = t.site_id
    ORDER BY t.status ASC, t.created_at DESC
  `);
  res.json(rows);
});

/** GET /teams/:id — detail + member list. */
export const getTeam = asyncHandler(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { rows } = await pool.query('SELECT * FROM teams WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ message: 'Team not found' });
  const { rows: members } = await pool.query(`
    SELECT u.id, u.name, u.email, u.phone, u.designation, u.role, u.agent_status, u.referral_code,
           tm.is_head, tm.joined_at,
           (SELECT count(*)::int FROM bookings b WHERE b.agent_user_id = u.id) AS booking_count,
           (SELECT COALESCE(SUM(b.token_amount), 0)::float FROM bookings b WHERE b.agent_user_id = u.id) AS token_total
    FROM team_members tm JOIN users u ON u.id = tm.user_id
    WHERE tm.team_id = $1
    ORDER BY tm.is_head DESC, u.name ASC
  `, [req.params.id]);
  res.json({ ...rows[0], members });
});

/** POST /teams — create. */
export const createTeam = asyncHandler(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { name, site_id } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ message: 'Team name is required' });
  const { rows } = await pool.query(
    `INSERT INTO teams (name, site_id, created_by) VALUES ($1, $2, $3) RETURNING *`,
    [name.trim(), site_id || null, req.user.id]
  );
  logActivity(req.user.id, null, 'TEAM_CREATED', { team_id: rows[0].id, name: rows[0].name });
  res.status(201).json(rows[0]);
});

/** PATCH /teams/:id — rename / archive / restore. */
export const updateTeam = asyncHandler(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { name, status } = req.body || {};
  const sets = [];
  const params = [];
  if (name !== undefined) { params.push(String(name).trim()); sets.push(`name = $${params.length}`); }
  if (status !== undefined) {
    if (!['ACTIVE', 'ARCHIVED'].includes(status)) return res.status(400).json({ message: 'Invalid status' });
    params.push(status); sets.push(`status = $${params.length}`);
  }
  if (!sets.length) return res.status(400).json({ message: 'Nothing to update' });
  params.push(req.params.id);
  const { rows } = await pool.query(
    `UPDATE teams SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (!rows[0]) return res.status(404).json({ message: 'Team not found' });
  logActivity(req.user.id, null, 'TEAM_UPDATED', { team_id: rows[0].id, ...req.body });
  res.json(rows[0]);
});

/** DELETE /teams/:id — hard delete (memberships cascade; bookings.team_id nulls). */
export const deleteTeam = asyncHandler(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  await pool.query('UPDATE users SET team_id = NULL WHERE team_id = $1', [req.params.id]);
  const { rowCount } = await pool.query('DELETE FROM teams WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ message: 'Team not found' });
  logActivity(req.user.id, null, 'TEAM_DELETED', { team_id: Number(req.params.id) });
  res.json({ message: 'Team deleted' });
});

/**
 * POST /teams/:id/members — assign or transfer an agent into this team
 * (single-primary-team semantics: removes membership of any other team).
 * Body: { user_id, is_head? }
 */
export const upsertMember = asyncHandler(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const teamId = Number(req.params.id);
  const { user_id, is_head } = req.body || {};
  if (!user_id) return res.status(400).json({ message: 'user_id is required' });
  const { rows: u } = await pool.query('SELECT id FROM users WHERE id = $1 AND is_active = true', [user_id]);
  if (!u[0]) return res.status(400).json({ message: 'User not found' });

  await pool.query('DELETE FROM team_members WHERE user_id = $1 AND team_id <> $2', [user_id, teamId]);
  await pool.query(
    `INSERT INTO team_members (team_id, user_id, is_head) VALUES ($1, $2, COALESCE($3, false))
     ON CONFLICT (team_id, user_id) DO UPDATE SET is_head = COALESCE($3, team_members.is_head)`,
    [teamId, user_id, is_head === undefined ? null : !!is_head]
  );
  await pool.query('UPDATE users SET team_id = $1, updated_at = now() WHERE id = $2', [teamId, user_id]);
  logActivity(req.user.id, user_id, 'TEAM_MEMBER_ASSIGNED', { team_id: teamId, is_head: !!is_head });
  res.json({ message: 'Member assigned', team_id: teamId, user_id, is_head: !!is_head });
});

/** DELETE /teams/:id/members/:userId — remove from team. */
export const removeMember = asyncHandler(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const teamId = Number(req.params.id);
  const userId = Number(req.params.userId);
  await pool.query('DELETE FROM team_members WHERE team_id = $1 AND user_id = $2', [teamId, userId]);
  await pool.query('UPDATE users SET team_id = NULL WHERE id = $1 AND team_id = $2', [userId, teamId]);
  logActivity(req.user.id, userId, 'TEAM_MEMBER_REMOVED', { team_id: teamId });
  res.json({ message: 'Member removed' });
});
