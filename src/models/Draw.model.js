import { WORKFLOW_STAGE_SQL } from '../services/drawWorkflow.js';
import MasterModel from './MasterModel.js';

class DrawModel extends MasterModel {
  constructor() {
    super('draw_registrations');
  }

  /**
   * Newest active entry of this client in this draw + how many they hold. Extra
   * entries in the same draw carry keys "<key>#ENTRY-2", "<key>#ENTRY-3"… so the unique index
   * still blocks accidental duplicates. Includes legacy rows without keys.
   */
  async findActiveEnrollment({ siteId, clientMemberId, key, name, excludeId = null }, db) {
    const { rows } = await db.query(`
      SELECT id, registration_no, agent_user_id, created_by, count(*) OVER () AS entry_count,
             max(CASE WHEN substr(enrollment_key, length($3) + 1) ~ '^#ENTRY-[0-9]+$'
                      THEN substr(enrollment_key, length($3) + 8)::int ELSE 1 END) OVER () AS last_entry_no
        FROM draw_registrations
      WHERE site_id = $1 AND client_member_id = $2 AND status <> 'CANCELLED'
        AND (enrollment_key = $3 OR left(enrollment_key, length($3) + 7) = $3 || '#ENTRY-' OR (enrollment_key IS NULL
          AND upper(regexp_replace(btrim(COALESCE(scheme_name, '')), '\\s+', ' ', 'g')) = $4))
        AND ($5::integer IS NULL OR id <> $5)
      ORDER BY id DESC LIMIT 1`, [siteId, clientMemberId, key, (name || '').toUpperCase(), excludeId]);
    return rows[0] || null;
  }

