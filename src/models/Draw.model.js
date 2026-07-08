import MasterModel from './MasterModel.js';

class DrawModel extends MasterModel {
  constructor() {
    super('draw_registrations');
  }

  /**
   * The customer's KYC case for a registration: the linked r.kyc_case_id when it
   * still exists, else the member's newest case. The fallback matters because
   * adoptForBooking deletes duplicate cases (FK sets our link NULL) and because
   * registrations created before migration 013 never had a link.
   * NB: kyc.id/kyc.status are selected AFTER r.* so the resolved values win.
   */
  get kycCaseLateral() {
    return `
      SELECT kc.id, kc.status FROM kyc_cases kc
      WHERE kc.id = r.kyc_case_id OR kc.client_member_id = r.client_member_id
      ORDER BY (kc.id = r.kyc_case_id) DESC NULLS LAST, kc.id DESC
      LIMIT 1
    `;
  }

  /** List with joined client/site/agent labels + paid rollup.
   * `visibleUserIds` (array | null) scopes rows to an agent's own network —
   * registrations they own (agent_user_id) or personally created (same rule as bookings). */
  async list({ siteId, status, q, clientMemberId, visibleUserIds }, pool) {
    const where = [];
    const params = [];
    if (siteId) { params.push(siteId); where.push(`r.site_id = $${params.length}`); }
    if (status) { params.push(status); where.push(`r.status = $${params.length}`); }
    if (clientMemberId) { params.push(clientMemberId); where.push(`r.client_member_id = $${params.length}`); }
    if (Array.isArray(visibleUserIds)) {
      params.push(visibleUserIds);
      where.push(`(r.agent_user_id = ANY($${params.length}) OR r.created_by = ANY($${params.length}))`);
    }
    if (q) {
      params.push(`%${q}%`);
      where.push(`(r.registration_no ILIKE $${params.length} OR r.slip_no ILIKE $${params.length} OR r.scheme_name ILIKE $${params.length} OR m.full_name ILIKE $${params.length} OR m.phone ILIKE $${params.length})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const { rows } = await pool.query(`
      SELECT r.*,
             m.full_name AS client_name, m.phone AS client_phone, m.photo AS client_photo,
             s.name AS site_name,
             au.name AS agent_name, au.referral_code AS agent_referral_code,
             p.plot_no AS allotted_plot_no, p.block AS allotted_plot_block,
             kyc.id AS kyc_case_id, kyc.status AS kyc_status,
             COALESCE((SELECT SUM(dp.amount) FROM draw_payments dp
                        WHERE dp.draw_registration_id = r.id), 0)::float AS total_paid,
             (SELECT count(*)::int FROM draw_payments dp
               WHERE dp.draw_registration_id = r.id) AS payment_count
      FROM draw_registrations r
      LEFT JOIN members m ON m.id = r.client_member_id
      LEFT JOIN sites   s ON s.id = r.site_id
      LEFT JOIN users  au ON au.id = r.agent_user_id
      LEFT JOIN plots   p ON p.id = r.allotted_plot_id
      LEFT JOIN LATERAL (${this.kycCaseLateral}) kyc ON true
      ${whereSql}
      ORDER BY r.created_at DESC
      LIMIT 500
    `, params);
    return rows;
  }

  /** Full detail: registration + client + site + agent + allotted plot + booking labels. */
  async getDetail(id, pool) {
    const { rows } = await pool.query(`
      SELECT r.*,
             m.full_name AS client_name, m.phone AS client_phone, m.email AS client_email,
             m.photo AS client_photo, m.address AS client_address, m.city AS client_city,
             m.state AS client_state, m.pincode AS client_pincode,
             m.father_name AS client_father, m.aadhar_no AS client_aadhar, m.pan_no AS client_pan,
             s.name AS site_name, s.address AS site_address, s.city AS site_city, s.state AS site_state,
             au.name AS agent_name, au.referral_code AS agent_referral_code,
             p.plot_no AS allotted_plot_no, p.block AS allotted_plot_block, p.plot_size AS allotted_plot_size,
             b.booking_no, b.status AS booking_status, b.kyc_status AS booking_kyc_status,
             wu.name AS winner_marked_by_name,
             lu.name AS allotted_by_name,
             cu.name AS created_by_name, cu.role AS created_by_role, cu.referral_code AS created_by_code,
             kyc.id AS kyc_case_id, kyc.status AS kyc_status
      FROM draw_registrations r
      LEFT JOIN members m ON m.id = r.client_member_id
      LEFT JOIN sites   s ON s.id = r.site_id
      LEFT JOIN users  au ON au.id = r.agent_user_id
      LEFT JOIN plots   p ON p.id = r.allotted_plot_id
      LEFT JOIN bookings b ON b.id = r.booking_id
      LEFT JOIN users  wu ON wu.id = r.winner_marked_by
      LEFT JOIN users  lu ON lu.id = r.allotted_by
      LEFT JOIN users  cu ON cu.id = r.created_by
      LEFT JOIN LATERAL (${this.kycCaseLateral}) kyc ON true
      WHERE r.id = $1
    `, [id]);
    return rows[0];
  }

  async findByQrToken(token, pool) {
    const { rows } = await pool.query(
      'SELECT id FROM draw_registrations WHERE qr_token = $1 LIMIT 1',
      [token]
    );
    return rows[0];
  }

  /** Ledger rows for one registration, oldest first (a running ledger). */
  async getPayments(registrationId, pool) {
    const { rows } = await pool.query(`
      SELECT dp.*, u.name AS created_by_name
      FROM draw_payments dp
      LEFT JOIN users u ON u.id = dp.created_by
      WHERE dp.draw_registration_id = $1
      ORDER BY dp.payment_date ASC, dp.id ASC
    `, [registrationId]);
    return rows;
  }

  async getTotalPaid(registrationId, db) {
    const { rows } = await db.query(
      'SELECT COALESCE(SUM(amount), 0)::float AS total FROM draw_payments WHERE draw_registration_id = $1',
      [registrationId]
    );
    return rows[0].total;
  }

  async getEvents(registrationId, pool) {
    const { rows } = await pool.query(`
      SELECT e.*, u.name AS actor_name
      FROM draw_events e
      LEFT JOIN users u ON u.id = e.actor_user_id
      WHERE e.draw_registration_id = $1
      ORDER BY e.created_at ASC, e.id ASC
    `, [registrationId]);
    return rows;
  }

  /**
   * Append an audit event. THROWS on failure — deliberately. Inside a transaction a
   * swallowed statement error would poison it (Postgres turns the later COMMIT into
   * a silent ROLLBACK while the code believes it committed). Transactional callers
   * let it roll everything back; best-effort pool callers add `.catch(() => {})`.
   */
  async logEvent(registrationId, eventType, detail, actorUserId, db) {
    await db.query(
      `INSERT INTO draw_events (draw_registration_id, event_type, detail, actor_user_id)
       VALUES ($1, $2, $3, $4)`,
      [registrationId, eventType, detail ? JSON.stringify(detail) : null, actorUserId || null]
    );
  }

  /** Generate a human registration number like DRW-2026-000123 (id-derived, unique). */
  async generateRegistrationNo(id, createdAt, pool) {
    const year = (createdAt ? new Date(createdAt) : new Date()).getFullYear();
    const no = `DRW-${year}-${String(id).padStart(6, '0')}`;
    await pool.query('UPDATE draw_registrations SET registration_no = $1 WHERE id = $2 AND registration_no IS NULL', [no, id]);
    return no;
  }

  /** Receipt number for a ledger payment, like DRC-2026-000456 (id-derived, unique). */
  async generateReceiptNo(paymentId, db) {
    const no = `DRC-${new Date().getFullYear()}-${String(paymentId).padStart(6, '0')}`;
    await db.query('UPDATE draw_payments SET receipt_no = $1 WHERE id = $2 AND receipt_no IS NULL', [no, paymentId]);
    return no;
  }
}

export default new DrawModel();
