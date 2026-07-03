import MasterModel from './MasterModel.js';

class BookingModel extends MasterModel {
  constructor() {
    super('bookings');
  }

  /** List with joined client/plot labels + KYC/OCR rollup indicators.
   * `visibleUserIds` (array | null) scopes rows to an agent's own network —
   * bookings they own (agent_user_id) or personally created. */
  async list({ siteId, status, kycStatus, q, clientMemberId, agentUserId, visibleUserIds }, pool) {
    const where = [];
    const params = [];
    if (siteId) { params.push(siteId); where.push(`b.site_id = $${params.length}`); }
    if (status) { params.push(status); where.push(`b.status = $${params.length}`); }
    if (kycStatus) { params.push(kycStatus); where.push(`b.kyc_status = $${params.length}`); }
    if (clientMemberId) { params.push(clientMemberId); where.push(`b.client_member_id = $${params.length}`); }
    if (agentUserId) { params.push(agentUserId); where.push(`b.agent_user_id = $${params.length}`); }
    if (Array.isArray(visibleUserIds)) {
      params.push(visibleUserIds);
      where.push(`(b.agent_user_id = ANY($${params.length}) OR b.created_by = ANY($${params.length}))`);
    }
    if (q) {
      params.push(`%${q}%`);
      where.push(`(b.booking_no ILIKE $${params.length} OR b.buyer_name ILIKE $${params.length} OR m.full_name ILIKE $${params.length} OR p.plot_no ILIKE $${params.length})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const sql = `
      SELECT b.*,
             m.full_name AS client_name, m.phone AS client_phone, m.photo AS client_photo,
             p.plot_no, p.block AS plot_block,
             s.name AS site_name,
             (SELECT count(*)::int FROM documents d
                JOIN kyc_cases k ON k.id = d.kyc_case_id
                WHERE k.booking_id = b.id) AS document_count,
             (SELECT count(*)::int FROM documents d
                JOIN kyc_cases k ON k.id = d.kyc_case_id
                WHERE k.booking_id = b.id AND d.ocr_status = 'PENDING') AS ocr_pending_count,
             (SELECT count(*)::int FROM documents d
                JOIN kyc_cases k ON k.id = d.kyc_case_id
                WHERE k.booking_id = b.id AND d.ocr_status = 'DONE') AS ocr_done_count
      FROM bookings b
      LEFT JOIN members m ON m.id = b.client_member_id
      LEFT JOIN plots   p ON p.id = b.plot_id
      LEFT JOIN sites   s ON s.id = b.site_id
      ${whereSql}
      ORDER BY b.created_at DESC
      LIMIT 500
    `;
    const { rows } = await pool.query(sql, params);
    return rows;
  }

  /** Full detail: booking + client + plot + kyc cases + documents + latest ocr result. */
  async getDetail(id, pool) {
    const { rows } = await pool.query(`
      SELECT b.*,
             m.full_name AS client_name, m.phone AS client_phone, m.email AS client_email,
             m.aadhar_no AS client_aadhar, m.pan_no AS client_pan,
             m.father_name AS client_father, m.mother_name AS client_mother, m.spouse_name AS client_spouse,
             m.address AS client_address, m.city AS client_city, m.state AS client_state,
             m.pincode AS client_pincode, m.date_of_birth AS client_dob, m.photo AS client_photo,
             m.gender AS client_gender, m.occupation AS client_occupation, m.company_name AS client_company,
             m.nationality AS client_nationality, m.marital_status AS client_marital,
             m.qualification AS client_qualification,
             m.alt_phone AS client_alt_phone, m.whatsapp AS client_whatsapp,
             m.voter_id AS client_voter_id, m.passport_no AS client_passport,
             m.driving_license_no AS client_dl, m.gst_no AS client_gst,
             m.bank_name AS client_bank, m.account_no AS client_account,
             m.ifsc_code AS client_ifsc, m.branch AS client_branch,
             m.nominee_name AS client_nominee, m.nominee_relation AS client_nominee_rel,
             m.nominee_phone AS client_nominee_phone,
             p.plot_no, p.block AS plot_block, p.plot_size, p.sale_price AS plot_sale_price,
             s.name AS site_name, s.city AS site_city, s.state AS site_state
      FROM bookings b
      LEFT JOIN members m ON m.id = b.client_member_id
      LEFT JOIN plots   p ON p.id = b.plot_id
      LEFT JOIN sites   s ON s.id = b.site_id
      WHERE b.id = $1
    `, [id]);
    return rows[0];
  }

  /** Generate a human booking number like BK-2026-000123 (id-derived, unique). */
  async generateBookingNo(id, bookingDate, pool) {
    const year = (bookingDate ? new Date(bookingDate) : new Date()).getFullYear();
    const no = `BK-${year}-${String(id).padStart(6, '0')}`;
    await pool.query('UPDATE bookings SET booking_no = $1 WHERE id = $2 AND booking_no IS NULL', [no, id]);
    return no;
  }
}

export default new BookingModel();