  /**
   * The customer's KYC case for a registration: the linked r.kyc_case_id when it
   * still exists; legacy rows fall back to the member's newest case. New intake
   * links a pending KYC immediately. The legacy fallback matters because
   * adoptForBooking deletes duplicate cases (FK sets our link NULL) and because
   * registrations created before migration 013 never had a link.
   * NB: kyc.id/kyc.status are selected AFTER r.* so the resolved values win.
   */
  get kycCaseLateral() {
    return `
      SELECT kc.id, kc.status FROM kyc_cases kc
      WHERE (kc.id = r.kyc_case_id OR (r.workflow_version = 0 AND kc.client_member_id = r.client_member_id)) AND kc.site_id = r.site_id
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
             au.name AS agent_name, au.referral_code AS agent_referral_code, bm.full_name AS broker_name,
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
      LEFT JOIN members bm ON bm.id = r.broker_member_id
      LEFT JOIN plots   p ON p.id = r.allotted_plot_id
      LEFT JOIN LATERAL (${this.kycCaseLateral}) kyc ON true
      ${whereSql}
      ORDER BY r.created_at DESC
      LIMIT 500
    `, params);
    return rows;
  }

  /** Bounded workflow queue: scoped counts and one page, never all customer dossiers. */
  /**
   * Booking Payments queue. Filters (all optional): q, registration date range
   * (IST), broker (code or name), scheme, kyc VERIFIED|PENDING, payment
   * PAID|PARTIAL|UNPAID, method DIRECT|WEBSITE; stage splits what remains. Stage
   * counts and totals respect every filter except stage. pageSize 'all' → up to
   * 5000 rows (statements).
   */
  async workflow({ siteId, q = '', stage, page = 1, pageSize = 25, filters = {}, visibleUserIds }, db) {
    const { rows: websiteTables } = await db.query("SELECT to_regclass('public.website_booking_requests') IS NOT NULL AS has_website_requests");
    const bookingMethod = websiteTables[0]?.has_website_requests
      ? `CASE WHEN EXISTS (SELECT 1 FROM website_booking_requests w
          WHERE w.booking_id = r.booking_id AND w.site_id = r.site_id AND w.status = 'APPROVED')
          THEN 'WEBSITE' ELSE 'DIRECT' END`
      : "'DIRECT'::text";
    const params = [siteId];
    const where = ['r.site_id = $1'];
    if (Array.isArray(visibleUserIds)) {
      params.push(visibleUserIds);
      where.push(`(r.agent_user_id = ANY($${params.length}) OR r.created_by = ANY($${params.length}))`);
    }
    if (q) {
      params.push(`%${q.slice(0, 100)}%`);
      where.push(`(m.full_name ILIKE $${params.length} OR m.phone ILIKE $${params.length} OR r.registration_no ILIKE $${params.length} OR r.slip_no ILIKE $${params.length} OR r.scheme_name ILIKE $${params.length})`);
    }
    const cte = `WITH queue AS (
      SELECT r.id, r.registration_no, r.slip_no, r.status, r.required_amount, r.scheme_name,
        r.draw_opening_date, r.booking_id, r.created_at, r.broker_code,
        (r.created_at AT TIME ZONE 'Asia/Kolkata')::date AS registered_on,
        ${bookingMethod} AS booking_method,
        COALESCE(NULLIF(BTRIM(draw_broker.full_name), ''), NULLIF(BTRIM(broker_member.full_name), ''),
          NULLIF(BTRIM(registration_broker.name), ''), NULLIF(BTRIM(booking_broker.name), '')) AS broker_name,
        m.full_name AS client_name, m.phone AS client_phone,
        kyc.status AS kyc_status, COALESCE(pay.total_paid, 0) AS total_paid,
        ${WORKFLOW_STAGE_SQL} AS stage
      FROM draw_registrations r
      JOIN members m ON m.id = r.client_member_id
      LEFT JOIN bookings b ON b.id = r.booking_id AND b.site_id = r.site_id
      LEFT JOIN members broker_member ON broker_member.id = b.booking_agent_id AND broker_member.site_id = r.site_id
      LEFT JOIN members draw_broker ON draw_broker.id = r.broker_member_id
      LEFT JOIN users registration_broker ON registration_broker.id = r.agent_user_id
      LEFT JOIN users booking_broker ON booking_broker.id = b.agent_user_id
      LEFT JOIN LATERAL (${this.kycCaseLateral}) kyc ON true
      LEFT JOIN LATERAL (SELECT SUM(amount) AS total_paid FROM draw_payments WHERE draw_registration_id = r.id) pay ON true
      WHERE ${where.join(' AND ')}
    )`;
    // Filters on computed queue columns (payment, KYC, method, broker) apply in `scoped`.
    const scoped = [];
    const add = (value, sql) => { params.push(value); scoped.push(sql.replaceAll('$?', `$${params.length}`)); };
    if (filters.date_from) add(filters.date_from, 'registered_on >= $?::date');
    if (filters.date_to) add(filters.date_to, 'registered_on <= $?::date');
    if (filters.broker) add(filters.broker, 'COALESCE(broker_code, broker_name) = $?');
    if (filters.scheme) add(filters.scheme, "upper(regexp_replace(btrim(COALESCE(scheme_name, '')), '\\s+', ' ', 'g')) = upper($?)");
    if (filters.method) add(filters.method, 'booking_method = $?');
    if (filters.kyc === 'VERIFIED') scoped.push("kyc_status = 'VERIFIED'");
    if (filters.kyc === 'PENDING') scoped.push("COALESCE(kyc_status, '') <> 'VERIFIED'");
    if (filters.payment === 'PAID') scoped.push('required_amount > 0 AND total_paid >= required_amount');
    if (filters.payment === 'PARTIAL') scoped.push('total_paid > 0 AND total_paid < required_amount');
    if (filters.payment === 'UNPAID') scoped.push('total_paid = 0');
    const limit = pageSize === 'all' ? 5000 : 25;
    const values = [...params, stage || null, limit, pageSize === 'all' ? 0 : (page - 1) * 25];
    const n = params.length;
    const { rows } = await db.query(`${cte}, scoped AS (
        SELECT * FROM queue ${scoped.length ? `WHERE ${scoped.join(' AND ')}` : ''}
      ), filtered AS (
        SELECT * FROM scoped WHERE ($${n + 1}::text IS NULL OR stage = $${n + 1})
      )
      SELECT (SELECT COALESCE(json_agg(items), '[]'::json) FROM (
        SELECT * FROM filtered
        ORDER BY created_at DESC, id DESC LIMIT $${n + 2} OFFSET $${n + 3}
      ) items) AS items,
      (SELECT count(*)::int FROM filtered) AS total,
      (SELECT json_build_object('total_paid', COALESCE(SUM(total_paid), 0),
        'required_amount', COALESCE(SUM(required_amount), 0)) FROM filtered) AS totals,
      (SELECT COALESCE(json_object_agg(stage, count), '{}'::json) FROM (SELECT stage, count(*)::int FROM scoped GROUP BY stage) counts) AS counts,
      (SELECT json_build_object(
        'brokers', COALESCE((SELECT json_agg(b ORDER BY b->>'name') FROM (SELECT DISTINCT jsonb_build_object('value', COALESCE(broker_code, broker_name), 'name', broker_name, 'code', broker_code) AS b FROM queue WHERE broker_name IS NOT NULL) x), '[]'::json),
        'schemes', COALESCE((SELECT json_agg(DISTINCT scheme_name ORDER BY scheme_name) FROM queue WHERE scheme_name IS NOT NULL), '[]'::json)
      )) AS options`, values);
    return { ...rows[0], page, page_size: limit };
  }

  /**
   * Receipt-level statement for Booking Payments: every draw payment in the period
   * (payment date, IST), optionally narrowed by broker / scheme / mode / search.
   */
  async paymentStatement({ siteId, q = '', filters = {}, visibleUserIds }, db) {
    const params = [siteId];
    const where = ['r.site_id = $1'];
    const add = (value, sql) => { params.push(value); where.push(sql.replaceAll('$?', `$${params.length}`)); };
    if (Array.isArray(visibleUserIds)) add(visibleUserIds, '(r.agent_user_id = ANY($?) OR r.created_by = ANY($?))');
    if (q) add(`%${q.slice(0, 100)}%`, '(m.full_name ILIKE $? OR m.phone ILIKE $? OR r.registration_no ILIKE $? OR r.slip_no ILIKE $? OR dp.receipt_no ILIKE $?)');
    if (filters.date_from) add(filters.date_from, 'dp.payment_date >= $?::date');
    if (filters.date_to) add(filters.date_to, 'dp.payment_date <= $?::date');
    if (filters.broker) add(filters.broker, 'COALESCE(r.broker_code, broker.full_name) = $?');
    if (filters.scheme) add(filters.scheme, "upper(regexp_replace(btrim(COALESCE(r.scheme_name, '')), '\\s+', ' ', 'g')) = upper($?)");
    if (filters.mode === 'CASH') where.push("upper(COALESCE(dp.payment_from, 'CASH')) = 'CASH'");
    if (filters.mode === 'BANK') where.push("upper(COALESCE(dp.payment_from, 'CASH')) <> 'CASH'");
    const { rows } = await db.query(`
      SELECT dp.id, dp.receipt_no, dp.payment_date, dp.amount::float AS amount, dp.payment_from, dp.bank_name,
             dp.bank_details, dp.cheque_no, dp.narration, r.registration_no, r.slip_no, r.scheme_name,
             r.broker_code, broker.full_name AS broker_name, m.full_name AS client_name, m.phone AS client_phone
        FROM draw_payments dp
        JOIN draw_registrations r ON r.id = dp.draw_registration_id
        JOIN members m ON m.id = r.client_member_id
        LEFT JOIN members broker ON broker.id = r.broker_member_id
       WHERE ${where.join(' AND ')}
       ORDER BY dp.payment_date ASC, dp.id ASC
       LIMIT 5000`, params);
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
             au.name AS agent_name, au.referral_code AS agent_referral_code, bm.full_name AS broker_name,
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
      LEFT JOIN members bm ON bm.id = r.broker_member_id
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
