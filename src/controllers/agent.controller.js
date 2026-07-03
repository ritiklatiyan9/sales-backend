import bcrypt from 'bcrypt';
import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import {
  isAdminRole, generateReferralCode, ensureReferralCode,
  getDownlineIds, getUplineChain, getVisibleUserIds, wouldCreateCycle, logActivity,
} from '../services/agentNetwork.service.js';

const AGENT_STATUSES = new Set(['PENDING', 'ACTIVE', 'SUSPENDED']);
const LEDGER_TYPES = new Set([
  'COMMISSION_DIRECT', 'COMMISSION_TEAM', 'MATCHING_INCOME', 'LEADERSHIP_BONUS',
  'LEVEL_INCOME', 'ROYALTY', 'REWARD', 'PERFORMANCE_BONUS', 'BONUS', 'INCENTIVE',
  'PENALTY', 'PAYOUT', 'ADJUSTMENT',
]);

const NODE_FIELDS = `
  u.id, u.name, u.email, u.phone, u.photo, u.role, u.designation, u.referral_code,
  u.parent_user_id, u.team_id, u.agent_status, u.can_register_agents, u.is_active,
  u.created_at, t.name AS team_name`;

/**
 * GET /agents/me — my network profile: referral code (auto-issued), team, upline
 * chain, direct downline size and ledger balance.
 */
export const getMe = asyncHandler(async (req, res) => {
  const referral_code = await ensureReferralCode(req.user.id);
  const { rows } = await pool.query(
    `SELECT ${NODE_FIELDS},
            (SELECT count(*)::int FROM users c WHERE c.parent_user_id = u.id) AS direct_count,
            (SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)::float
               FROM agent_ledger_entries l WHERE l.user_id = u.id AND l.status <> 'CANCELLED') AS ledger_balance
     FROM users u LEFT JOIN teams t ON t.id = u.team_id
     WHERE u.id = $1`,
    [req.user.id]
  );
  const me = rows[0];
  if (!me) return res.status(404).json({ message: 'User not found' });
  delete me.password; delete me.refresh_token;
  me.referral_code = referral_code;
  me.upline = await getUplineChain(req.user.id);
  me.is_admin = isAdminRole(req.user.role);
  res.json(me);
});

/**
 * GET /agents/network — role-scoped flat node list (frontend builds the tree).
 * Admins see the whole organization; team heads see themself + downline + their
 * team; agents see themself + downline only. Includes per-node booking stats.
 */
export const getNetwork = asyncHandler(async (req, res) => {
  const visible = await getVisibleUserIds(req.user); // null = unrestricted
  const params = [];
  let where = 'u.is_active = true';
  if (visible) { params.push(visible); where += ` AND u.id = ANY($${params.length})`; }

  const { rows } = await pool.query(
    `SELECT ${NODE_FIELDS},
            (SELECT count(*)::int FROM users c WHERE c.parent_user_id = u.id) AS direct_count,
            (SELECT count(*)::int FROM bookings b WHERE b.agent_user_id = u.id) AS booking_count,
            (SELECT COALESCE(SUM(b.token_amount), 0)::float FROM bookings b WHERE b.agent_user_id = u.id) AS token_total
     FROM users u LEFT JOIN teams t ON t.id = u.team_id
     WHERE ${where}
     ORDER BY u.parent_user_id NULLS FIRST, u.id`,
    params
  );

  // Outside-visibility parents become null so scoped users see their branch as root —
  // never a parent's siblings or other branches.
  const idSet = new Set(rows.map((r) => r.id));
  for (const r of rows) if (r.parent_user_id && !idSet.has(r.parent_user_id)) r.parent_user_id = null;
  res.json({ nodes: rows, scoped: !!visible });
});

/**
 * GET /agents/:id — a single agent's profile + stats + upline. Scoped exactly like
 * the network: admins see anyone; others only agents inside their own hierarchy.
 */
export const getAgent = asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const visible = await getVisibleUserIds(req.user); // null = unrestricted
  if (visible && !visible.includes(id)) {
    return res.status(403).json({ message: 'Not authorised to view this agent' });
  }
  const { rows } = await pool.query(
    `SELECT ${NODE_FIELDS},
            pu.name AS parent_name, pu.referral_code AS parent_referral_code,
            (SELECT count(*)::int FROM users c WHERE c.parent_user_id = u.id) AS direct_count,
            (SELECT count(*)::int FROM users c
               WHERE c.parent_user_id = u.id AND c.agent_status = 'PENDING') AS pending_count,
            (SELECT count(*)::int FROM bookings b WHERE b.agent_user_id = u.id) AS booking_count,
            (SELECT COALESCE(SUM(b.token_amount), 0)::float FROM bookings b WHERE b.agent_user_id = u.id) AS token_total,
            (SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)::float
               FROM agent_ledger_entries l WHERE l.user_id = u.id AND l.status <> 'CANCELLED') AS ledger_balance
     FROM users u
     LEFT JOIN teams t ON t.id = u.team_id
     LEFT JOIN users pu ON pu.id = u.parent_user_id
     WHERE u.id = $1`,
    [id]
  );
  const agent = rows[0];
  if (!agent) return res.status(404).json({ message: 'Agent not found' });
  delete agent.password; delete agent.refresh_token;
  agent.upline = await getUplineChain(id);
  res.json(agent);
});

