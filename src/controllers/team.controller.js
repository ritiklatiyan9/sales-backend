import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { isAdminRole, logActivity } from '../services/agentNetwork.service.js';
import { requireSiteAccess } from '../services/bookingWorkspaceAccess.js';
import { brokerCode, brokerFromMember, isInBranch, listDealers } from '../services/dealerTeams.js';
import { workflowError } from '../services/drawWorkflow.js';

/** Admin-only guard for the whole module (server-side, never trust the client). */
const requireAdmin = (req, res) => {
  if (!isAdminRole(req.user.role)) {
    res.status(403).json({ message: 'Admin access required' });
    return false;
  }
  return true;
};

/** Counts are for the caller's working site (?site_id=); omitted → no counts. */
const siteFor = async (req) => (req.query.site_id ? (await requireSiteAccess(req.user, req.query.site_id)).id : null);

const withDealers = (team, dealers) => {
  const own = dealers.filter((d) => d.team_id === team.id);
  const head = own.find((d) => d.parent_broker_id == null) || null;
  return {
    ...team, dealers: own, dealer_count: own.length,
    head: head && { broker_id: head.broker_id, name: head.name, code: head.code },
    booking_count: own.reduce((sum, d) => sum + d.booking_count, 0),
    draw_count: own.reduce((sum, d) => sum + d.draw_count, 0),
  };
};

/**
 * GET /teams?site_id= — every team with its dealer tree (flat, parent ids) and
 * per-site booking/draw counts. Also feeds the Network page.
 */
export const listTeams = asyncHandler(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const siteId = await siteFor(req);
  const { rows } = await pool.query(`SELECT t.*, s.name AS site_name FROM teams t LEFT JOIN sites s ON s.id = t.site_id
    ORDER BY t.status ASC, t.name ASC, t.id ASC`);
  const dealers = await listDealers(rows.map((t) => t.id), siteId, pool);
  res.json(rows.map((t) => withDealers(t, dealers)));
});

/** GET /teams/:id?site_id= — one team with its dealer tree. */
export const getTeam = asyncHandler(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const siteId = await siteFor(req);
  const { rows } = await pool.query('SELECT * FROM teams WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ message: 'Team not found' });
  res.json(withDealers(rows[0], await listDealers([rows[0].id], siteId, pool)));
});

/** Runs fn inside a transaction holding the team row lock (serialises team edits). */
const inTeam = async (teamId, fn) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id, name FROM teams WHERE id = $1 FOR UPDATE', [teamId]);
    if (!rows[0]) throw workflowError('Team not found', 404);
    const { rows: dealers } = await client.query('SELECT broker_id, parent_broker_id FROM team_dealers WHERE team_id = $1', [teamId]);
    const result = await fn(client, rows[0], dealers);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
};

/**
 * POST /teams/:id/dealers — add a Members broker. Body: { member_id, parent_broker_id }.
 * No parent = the Team Head (one per team); otherwise a sub-dealer under any dealer
 * of this team, any depth. A dealer belongs to one team only.
 */
export const addDealer = asyncHandler(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const teamId = Number(req.params.id);
  const parent = req.body?.parent_broker_id == null || req.body.parent_broker_id === '' ? null : Number(req.body.parent_broker_id);
  const dealer = await inTeam(teamId, async (db, team, dealers) => {
    const broker = await brokerFromMember(req.body?.member_id, db);
    const { rows: elsewhere } = await db.query('SELECT t.name FROM team_dealers td JOIN teams t ON t.id = td.team_id WHERE td.broker_id = $1', [broker.broker_id]);
    if (elsewhere[0]) throw workflowError(`${broker.full_name} (${brokerCode(broker.broker_id)}) is already in Team ${elsewhere[0].name}`, 409);
    const head = dealers.find((d) => d.parent_broker_id == null);
    if (parent == null && head) throw workflowError(`Team ${team.name} already has a head. Add this dealer under someone, or change the head.`, 409);
    if (parent != null && !dealers.some((d) => d.broker_id === parent)) throw workflowError('The selected upline dealer is not in this team', 400);
    await db.query('INSERT INTO team_dealers (broker_id, member_id, team_id, parent_broker_id, added_by) VALUES ($1, $2, $3, $4, $5)',
      [broker.broker_id, broker.id, teamId, parent, req.user.id]);
    return { broker_id: broker.broker_id, name: broker.full_name, code: brokerCode(broker.broker_id) };
  });
  logActivity(req.user.id, null, 'TEAM_DEALER_ADDED', { team_id: teamId, ...dealer, parent_broker_id: parent });
  res.status(201).json(dealer);
});

