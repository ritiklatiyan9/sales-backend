import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Read-path indexes for hash-based OCR reuse and latest-result aggregation.
 * Additive only: no existing document or OCR data is changed.
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_documents_ocr_hash_cache
        ON documents(file_hash, type, id DESC)
        WHERE file_hash IS NOT NULL AND ocr_status = 'DONE'
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ocr_results_document_latest
        ON ocr_results(document_id, id DESC)
    `);
    await client.query('COMMIT');
    console.log('Migration 020_ocr_optimization complete');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration 020_ocr_optimization failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => pool.end())
  .catch(async () => {
    await pool.end();
    process.exit(1);
  });