/** GET /agents/referral/:code — resolve a referral code (for registration UX). */
export const lookupReferral = asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, designation, role, team_id, referral_code FROM users
     WHERE referral_code = $1 AND is_active = true`,
    [String(req.params.code || '').trim().toUpperCase()]
  );
  if (!rows[0]) return res.status(404).json({ message: 'Referral code not found' });
  res.json(rows[0]);
});

/**
 * POST /agents — register an agent.
 * Admin roles may register anyone anywhere. Non-admins need can_register_agents and
 * may ONLY register beneath themselves (their own subtree) — enforced server-side.
 * Parent resolves from referral_code (preferred) or parent_user_id; default = creator.
 * Team/reporting chain follow the parent automatically unless an admin overrides.
 */
export const createAgent = asyncHandler(async (req, res) => {
  const { name, email, phone, password, designation, referral_code, parent_user_id, team_id, can_register_agents } = req.body || {};
  if (!name?.trim() || !email?.trim() || !password) {
    return res.status(400).json({ message: 'name, email and password are required' });
  }

  const admin = isAdminRole(req.user.role);
  if (!admin) {
    const { rows } = await pool.query('SELECT can_register_agents FROM users WHERE id = $1', [req.user.id]);
    if (!rows[0]?.can_register_agents) {
      return res.status(403).json({ message: 'You are not permitted to register agents' });
    }
  }

  // Resolve parent: referral code > explicit id > creator.
  let parent = null;
  if (referral_code) {
    const { rows } = await pool.query('SELECT id, team_id FROM users WHERE referral_code = $1 AND is_active = true', [String(referral_code).trim().toUpperCase()]);
    if (!rows[0]) return res.status(400).json({ message: 'Invalid referral code' });
    parent = rows[0];
  } else if (parent_user_id) {
    const { rows } = await pool.query('SELECT id, team_id FROM users WHERE id = $1 AND is_active = true', [parent_user_id]);
    if (!rows[0]) return res.status(400).json({ message: 'Parent user not found' });
    parent = rows[0];
  } else {
    const { rows } = await pool.query('SELECT id, team_id FROM users WHERE id = $1', [req.user.id]);
    parent = rows[0];
  }

  // Anti-spoofing: non-admins can only attach new agents inside their own subtree.
  if (!admin) {
    const downline = await getDownlineIds(req.user.id);
    if (!downline.includes(Number(parent.id))) {
      return res.status(403).json({ message: 'You can only register agents under your own network' });
    }
  }

  const { rows: dupe } = await pool.query('SELECT 1 FROM users WHERE lower(email) = lower($1)', [email.trim()]);
  if (dupe.length) return res.status(409).json({ message: 'A user with this email already exists' });

  const resolvedTeam = admin && team_id !== undefined ? (team_id || null) : (parent.team_id || null);
  const code = await generateReferralCode();
  const hash = await bcrypt.hash(String(password), 10);

  const { rows: created } = await pool.query(
    `INSERT INTO users (name, email, phone, password, role, is_active, created_by,
                        parent_user_id, referral_code, designation, agent_status, team_id, can_register_agents)
     VALUES ($1, lower($2), $3, $4, 'agent', true, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, name, email, phone, role, designation, referral_code, parent_user_id, team_id, agent_status`,
    [
      name.trim(), email.trim(), phone || null, hash, req.user.id,
      parent.id, code, designation?.trim() || 'Agent',
      admin ? 'ACTIVE' : 'PENDING', // self-registered downline waits for admin approval
      resolvedTeam, admin ? !!can_register_agents : false,
    ]
  );
  const agent = created[0];
  if (resolvedTeam) {
    await pool.query(
      `INSERT INTO team_members (team_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [resolvedTeam, agent.id]
    );
  }
  logActivity(req.user.id, agent.id, 'AGENT_REGISTERED', { via: referral_code ? 'referral' : 'direct', parent: parent.id });
  res.status(201).json(agent);
});

/**
 * PATCH /agents/:id — admin management: approve/suspend, designation, move in the
 * tree (cycle-guarded), team, registration permission, password reset, deactivate.
 */