/** PATCH /teams/:id/dealers/:brokerId — move a sub-dealer (with their branch) under another dealer. */
export const moveDealer = asyncHandler(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const teamId = Number(req.params.id), brokerId = Number(req.params.brokerId);
  const parent = Number(req.body?.parent_broker_id);
  await inTeam(teamId, async (db, team, dealers) => {
    const me = dealers.find((d) => d.broker_id === brokerId);
    if (!me) throw workflowError('Dealer not found in this team', 404);
    if (me.parent_broker_id == null) throw workflowError('The team head cannot be moved. Make another dealer the head instead.', 409);
    if (!dealers.some((d) => d.broker_id === parent)) throw workflowError('The selected upline dealer is not in this team', 400);
    if (await isInBranch(brokerId, parent, db)) throw workflowError('A dealer cannot be placed under their own sub-dealer', 409);
    await db.query('UPDATE team_dealers SET parent_broker_id = $1 WHERE broker_id = $2', [parent, brokerId]);
  });
  logActivity(req.user.id, null, 'TEAM_DEALER_MOVED', { team_id: teamId, broker_id: brokerId, parent_broker_id: parent });
  res.json({ message: 'Dealer moved' });
});

/** PUT /teams/:id/head — make a dealer of this team the head; the old head joins under them. */
export const setTeamHead = asyncHandler(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const teamId = Number(req.params.id), brokerId = Number(req.body?.broker_id);
  await inTeam(teamId, async (db, team, dealers) => {
    if (!dealers.some((d) => d.broker_id === brokerId)) throw workflowError('Dealer not found in this team', 404);
    const head = dealers.find((d) => d.parent_broker_id == null);
    if (!head || head.broker_id === brokerId) {
      await db.query('UPDATE team_dealers SET parent_broker_id = NULL WHERE broker_id = $1', [brokerId]);
      return;
    }
    // Old head first goes under the new head, then the new head becomes the root —
    // the one-head index never sees two heads and no branch is lost.
    await db.query('UPDATE team_dealers SET parent_broker_id = $1 WHERE broker_id = $2', [brokerId, head.broker_id]);
    await db.query('UPDATE team_dealers SET parent_broker_id = NULL WHERE broker_id = $1', [brokerId]);
  });
  logActivity(req.user.id, null, 'TEAM_HEAD_CHANGED', { team_id: teamId, broker_id: brokerId });
  res.json({ message: 'Team head updated' });
});

/** DELETE /teams/:id/dealers/:brokerId — remove; their sub-dealers move up to their upline. */
export const removeDealer = asyncHandler(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const teamId = Number(req.params.id), brokerId = Number(req.params.brokerId);
  await inTeam(teamId, async (db, team, dealers) => {
    const me = dealers.find((d) => d.broker_id === brokerId);
    if (!me) throw workflowError('Dealer not found in this team', 404);
    if (me.parent_broker_id == null && dealers.some((d) => d.parent_broker_id === brokerId)) {
      throw workflowError('Make another dealer the team head before removing this head', 409);
    }
    await db.query('UPDATE team_dealers SET parent_broker_id = $1 WHERE parent_broker_id = $2', [me.parent_broker_id, brokerId]);
    await db.query('DELETE FROM team_dealers WHERE broker_id = $1', [brokerId]);
  });
  logActivity(req.user.id, null, 'TEAM_DEALER_REMOVED', { team_id: teamId, broker_id: brokerId });
  res.json({ message: 'Dealer removed' });
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
