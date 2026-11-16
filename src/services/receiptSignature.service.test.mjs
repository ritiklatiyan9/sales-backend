import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { drawReceiptSignature } from './receiptSignature.service.js';
import { renderDrawReceipt, SAMPLE_RECEIPT } from './whatsappDocuments.js';

const png = await sharp({ create: { width: 400, height: 80, channels: 3, background: '#123456' } }).png().toBuffer();
const uploaded = { enabled: true, image_data_url: `data:image/png;base64,${png.toString('base64')}`, size_percent: 100 };
const database = (value) => ({
  query: async (_sql, args) => {
    assert.deepEqual(args, [7, 'receipt_signature_v1']);
    return { rows: value ? [{ setting_value: value }] : [] };
  },
});

test('draw receipts embed the enabled site upload at its saved size and remain one A4 page', async () => {
  for (const size_percent of [50, 100, 200]) {
    const db = database({ ...uploaded, size_percent });
    const signature = await drawReceiptSignature(7, db);
    assert.deepEqual(signature.bytes, png);
    assert.equal(signature.width, 40 * 72 / 25.4 * size_percent / 100);
    assert.equal(signature.height, 12 * 72 / 25.4 * size_percent / 100);
    const pdf = await renderDrawReceipt({ ...SAMPLE_RECEIPT, site_id: 7 }, { db });
    assert.match(pdf.toString('latin1'), /\/Subtype \/Image/);
    assert.equal((pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length, 1);
  }
});

test('disabled or missing signatures stay absent and settings from another site are never read', async () => {
  for (const value of [null, { ...uploaded, enabled: false }, { ...uploaded, enabled: 'true' }]) {
    const pdf = await renderDrawReceipt({ ...SAMPLE_RECEIPT, site_id: 7 }, { db: database(value) });
    assert.doesNotMatch(pdf.toString('latin1'), /\/Subtype \/Image/);
  }
  const db = { query: async () => { throw new Error('must not read a site for unscoped samples'); } };
  for (const id of [undefined, null, 0, -1, '7x', 1.5]) assert.equal(await drawReceiptSignature(id, db), null);
  const scoped = { query: async (_sql, args) => {
    assert.deepEqual(args, [8, 'receipt_signature_v1']);
    return { rows: [] };
  } };
  assert.equal(await drawReceiptSignature(8, scoped), null);
});

test('enabled but unreadable signatures stop delivery instead of silently sending an unsigned PDF', async () => {
  await assert.rejects(renderDrawReceipt({ ...SAMPLE_RECEIPT, site_id: 7 }, {
    db: database({ enabled: true, image_data_url: 'https://example.invalid/sign.png' }),
  }), /enabled receipt signature is invalid/);
  await assert.rejects(renderDrawReceipt({ ...SAMPLE_RECEIPT, site_id: 7 }, {
    db: database({ enabled: true, image_data_url: 'data:image/png;base64,Y29ycnVwdA==' }),
  }), /Unknown image format/);
  await assert.rejects(renderDrawReceipt({ ...SAMPLE_RECEIPT, site_id: 7 }, {
    db: { query: async () => { throw new Error('settings unavailable'); } },
  }), /settings unavailable/);
});
