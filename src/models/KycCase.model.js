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
    }, pool);
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
