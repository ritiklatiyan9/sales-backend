import pool from '../config/db.js';

// Shared with Accounts Settings → Upload Sign. Read at render time so disabling
// or replacing an upload also applies to receipts already waiting in the outbox.
export async function drawReceiptSignature(siteId, db = pool) {
  const id = Number(siteId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const { rows: [row] } = await db.query(
    'SELECT setting_value FROM application_settings WHERE site_id = $1 AND setting_key = $2 LIMIT 1',
    [id, 'receipt_signature_v1'],
  );
  const signature = row?.setting_value;
  if (signature?.enabled !== true) return null;
  if (!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(signature.image_data_url || '')) {
    throw new Error('The enabled receipt signature is invalid. Upload a PNG or JPEG again in this site’s Upload Sign settings.');
  }
  const size = typeof signature.size_percent === 'number' && Number.isFinite(signature.size_percent)
    ? Math.max(50, Math.min(200, Math.round(signature.size_percent))) : 100;
  return {
    bytes: Buffer.from(signature.image_data_url.split(',')[1], 'base64'),
    width: 40 * 72 / 25.4 * size / 100,
    height: 12 * 72 / 25.4 * size / 100,
  };
}
