import MasterModel from './MasterModel.js';

class KycCaseModel extends MasterModel {
  constructor() {
    super('kyc_cases');
  }

  async findByBooking(bookingId, pool) {
    const { rows } = await pool.query(
      'SELECT * FROM kyc_cases WHERE booking_id = $1 ORDER BY id ASC',
      [bookingId]
    );
    return rows;
  }

  /** Get the open case for a booking, or create one (MANUAL_OCR by default). */
  async getOrCreateForBooking(booking, pool) {
    const existing = await pool.query(
      `SELECT * FROM kyc_cases WHERE booking_id = $1 ORDER BY id DESC LIMIT 1`,
      [booking.id]
    );
    if (existing.rows[0]) return existing.rows[0];
    return this.create({
      booking_id: booking.id,
      client_member_id: booking.client_member_id,
      site_id: booking.site_id,
      mode: 'MANUAL_OCR',
      status: 'OPEN',
      created_by: booking.created_by || null,
    }, pool);
  }

  /**
   * Member-anchored case (no booking yet — the agent "New KYC" flow).
   * Reuses the member's open booking-less case when the requester can see it
   * (visibleUserIds null = admin, unrestricted), else opens one they own.
   */
  async getOrCreateForMember({ memberId, siteId, createdBy, visibleUserIds }, pool) {
    const existing = await pool.query(
      `SELECT * FROM kyc_cases
        WHERE client_member_id = $1 AND booking_id IS NULL
        ORDER BY id DESC`,
      [memberId]
    );
    const usable = existing.rows.find(
      (c) => !Array.isArray(visibleUserIds) || (c.created_by && visibleUserIds.includes(c.created_by))
    );
    if (usable) return usable;
    return this.create({
      booking_id: null,
      client_member_id: memberId,
      site_id: siteId || null,
      mode: 'MANUAL_OCR',
      status: 'OPEN',
      created_by: createdBy || null,
    }, pool);
  }

  /**
   * List cases with member/booking labels + document progress.
   * `visibleUserIds` (array | null) scopes rows for non-admins — cases they opened,
   * or cases on bookings they own/created (legacy booking-tied cases).
   */
  async list({ siteId, status, pending, q, visibleUserIds }, pool) {
    const where = [];
    const params = [];
    if (siteId) { params.push(siteId); where.push(`k.site_id = $${params.length}`); }
    if (status) { params.push(status); where.push(`k.status = $${params.length}`); }
    if (pending) where.push(`k.status NOT IN ('VERIFIED','REJECTED')`);
    if (q) {
      params.push(`%${q}%`);
      where.push(`(m.full_name ILIKE $${params.length} OR m.phone ILIKE $${params.length} OR m.aadhar_no ILIKE $${params.length} OR m.pan_no ILIKE $${params.length})`);
    }
    if (Array.isArray(visibleUserIds)) {
      params.push(visibleUserIds);
      where.push(`(k.created_by = ANY($${params.length})
                   OR b.agent_user_id = ANY($${params.length})
                   OR b.created_by = ANY($${params.length}))`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const { rows } = await pool.query(`
      SELECT k.*,
             m.full_name AS client_name, m.phone AS client_phone, m.photo AS client_photo,
             m.aadhar_no AS client_aadhar, m.pan_no AS client_pan,
             b.booking_no,
             u.name AS created_by_name, u.referral_code AS created_by_code,
             s.name AS site_name,
             (SELECT count(*)::int FROM documents d WHERE d.kyc_case_id = k.id) AS document_count,
             (SELECT count(*)::int FROM documents d WHERE d.kyc_case_id = k.id AND d.ocr_status = 'DONE') AS ocr_done_count,
             (SELECT count(*)::int FROM documents d WHERE d.kyc_case_id = k.id AND d.ocr_status IN ('PENDING','PROCESSING')) AS ocr_pending_count
      FROM kyc_cases k
      LEFT JOIN members  m ON m.id = k.client_member_id
      LEFT JOIN bookings b ON b.id = k.booking_id
      LEFT JOIN users    u ON u.id = k.created_by
      LEFT JOIN sites    s ON s.id = k.site_id
      ${whereSql}
      ORDER BY k.created_at DESC
      LIMIT 500
    `, params);
    return rows;
  }

  /** Case + member/booking/creator labels (header data for the KYC workspace). */
  async getDetail(id, pool) {
    const { rows } = await pool.query(`
      SELECT k.*,
             m.full_name AS client_name, m.phone AS client_phone, m.email AS client_email,
             m.photo AS client_photo, m.aadhar_no AS client_aadhar, m.pan_no AS client_pan,
             m.father_name AS client_father, m.date_of_birth AS client_dob,
             m.address AS client_address, m.city AS client_city, m.state AS client_state,
             m.pincode AS client_pincode,
             b.booking_no, b.status AS booking_status,
             u.name AS created_by_name, u.referral_code AS created_by_code,
             s.name AS site_name
      FROM kyc_cases k
      LEFT JOIN members  m ON m.id = k.client_member_id
      LEFT JOIN bookings b ON b.id = k.booking_id
      LEFT JOIN users    u ON u.id = k.created_by
      LEFT JOIN sites    s ON s.id = k.site_id
      WHERE k.id = $1
    `, [id]);
    return rows[0];
  }

  /** Documents of a case with the latest OCR result attached. */
  async getDocumentsWithResults(caseId, pool) {
    const { rows } = await pool.query(`
      SELECT d.*,
             r.extracted_fields, r.confidence_overall, r.confidence_map, r.raw_text, r.processed_at
      FROM documents d
      LEFT JOIN LATERAL (
        SELECT * FROM ocr_results o WHERE o.document_id = d.id ORDER BY o.id DESC LIMIT 1
      ) r ON true
      WHERE d.kyc_case_id = $1
      ORDER BY d.id ASC
    `, [caseId]);
    return rows;
  }
}

export default new KycCaseModel();
