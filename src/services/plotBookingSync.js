import pool from '../config/db.js';

/**
 * Plot-booking → accounting sync.
 *
 * When a KYC booking is created/updated with a plot assigned, propagate it into the
 * SHARED accounting `plots` ledger so the plot shows up as BOOKED on /plot-payments:
 *   • plots.status      → 'BOOKED'
 *   • plots.buyer_name  → the booking's client (member full_name)
 *   • plots.booking_by  → the "Booking By" person (agent override, else the KYC login user)
 *   • plots.booking_date→ the booking date
 * …and then AUTO-CREATE the agent commission EXACTLY like the accounting backend does
 * (plot.controller.js → maybeAutoCreatePlotCommission): the commission amount is the
 * one DECIDED AT PLOT CREATION in the accounting app (plots.plot_commission, i.e.
 * size × commission_rate), and it is assigned to the "Booking By" member at that site.
 *
 * Design notes:
 *   - Writes directly to the shared DB — the same additive pattern the booking module
 *     already uses for client-sync (createClient → members). No HTTP coupling.
 *   - Fully defensive: any failure here is logged and swallowed so it can NEVER break
 *     booking creation. Commission table absence (42P01) is ignored.
 *   - Idempotent: re-running for the same booking will not duplicate a commission
 *     (guarded on the (plot_id, agent_id) pair, mirroring the accounting flow).
 */

// Statuses we will NOT overwrite when the plot is already committed to a DIFFERENT
// buyer — protects against clobbering a real sale/registry on a plot the booker
// picked by mistake. Fresh/holding statuses are always bookable.
const PROTECTED_STATUSES = new Set(['SOLD', 'REGISTRY', 'UNDER CANCELLATION', 'CANCELLED', 'TRANSFERRED']);

/**
 * Resolve the "Booking By" name + (optional) commission agent member id.
 *  - Agent override picked in the form → use that member (must be at the plot's site).
 *  - Otherwise → the logged-in KYC user's name; commission attaches only if a member
 *    with that name exists at the plot's site (same as accounting's name match).
 */
const resolveBookingBy = async ({ booking, plotSiteId }, db) => {
  // 1) Explicit agent override.
  if (booking.booking_agent_id) {
    const { rows } = await db.query(
      `SELECT id, full_name, site_id FROM members WHERE id = $1`,
      [parseInt(booking.booking_agent_id)]
    );
    const agent = rows[0];
    if (agent && parseInt(agent.site_id) === parseInt(plotSiteId)) {
      return { bookingByName: agent.full_name, agentId: agent.id };
    }
    // Agent override exists but is at a different site — keep its NAME for the
    // booking_by label, but resolve the commission member by name at the plot site.
    if (agent) {
      const matched = await matchMemberByName(agent.full_name, plotSiteId, db);
      return { bookingByName: agent.full_name, agentId: matched?.id || null };
    }
  }

  // 2) Fallback to the logged-in KYC user who created the booking. Admins/sub-admins
  //    always exist in `users` (that's how they logged in) but may not be a member at
  //    this site — so we provision an EMPLOYEE (staff) member for them so the commission
  //    attaches and shows on /plot-commission, exactly like any other agent. They are
  //    staff, NOT external brokers, hence member_type EMPLOYEE.
  if (booking.created_by) {
    const ensured = await ensureMemberForUser(
      { userId: booking.created_by, siteId: plotSiteId, createdBy: booking.created_by },
      db
    );
    if (ensured) {
      return { bookingByName: ensured.full_name, agentId: ensured.id, autoCreatedMember: ensured.created };
    }
  }
  return { bookingByName: null, agentId: null };
};

/**
 * Resolve a commission-eligible member for a login user AT a given site:
 *  - reuse an existing member with the same name at that site, else
 *  - create an EMPLOYEE (staff) member from the user's profile (name/email/phone/photo).
 * Login users are staff (admin/sub_admin) — classified EMPLOYEE, not BROKER. Site-scoped
 * members mirror how agents are already stored (one row per site).
 */