export const updateAgent = asyncHandler(async (req, res) => {
  if (!isAdminRole(req.user.role)) return res.status(403).json({ message: 'Admin access required' });
  const id = Number(req.params.id);
  const { rows: existing } = await pool.query('SELECT id, role FROM users WHERE id = $1', [id]);
  if (!existing[0]) return res.status(404).json({ message: 'Agent not found' });

  const b = req.body || {};
  const sets = [];
  const params = [];
  const push = (frag, val) => { params.push(val); sets.push(`${frag} $${params.length}`); };

  if (b.agent_status !== undefined) {
    if (!AGENT_STATUSES.has(b.agent_status)) return res.status(400).json({ message: 'Invalid agent_status' });
    push('agent_status =', b.agent_status);
  }
  if (b.designation !== undefined) push('designation =', String(b.designation).trim() || null);
  if (b.can_register_agents !== undefined) push('can_register_agents =', !!b.can_register_agents);
  if (b.is_active !== undefined) push('is_active =', !!b.is_active);
  if (b.new_password) push('password =', await bcrypt.hash(String(b.new_password), 10));
  if (b.parent_user_id !== undefined) {
    if (b.parent_user_id !== null) {
      const { rows } = await pool.query('SELECT id FROM users WHERE id = $1', [b.parent_user_id]);
      if (!rows[0]) return res.status(400).json({ message: 'New parent not found' });
      if (await wouldCreateCycle(id, b.parent_user_id)) {
        return res.status(400).json({ message: 'Cannot move an agent under their own downline' });
      }
    }
    push('parent_user_id =', b.parent_user_id);
  }
  if (b.team_id !== undefined) {
    push('team_id =', b.team_id || null);
    await pool.query('DELETE FROM team_members WHERE user_id = $1', [id]);
    if (b.team_id) {
      await pool.query('INSERT INTO team_members (team_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [b.team_id, id]);
    }
  }
  if (!sets.length) return res.status(400).json({ message: 'Nothing to update' });

  params.push(id);
  const { rows } = await pool.query(
    `UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}
     RETURNING id, name, email, role, designation, referral_code, parent_user_id, team_id, agent_status, can_register_agents, is_active`,
    params
  );
  logActivity(req.user.id, id, 'AGENT_UPDATED', b);
  res.json(rows[0]);
});

/** GET /agents/:id/ledger — entries + balances. Admin, self, or upline manager. */
export const getLedger = asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!isAdminRole(req.user.role) && req.user.id !== id) {
    const downline = await getDownlineIds(req.user.id);
    if (!downline.includes(id)) return res.status(403).json({ message: 'Not authorised for this ledger' });
  }
  const [entries, summary] = await Promise.all([
    pool.query(
      `SELECT id, entry_type, direction, amount::float, status, booking_id, narration, meta, created_at
       FROM agent_ledger_entries WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [id]
    ),
    pool.query(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)::float AS balance,
              COALESCE(SUM(amount) FILTER (WHERE direction = 'CREDIT' AND status = 'PENDING'), 0)::float AS pending_credit,
              COALESCE(SUM(amount) FILTER (WHERE direction = 'CREDIT' AND status = 'PAID'), 0)::float AS paid_out
       FROM agent_ledger_entries WHERE user_id = $1 AND status <> 'CANCELLED'`,
      [id]
    ),
  ]);
  res.json({ user_id: id, ...summary.rows[0], entries: entries.rows });
});

/** POST /agents/:id/ledger — admin-only manual entry (bonus/penalty/incentive/…). */
export const addLedgerEntry = asyncHandler(async (req, res) => {
  if (!isAdminRole(req.user.role)) return res.status(403).json({ message: 'Admin access required' });
  const id = Number(req.params.id);
  const { entry_type, direction, amount, narration, booking_id, status } = req.body || {};
  if (!LEDGER_TYPES.has(entry_type)) return res.status(400).json({ message: `entry_type must be one of ${[...LEDGER_TYPES].join(', ')}` });
  if (!['CREDIT', 'DEBIT'].includes(direction)) return res.status(400).json({ message: 'direction must be CREDIT or DEBIT' });
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ message: 'amount must be a positive number' });

  const { rows } = await pool.query(
    `INSERT INTO agent_ledger_entries (user_id, entry_type, direction, amount, status, booking_id, narration, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [id, entry_type, direction, amt, status && ['PENDING', 'APPROVED', 'PAID'].includes(status) ? status : 'PENDING',
      booking_id || null, narration || null, req.user.id]
  );
  logActivity(req.user.id, id, 'LEDGER_ENTRY_ADDED', { entry_type, direction, amount: amt });
  res.status(201).json(rows[0]);
});
