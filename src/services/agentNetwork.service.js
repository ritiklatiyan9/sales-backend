import pool from '../config/db.js';

/**
 * Agent-network primitives shared by the agents/teams controllers and the booking
 * visibility scoping. All hierarchy traversal is server-side (recursive CTEs on the
 * indexed users.parent_user_id adjacency list) — the frontend is never trusted.
 */

export const ADMIN_ROLES = new Set(['admin', 'super_admin', 'sub_admin']);
export const isAdminRole = (role) => ADMIN_ROLES.has(String(role || '').toLowerCase());

// Unambiguous alphabet (no 0/O/1/I). Codes are permanent, unique and indexed.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const randomCode = () =>
  'AGT-' + Array.from({ length: 5 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');

/** Generate a unique referral code (retries on the unique-index collision). */
export const generateReferralCode = async () => {
  for (let attempt = 0; attempt < 25; attempt++) {
    const code = randomCode();
    const { rows } = await pool.query('SELECT 1 FROM users WHERE referral_code = $1', [code]);
    if (!rows.length) return code;
  }
  throw new Error('Could not allocate a unique referral code');
};

/** Ensure a user has a referral code; returns it. */
export const ensureReferralCode = async (userId) => {
  const { rows } = await pool.query('SELECT referral_code FROM users WHERE id = $1', [userId]);
  if (!rows[0]) return null;
  if (rows[0].referral_code) return rows[0].referral_code;
  const code = await generateReferralCode();
  await pool.query('UPDATE users SET referral_code = $1 WHERE id = $2', [code, userId]);
  return code;
};

/** All user ids in someone's downline, INCLUDING themself. Depth-unlimited. */
export const getDownlineIds = async (userId) => {
  const { rows } = await pool.query(
    `WITH RECURSIVE down AS (
       SELECT id FROM users WHERE id = $1
       UNION ALL
       SELECT u.id FROM users u JOIN down d ON u.parent_user_id = d.id
     )
     SELECT id FROM down`,
    [userId]
  );
  return rows.map((r) => r.id);
};

/** Upline chain (parent → … → root), excluding the user. */
export const getUplineChain = async (userId) => {
  const { rows } = await pool.query(
    `WITH RECURSIVE up AS (
       SELECT id, parent_user_id, name, designation, role, 0 AS depth
       FROM users WHERE id = $1
       UNION ALL
       SELECT u.id, u.parent_user_id, u.name, u.designation, u.role, up.depth + 1
       FROM users u JOIN up ON u.id = up.parent_user_id
     )
     SELECT id, name, designation, role, depth FROM up WHERE depth > 0 ORDER BY depth`,
    [userId]
  );
  return rows;
};

/** Team ids this user heads. */
export const getHeadedTeamIds = async (userId) => {
  const { rows } = await pool.query(
    'SELECT team_id FROM team_members WHERE user_id = $1 AND is_head = true',
    [userId]
  );
  return rows.map((r) => r.team_id);
};

/**
 * The set of user ids whose data (bookings, network nodes) this user may see.
 * Admin roles → null (unrestricted). Others → self + full downline + (if a team
 * head) every member of the teams they head. Never parents' siblings, never
 * other teams, never other branches.
 */
export const getVisibleUserIds = async (user) => {
  if (isAdminRole(user.role)) return null;
  const ids = new Set(await getDownlineIds(user.id));
  const headed = await getHeadedTeamIds(user.id);
  if (headed.length) {
    const { rows } = await pool.query(
      'SELECT user_id FROM team_members WHERE team_id = ANY($1)',
      [headed]
    );
    for (const r of rows) ids.add(r.user_id);
  }
  return [...ids];
};

/** True when candidateParent is inside userId's own downline (cycle guard). */
export const wouldCreateCycle = async (userId, candidateParentId) => {
  if (Number(userId) === Number(candidateParentId)) return true;
  const downline = await getDownlineIds(userId);
  return downline.includes(Number(candidateParentId));
};

/** Audit-trail helper (fire-and-forget safe). */
export const logActivity = (actorId, targetId, action, detail = {}) =>
  pool
    .query(
      `INSERT INTO agent_activity_log (actor_user_id, target_user_id, action, detail)
       VALUES ($1, $2, $3, $4)`,
      [actorId || null, targetId || null, action, JSON.stringify(detail)]
    )
    .catch((e) => console.error('[agent-log]', e.message));