const ensureMemberForUser = async ({ userId, siteId, createdBy }, db) => {
  const { rows } = await db.query(
    `SELECT id, name, email, phone, photo FROM users WHERE id = $1`,
    [parseInt(userId)]
  );
  const u = rows[0];
  if (!u || !u.name) return null;

  const existing = await matchMemberByName(u.name, siteId, db);
  if (existing) return { id: existing.id, full_name: existing.full_name, created: false };

  const ins = await db.query(
    `INSERT INTO members (site_id, member_type, status, full_name, email, phone, photo, notes, created_by)
     VALUES ($1, 'EMPLOYEE', 'ACTIVE', $2, $3, $4, $5, $6, $7)
     RETURNING id, full_name`,
    [
      parseInt(siteId),
      u.name,
      u.email || null,
      u.phone || null,
      u.photo || null,
      'Auto-created from Booking KYC (login user / staff)',
      createdBy ? parseInt(createdBy) : null,
    ]
  );
  return { id: ins.rows[0].id, full_name: ins.rows[0].full_name, created: true };
};

const matchMemberByName = async (name, siteId, db) => {
  if (!name) return null;
  const { rows } = await db.query(
    `SELECT id, full_name FROM members
      WHERE site_id = $1 AND UPPER(full_name) = UPPER($2)
      ORDER BY id ASC LIMIT 1`,
    [parseInt(siteId), name]
  );
  return rows[0] || null;
};

/**
 * Replicates accounting's maybeAutoCreatePlotCommission essential path:
 * commission = plots.plot_commission (decided at plot creation) — falling back to
 * commission_rate × plot_size — assigned to the resolved agent. Skips duplicates.
 */
const autoCreateCommission = async ({ plot, agentId, createdBy }, db) => {
  if (!agentId) return { created: false, reason: 'no_matching_agent_member' };

  let totalCommission = parseFloat(plot.plot_commission) || 0;
  if (totalCommission <= 0) {
    const rate = parseFloat(plot.commission_rate) || 0;
    const size = parseFloat(plot.plot_size) || 0;
    totalCommission = Math.round(rate * size * 100) / 100;
  }
  if (totalCommission <= 0) return { created: false, reason: 'no_commission_amount' };

  try {
    // Idempotency guard — never duplicate a (plot, agent) commission.
    const existing = await db.query(
      `SELECT id FROM plot_commissions_v2 WHERE plot_id = $1 AND agent_id = $2 LIMIT 1`,
      [parseInt(plot.id), parseInt(agentId)]
    );
    if (existing.rows[0]) return { created: false, reason: 'already_exists', commissionId: existing.rows[0].id };

    const ins = await db.query(
      `INSERT INTO plot_commissions_v2 (site_id, plot_id, agent_id, total_commission, remarks, status, created_by)
       VALUES ($1, $2, $3, $4, $5, 'Pending', $6)
       RETURNING id`,
      [
        parseInt(plot.site_id),
        parseInt(plot.id),
        parseInt(agentId),
        totalCommission,
        'Auto-created from Booking KYC',
        createdBy ? parseInt(createdBy) : null,
      ]
    );
    return { created: true, commissionId: ins.rows[0]?.id, total_commission: totalCommission };
  } catch (err) {
    if (err?.code === '42P01') return { created: false, reason: 'commission_table_missing' };
    throw err;
  }
};

/**
 * Retire a previous Booking-By agent's AUTO-created commission on this plot when it
 * has no recorded payments. Scoped to auto-created rows (either sync source) so a
 * manually-entered commission is never touched. Best-effort; ignores missing tables.
 */
const retirePreviousAutoCommission = async ({ plotId, siteId, prevName }, db) => {
  try {
    await db.query(
      `DELETE FROM plot_commissions_v2 pc
         USING members m
        WHERE pc.plot_id = $1
          AND pc.site_id = $2
          AND pc.agent_id = m.id
          AND UPPER(m.full_name) = UPPER($3)
          AND pc.remarks LIKE 'Auto-created from%'
          AND NOT EXISTS (
            SELECT 1 FROM plot_commission_payments p WHERE p.plot_commission_id = pc.id
          )`,
      [parseInt(plotId), parseInt(siteId), prevName]
    );
  } catch (err) {
    if (err?.code !== '42P01') console.error('[plotBookingSync] retire prev commission failed:', err.message);
  }
};

