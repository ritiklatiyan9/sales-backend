import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Same isolation as utils/s3.test.mjs: S3 is blanked before s3.js loads and its local
// fallback (<cwd>/src/uploads) lives in a throwaway directory.
const repoDir = process.cwd();
const workDir = mkdtempSync(path.join(tmpdir(), 'booking-documents-'));
process.chdir(workDir);
Object.assign(process.env, { AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '' });
const { drawFixture } = await import('../test/drawFixture.mjs');
const { default: kycCaseModel } = await import('../models/KycCase.model.js');
const booking = await import('./booking.controller.js');
const { deleteBooking } = booking;
const { deletePlotDocument } = await import('./plotDocument.controller.js');
test.after(() => { process.chdir(repoDir); rmSync(workDir, { recursive: true, force: true }); });

const call = (handler, params, { query = {}, user = { id: 1, role: 'admin' } } = {}) => new Promise(resolve => {
  const res = { statusCode: 200, set() {}, status(v) { this.statusCode = v; return this; }, json(data) { resolve({ status: this.statusCode, data }); } };
  handler({ params, body: {}, query, user }, res, error => resolve({ status: error.status || 500, data: { message: error.message } }));
});

test('booking reads gate first, and deletes drop rows before the shared file', async t => {
  const f = await drawFixture();
  await t.test('site gates still beat builder 400s, and no NaN id reaches the database', async () => {
    const sent = [];
    const query = f.pool.query;
    f.pool.query = (sql, values) => { sent.push(...(values || [])); return query(sql, values); };
    try {
      const outsider = { id: 2, role: 'sub_admin', grants: {} }; // assigned to site 1 only; default-allow grants
      for (const [handler, q, status] of [
        [booking.searchClients, { site_id: 2, member_type: 'BOGUS' }, 403],
        [booking.listClients, { site_id: 2, member_type: 'BOGUS' }, 403],
        [booking.getBookingIntake, { site_id: 2, client_member_id: 'bad' }, 403],
        [booking.getBookingIntake, { site_id: 'x', client_member_id: 'bad' }, 400],
        [booking.searchClients, { site_id: 'x', member_type: 'BOGUS' }, 400],
        [booking.listClients, { site_id: 'x', kyc: 'done' }, 400],
        [booking.listSiteBanks, { site_id: 'x' }, 400],
        [booking.searchAgents, {}, 400],
      ]) {
        const result = await call(handler, {}, { query: q, user: outsider });
        assert.equal(result.status, status, `${handler.name} ${JSON.stringify(q)} ${JSON.stringify(result.data)}`);
        if (status === 400) assert.equal(result.data.message, 'Select a valid site');
      }
      assert.equal((await call(booking.getBookingIntake, {}, { query: { site_id: 1, client_member_id: 'bad' } })).status, 400);
      assert.ok(!sent.some(value => Number.isNaN(value)), 'no NaN parameter was sent');
    } finally { f.pool.query = query; }
  });
  const file = name => path.join(workDir, 'src', 'uploads', name);
  const newCase = async (bookingId) => {
    if (!bookingId) bookingId = (await f.query('INSERT INTO bookings (site_id) VALUES (1) RETURNING id')).rows[0].id;
    const { rows: [kyc] } = await f.query('INSERT INTO kyc_cases (booking_id, site_id) VALUES ($1, 1) RETURNING id', [bookingId]);
    return { bookingId, caseId: kyc.id };
  };
  const newDoc = async (caseId, name) => (await f.query(
    "INSERT INTO documents (kyc_case_id, file_path, ocr_status) VALUES ($1, $2, 'DONE') RETURNING id", [caseId, `local::${name}`])).rows[0].id;
  try {
    await t.test('getBooking’s per-booking read splits into exactly the old per-case reads', async () => {
      const a = await newCase();
      const b = await newCase(a.bookingId);
      const empty = await newCase(a.bookingId);
      const other = await newCase();
      // Interleaved ids across two cases (the third has none) plus another booking's document.
      for (const caseId of [b.caseId, a.caseId, other.caseId, b.caseId, a.caseId]) await newDoc(caseId, 'k');
      const { rows: [first] } = await f.query('SELECT min(id) AS id FROM documents');
      await f.query('INSERT INTO ocr_results (document_id, confidence_overall) VALUES ($1, 0.1), ($1, 0.9)', [first.id]);
      const docs = await kycCaseModel.getDocumentsWithResultsForBooking(a.bookingId, f.pool);
      assert.equal(docs.length, 4);
      for (const c of [a, b, empty])
        assert.deepEqual(docs.filter(d => String(d.kyc_case_id) === String(c.caseId)), await kycCaseModel.getDocumentsWithResults(c.caseId, f.pool));
      assert.equal(Number(docs.find(d => d.id === first.id).confidence_overall), 0.9, 'latest OCR result attached');
      await f.query('DELETE FROM bookings');
    });

    await t.test('a shared file goes exactly with its last row', async () => {
      for (const name of ['shared.jpg', 'booking-only.jpg']) writeFileSync(file(name), 'bytes');
      const kept = await newCase();
      const keptDoc = await newDoc(kept.caseId, 'shared.jpg');

      // A cascading booking whose document shares a file with another row keeps the file...
      const shared = await newCase();
      await newDoc(shared.caseId, 'shared.jpg');
      const deleted = await call(deleteBooking, { id: shared.bookingId });
      assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
      assert.equal(deleted.data.removedDocuments, 1);
      assert.ok(existsSync(file('shared.jpg')), 'another row still references the file');

      // ...and one holding the last reference removes it.
      const solo = await newCase();
      await newDoc(solo.caseId, 'booking-only.jpg');
      assert.equal((await call(deleteBooking, { id: solo.bookingId })).status, 200);
      assert.ok(!existsSync(file('booking-only.jpg')), 'the last row is gone, so is the file');

      // Plot-document delete: the last referencing row takes the file with it.
      const last = await call(deletePlotDocument, { docId: String(keptDoc) });
      assert.deepEqual(last, { status: 200, data: { message: 'Document deleted', documentId: keptDoc } });
      assert.ok(!existsSync(file('shared.jpg')), 'the shared file goes with its last row');
      assert.equal((await f.query('SELECT count(*)::int AS n FROM documents')).rows[0].n, 0);
    });
  } finally { await f.close(); }
});
