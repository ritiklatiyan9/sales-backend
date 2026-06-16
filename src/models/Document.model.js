import MasterModel from './MasterModel.js';

class DocumentModel extends MasterModel {
  constructor() {
    super('documents');
  }

  /** Document joined with its latest OCR result. */
  async getWithLatestResult(id, pool) {
    const { rows } = await pool.query(`
      SELECT d.*,
             r.extracted_fields, r.confidence_overall, r.confidence_map, r.raw_text, r.processed_at
      FROM documents d
      LEFT JOIN LATERAL (
        SELECT * FROM ocr_results o WHERE o.document_id = d.id ORDER BY o.id DESC LIMIT 1
      ) r ON true
      WHERE d.id = $1
    `, [id]);
    return rows[0];
  }

  /** Booking id that a document belongs to (for socket room targeting). */
  async getBookingId(documentId, pool) {
    const { rows } = await pool.query(`
      SELECT k.booking_id FROM documents d
      JOIN kyc_cases k ON k.id = d.kyc_case_id
      WHERE d.id = $1
    `, [documentId]);
    return rows[0]?.booking_id || null;
  }
}

export default new DocumentModel();