/**
 * Main entry. `booking` must have: id, plot_id, site_id, client_member_id,
 * created_by, booking_date, booking_agent_id.
 * Returns a summary object; never throws (errors are logged + returned as { ok:false }).
 */
export const syncPlotBookingToAccounting = async (booking, db = pool) => {
  try {
    if (!booking?.plot_id) return { ok: true, skipped: 'no_plot' };

    // Load the accounting plot.
    const plotRes = await db.query(
      `SELECT id, site_id, plot_no, status, buyer_name, booking_by, plot_size, plot_rate,
              commission_rate, plot_commission
         FROM plots WHERE id = $1`,
      [parseInt(booking.plot_id)]
    );
    const plot = plotRes.rows[0];
    if (!plot) return { ok: false, reason: 'plot_not_found' };

    // Resolve the buyer (client) name.
    const clientRes = await db.query(
      `SELECT full_name FROM members WHERE id = $1`,
      [parseInt(booking.client_member_id)]
    );
    const buyerName = clientRes.rows[0]?.full_name || null;
    if (!buyerName) return { ok: false, reason: 'client_not_found' };

    // Guard: don't overwrite a plot already committed to a DIFFERENT buyer.
    const existingBuyer = (plot.buyer_name || '').trim();
    const isDifferentBuyer = existingBuyer && existingBuyer.toUpperCase() !== buyerName.trim().toUpperCase();
    if (isDifferentBuyer && PROTECTED_STATUSES.has(String(plot.status || '').toUpperCase())) {
      return { ok: false, reason: 'plot_committed_to_other_buyer', plot_no: plot.plot_no, current_buyer: existingBuyer, current_status: plot.status };
    }

    // Resolve "Booking By" + commission agent.
    const { bookingByName, agentId, autoCreatedMember } = await resolveBookingBy({ booking, plotSiteId: plot.site_id }, db);

    // Flip the accounting plot to BOOKED. Names upper-cased to match accounting convention.
    await db.query(
      `UPDATE plots
          SET status       = 'BOOKED',
              buyer_name   = $1,
              booking_by   = COALESCE($2, booking_by),
              booking_date = COALESCE(booking_date, $3),
              updated_at   = NOW()
        WHERE id = $4`,
      [
        buyerName.trim().toUpperCase(),
        bookingByName ? bookingByName.trim().toUpperCase() : null,
        booking.booking_date || null,
        parseInt(plot.id),
      ]
    );

    // If the Booking By changed on a re-sync, retire the PREVIOUS agent's orphaned
    // auto-commission (mirrors accounting's updatePlot behaviour) — but only when it
    // carries NO payments, so money is never lost.
    const prevBookingBy = (plot.booking_by || '').trim();
    if (prevBookingBy && bookingByName && prevBookingBy.toUpperCase() !== bookingByName.trim().toUpperCase()) {
      await retirePreviousAutoCommission({ plotId: plot.id, siteId: plot.site_id, prevName: prevBookingBy }, db);
    }

    // Auto-create the agent commission (the "account software flow", unchanged).
    const commission = await autoCreateCommission({ plot, agentId, createdBy: booking.created_by }, db);

    return {
      ok: true,
      plot_id: plot.id,
      plot_no: plot.plot_no,
      buyer_name: buyerName,
      booking_by: bookingByName,
      agent_id: agentId,
      auto_created_member: !!autoCreatedMember,
      commission,
    };
  } catch (err) {
    console.error('[plotBookingSync] failed for booking', booking?.id, '-', err.message);
    return { ok: false, reason: 'error', error: err.message };
  }
};

export default syncPlotBookingToAccounting;
