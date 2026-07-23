import MasterModel from './MasterModel.js';

class KycCaseModel extends MasterModel {
  constructor() {
    super('kyc_cases');
  }

  async findByBooking(bookingId, pool) {
    const { rows } = await pool.query(
      `SELECT k.*,
              m.id AS account_member_id,
              m.member_type,
              m.member_type AS registration_role,
              m.member_type AS role
         FROM kyc_cases k
         LEFT JOIN members m ON m.id = k.client_member_id
        WHERE k.booking_id = $1
        ORDER BY k.id ASC`,
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
   * Adopt the customer's pre-existing KYC into a freshly-created booking:
   * member-anchored cases (opened by an agent before this booking existed) AND cases
   * stranded on the member's CANCELLED bookings, so a re-booking never restarts KYC
   * from zero. Keeps exactly ONE case per booking (strongest wins, others' documents
   * fold into it), rolls the booking's kyc_status up from the surviving case, and
   * opens a fresh case when the member had none. Shared by createBooking and the
   * draw-allotment flow. Returns the number of adopted cases.
   */
  async adoptForBooking(booking, pool) {
    const { rows: adopted } = await pool.query(
      `UPDATE kyc_cases k SET booking_id = $1, updated_at = now()
        WHERE k.client_member_id = $2
          AND (k.booking_id IS NULL
               OR EXISTS (SELECT 1 FROM bookings ob WHERE ob.id = k.booking_id AND ob.status = 'CANCELLED'))
        RETURNING k.id, k.status`,
      [booking.id, booking.client_member_id]
    );

    if (!adopted.length) {
      // No pre-booking KYC — open a fresh case so the UI can immediately accept uploads.
      await this.getOrCreateForBooking(booking, pool);
      return 0;
    }

    // Exactly ONE case per booking: the workspace UI, uploads and verify must all agree
    // on the authoritative case. Keep the strongest (newest on ties), fold the others'
    // documents into it, and delete the emptied duplicates.
    const rank = { OPEN: 0, REJECTED: 0, OCR_PENDING: 1, OCR_DONE: 2, VERIFIED: 3 };
    const sorted = [...adopted].sort((a, b) => (rank[b.status] ?? 0) - (rank[a.status] ?? 0) || b.id - a.id);
    const best = sorted[0];
    const losers = sorted.slice(1).map((c) => c.id);
    if (losers.length) {
      await pool.query('UPDATE documents SET kyc_case_id = $1, updated_at = now() WHERE kyc_case_id = ANY($2)', [best.id, losers]);
      await pool.query('DELETE FROM kyc_cases WHERE id = ANY($1)', [losers]);
    }

    // Roll the booking's KYC status up from the surviving case.
    const kycStatus = { OCR_PENDING: 'OCR_PENDING', OCR_DONE: 'OCR_DONE', VERIFIED: 'VERIFIED' }[best.status];
    if (kycStatus) {
      await pool.query(
        `UPDATE bookings SET kyc_status = $1::varchar,
                status = CASE WHEN $1::varchar = 'VERIFIED' AND status = 'KYC_PENDING' THEN 'KYC_DONE' ELSE status END,
                updated_at = now()
          WHERE id = $2`,
        [kycStatus, booking.id]
      );
    }
    return adopted.length;
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
  async list({ siteId, status, pending, q, memberType, visibleUserIds }, pool) {
    const where = [];
    const params = [];
    if (siteId) { params.push(siteId); where.push(`k.site_id = $${params.length}`); }
    if (status) { params.push(status); where.push(`k.status = $${params.length}`); }
    if (memberType) { params.push(memberType); where.push(`m.member_type = $${params.length}`); }
    if (pending) where.push(`k.status NOT IN ('VERIFIED','REJECTED')`);
    if (q) {
      params.push(`%${q}%`);
      where.push(`(m.full_name ILIKE $${params.length}
                   OR m.phone ILIKE $${params.length}
                   OR m.aadhar_no ILIKE $${params.length}
                   OR m.pan_no ILIKE $${params.length}
                   OR m.member_type ILIKE $${params.length})`);
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
             m.id AS account_member_id,
             m.full_name AS client_name, m.phone AS client_phone, m.photo AS client_photo,
             m.aadhar_no AS client_aadhar, m.pan_no AS client_pan,
             m.full_name AS member_name, m.phone AS member_phone, m.photo AS member_photo,
             m.member_type,
             m.member_type AS registration_role,
             m.member_type AS role,
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
             m.id AS account_member_id,
             m.full_name AS client_name, m.phone AS client_phone, m.email AS client_email,
             m.photo AS client_photo, m.aadhar_no AS client_aadhar, m.pan_no AS client_pan,
             m.father_name AS client_father, m.date_of_birth AS client_dob,
             m.address AS client_address, m.city AS client_city, m.state AS client_state,
             m.pincode AS client_pincode,
             m.co_applicant_name AS client_co_applicant_name,
             m.co_applicant_relation AS client_co_applicant_relation,
             m.co_applicant_dob AS client_co_applicant_dob,
             m.co_applicant_gender AS client_co_applicant_gender,
             m.co_applicant_phone AS client_co_applicant_phone,
             m.co_applicant_email AS client_co_applicant_email,
             m.co_applicant_aadhar AS client_co_applicant_aadhar,
             m.co_applicant_pan AS client_co_applicant_pan,
             m.co_applicant_address AS client_co_applicant_address,
             m.full_name AS member_name, m.phone AS member_phone, m.email AS member_email,
             m.photo AS member_photo,
             m.member_type,
             m.member_type AS registration_role,
             m.member_type AS role,
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
