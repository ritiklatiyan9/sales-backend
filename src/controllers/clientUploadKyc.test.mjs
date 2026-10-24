import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Nothing leaves this process: S3 is blanked before s3.js loads (its local fallback writes
// under <cwd>/src/uploads, so cwd moves to a throwaway directory first, which also keeps the
// project .env out), OCR has no provider key, every upload below is an OCR cache hit, and
// any fetch fails loudly.
const repoDir = process.cwd();
const workDir = mkdtempSync(path.join(tmpdir(), 'client-upload-kyc-'));
process.chdir(workDir);
Object.assign(process.env, { AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '', OPENROUTER_API_KEY: '', WHATSAPP_ENABLED: 'false' });
globalThis.fetch = async () => { throw new Error('Network access is disabled in this test'); };
const { drawFixture } = await import('../test/drawFixture.mjs');
const { uploadDocument } = await import('./kyc.controller.js');
const { uploadClientDocument } = await import('./booking.controller.js');
const { processDocument } = await import('../services/ocrProcessor.js');
test.after(() => { process.chdir(repoDir); rmSync(workDir, { recursive: true, force: true }); });

const files = Object.fromEntries(['front', 'back', 'pan', 'replacement'].map(name => [name, Buffer.from(`test ${name} document bytes`)]));
const sha = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const file = (buffer, name = 'document.jpg') => ({ buffer, originalname: name, mimetype: 'image/jpeg', size: buffer.length });
const send = (handler, req) => new Promise((resolve, reject) => {
  const res = { statusCode: 200, set() { return this; }, status(code) { this.statusCode = code; return this; },
    json(body) { resolve({ status: this.statusCode, body }); return this; } };
  handler(req, res, error => error ? resolve({ status: error.status || 500, body: { message: error.message } }) : reject(new Error('next() without a reply')));
});

test('client identity uploads confirm KYC in the reply without touching storage, OCR providers or the network', async t => {
  const f = await drawFixture();
  // Background bookkeeping and OCR run after each reply; settle() waits until every query finished.
  let inFlight = 0;
  const counted = query => async (...args) => { inFlight += 1; try { return await query(...args); } finally { inFlight -= 1; } };
  f.pool.query = counted(f.pool.query);
  const client = await f.pool.connect();
  client.query = counted(client.query);
  const settle = async () => { for (let quiet = 0; quiet < 5;) { await new Promise(resolve => setTimeout(resolve, 5)); quiet = inFlight ? 0 : quiet + 1; } };
  try {
    await f.db.exec(`ALTER TABLE members ADD COLUMN IF NOT EXISTS aadhar_front_url TEXT, ADD COLUMN IF NOT EXISTS aadhar_back_url TEXT,
      ADD COLUMN IF NOT EXISTS pan_card_url TEXT, ADD COLUMN IF NOT EXISTS other_kyc_url TEXT`);
    const { rows: [salesRow] } = await f.query(`INSERT INTO users (name, email, role) VALUES ('Sales Desk', 'sales@example.test', 'sub_admin') RETURNING id`);
    await f.query('INSERT INTO user_sites (user_id, site_id) VALUES ($1, 1)', [salesRow.id]);
    // Session-loaded grants (staffSession.js): the fixture has no user_permissions table, so
    // every permission check below must be answered from this snapshot.
    const sales = { id: salesRow.id, role: 'sub_admin', grants: { booking_clients: [true, true, true, true] } };
    const admin = { id: 1, role: 'admin' };
    const member = async (name, phone) => (await f.query(`INSERT INTO members (site_id, member_type, member_types, full_name, phone)
      VALUES (1, 'CLIENT', ARRAY['CLIENT'], $1, $2) RETURNING id`, [name, phone])).rows[0].id;
    const openCase = async (memberId, status = 'OPEN') => (await f.query(`INSERT INTO kyc_cases (client_member_id, site_id, status, created_by)
      VALUES ($1, 1, $2, $3) RETURNING *`, [memberId, status, sales.id])).rows[0];
    const addDoc = (kycCase, type, field, status = 'DONE') => f.query(`INSERT INTO documents (kyc_case_id, client_member_id, site_id, type, member_document_field, file_path, ocr_status)
      VALUES ($1, $2, 1, $3, $4, 'test/existing', $5) RETURNING id`, [kycCase.id, kycCase.client_member_id, type, field, status]);
    const caseRow = async id => (await f.query('SELECT status, verified_by FROM kyc_cases WHERE id = $1', [id])).rows[0];
    const docCount = async caseId => (await f.query('SELECT count(*)::int AS n FROM documents WHERE kyc_case_id = $1', [caseId])).rows[0].n;
    const stored = () => readdirSync(path.join(workDir, 'src', 'uploads')).length;
    const upload = (user, memberId, type, field, buffer) => send(uploadClientDocument, {
      user, params: { id: String(memberId) }, body: { type, ...(field ? { member_document_field: field } : {}) }, file: file(buffer) });

    // OCR cache: the same bytes were already read elsewhere, so processDocument never calls runOcr.
    const library = await openCase(await member('OCR Library', '9000000001'), 'VERIFIED');
    for (const [type, buffer] of [['AADHAAR', files.front], ['AADHAAR', files.back], ['AADHAAR', files.replacement], ['PAN', files.pan]]) {
      const { rows: [doc] } = await f.query(`INSERT INTO documents (kyc_case_id, client_member_id, site_id, type, file_path, file_hash, ocr_status)
        VALUES ($1, $2, 1, $3, 'test/library', $4, 'DONE') RETURNING id`, [library.id, library.client_member_id, type, sha(buffer)]);
      await f.query(`INSERT INTO ocr_results (document_id, raw_text, extracted_fields, confidence_overall, confidence_map, engine)
        VALUES ($1, '{"text":""}', '{}', 1, '{}', 'test')`, [doc.id]);
    }

    let caseId, backReply;
    await t.test('each reply reports what is still missing and the completing upload verifies the case', async () => {
      const memberId = await member('Asha Verma', '9876500001');
      const front = await upload(sales, memberId, 'AADHAAR', 'aadhar_front_url', files.front);
      assert.equal(front.status, 201, JSON.stringify(front.body));
      caseId = front.body.kyc.case_id;
      assert.deepEqual({ ...front.body.kyc, status: undefined }, { case_id: caseId, status: undefined, verified: false,
        documents: { aadhaar_front: true, aadhaar_back: false, pan: false }, missing: ['aadhaar_back', 'pan'] });
      assert.notEqual(front.body.kyc.status, 'VERIFIED');
      await settle();
      const pan = await upload(sales, memberId, 'PAN', 'pan_card_url', files.pan);
      assert.equal(pan.status, 201);
      assert.deepEqual([pan.body.kyc.verified, pan.body.kyc.missing], [false, ['aadhaar_back']]);
      await settle();
      backReply = await upload(sales, memberId, 'AADHAAR', 'aadhar_back_url', files.back);
      assert.equal(backReply.status, 201);
      assert.deepEqual(backReply.body.kyc, { case_id: caseId, status: 'VERIFIED', verified: true,
        documents: { aadhaar_front: true, aadhaar_back: true, pan: true }, missing: [] });
      assert.deepEqual(await caseRow(caseId), { status: 'VERIFIED', verified_by: sales.id }, 'verified by the uploader');
      await settle();
      assert.equal((await caseRow(caseId)).status, 'VERIFIED', 'background OCR_PENDING and the OCR rollup keep VERIFIED');
      const { rows: [doc] } = await f.query('SELECT ocr_job_id, ocr_status FROM documents WHERE id = $1', [backReply.body.documentId]);
      assert.match(doc.ocr_job_id, /^inproc:/, 'background bookkeeping still runs');
      assert.equal(doc.ocr_status, 'DONE');
      const { rows: [linked] } = await f.query('SELECT aadhar_front_url, aadhar_back_url, pan_card_url FROM members WHERE id = $1', [memberId]);
      assert.ok(linked.aadhar_front_url && linked.aadhar_back_url && linked.pan_card_url, 'documents are mirrored onto the member');
    });

    await t.test('an identical re-upload is a retry: no new row, stored object or OCR job', async () => {
      const before = { docs: await docCount(caseId), stored: stored() };
      const memberId = (await f.query('SELECT client_member_id FROM kyc_cases WHERE id = $1', [caseId])).rows[0].client_member_id;
      const retry = await upload(sales, memberId, 'AADHAAR', 'aadhar_back_url', files.back);
      assert.equal(retry.status, 200);
      assert.equal(retry.body.deduplicated, true);
      assert.equal(retry.body.documentId, backReply.body.documentId);
      assert.equal(retry.body.member_document_field, 'aadhar_back_url');
      assert.equal(retry.body.kyc.status, 'VERIFIED');
      await settle();
      assert.deepEqual({ docs: await docCount(caseId), stored: stored() }, before);
      // Same bytes into another slot, or back after a replacement, are new documents.
      assert.equal((await upload(sales, memberId, 'AADHAAR', 'aadhar_front_url', files.replacement)).status, 201);
      assert.equal((await upload(sales, memberId, 'AADHAAR', 'aadhar_front_url', files.front)).status, 201);
      await settle();
      assert.equal(await docCount(caseId), before.docs + 2);
    });

    await t.test('concurrent uploads: the last insert sees the full set', async () => {
      const memberId = await member('Kiran Rao', '9876500003');
      const kycCase = await openCase(memberId);
      const replies = await Promise.all([
        upload(sales, memberId, 'AADHAAR', 'aadhar_front_url', files.front),
        upload(sales, memberId, 'AADHAAR', 'aadhar_back_url', files.back),
        upload(sales, memberId, 'PAN', 'pan_card_url', files.pan),
      ]);
      assert.deepEqual(replies.map(reply => reply.status), [201, 201, 201]);
      assert.ok(replies.every(reply => reply.body.kyc.case_id === kycCase.id));
      assert.ok(replies.some(reply => reply.body.kyc.status === 'VERIFIED'));
      await settle();
      assert.equal((await caseRow(kycCase.id)).status, 'VERIFIED');
    });

    await t.test('an office REJECTED case is never verified by an upload', async () => {
      const memberId = await member('Rejected Client', '9876500002');
      const rejected = await openCase(memberId, 'REJECTED');
      await addDoc(rejected, 'AADHAAR', 'aadhar_front_url');
      await addDoc(rejected, 'AADHAAR', 'aadhar_back_url');
      const reply = await upload(sales, memberId, 'PAN', 'pan_card_url', files.pan);
      assert.equal(reply.status, 201);
      assert.deepEqual(reply.body.kyc, { case_id: rejected.id, status: 'REJECTED', verified: false,
        documents: { aadhaar_front: true, aadhaar_back: true, pan: true }, missing: [] });
      await settle();
      assert.notEqual((await caseRow(rejected.id)).status, 'VERIFIED');
      assert.equal((await caseRow(rejected.id)).verified_by, null);
    });

    await t.test('grants decide the Clients write permission without a permissions query', async () => {
      const memberId = await member('Denied Upload', '9876500004');
      const denied = await upload({ ...sales, grants: { booking_clients: [true, false, true, true] } }, memberId, 'PAN', 'pan_card_url', files.pan);
      assert.equal(denied.status, 403);
      assert.equal((await f.query('SELECT count(*)::int AS n FROM kyc_cases WHERE client_member_id = $1', [memberId])).rows[0].n, 0);
    });

    await t.test('POST /kyc/upload is unchanged: no kyc block, no dedupe and no onboarding verify', async () => {
      const kycCase = await openCase(await member('Office Upload', '9876500005'));
      await addDoc(kycCase, 'AADHAAR', 'aadhar_front_url');
      await addDoc(kycCase, 'AADHAAR', 'aadhar_back_url');
      const req = () => ({ user: admin, body: { kyc_case_id: String(kycCase.id), type: 'PAN' }, file: file(files.pan) });
      const first = await send(uploadDocument, req());
      const second = await send(uploadDocument, req());
      assert.deepEqual([first.status, second.status], [201, 201]);
      assert.deepEqual(Object.keys(first.body).sort(), ['documentId', 'jobId', 'member_document_field', 'ocr_status', 'type']);
      assert.notEqual(first.body.documentId, second.body.documentId);
      await settle();
      assert.equal(await docCount(kycCase.id), 4);
      assert.notEqual((await caseRow(kycCase.id)).status, 'VERIFIED');
    });

    await t.test('the OCR rollup never overwrites a verify that lands between its read and its update', async () => {
      const ocrResult = { text: '', fields: {}, confidence: 1, confidenceMap: {}, engine: 'test' };
      const rollup = async flipBetween => {
        const kycCase = await openCase(await member(`Rollup ${flipBetween}`, flipBetween ? '9876500006' : '9876500007'));
        const { rows: [doc] } = await addDoc(kycCase, 'PAN', 'pan_card_url', 'PENDING');
        const query = f.pool.query;
        f.pool.query = async (sql, values) => {
          if (flipBetween && String(sql).includes("count(*) FILTER (WHERE ocr_status <> 'DONE')")) {
            await query(`UPDATE kyc_cases SET status = 'VERIFIED', verified_at = now() WHERE id = $1`, [kycCase.id]);
          }
          return query(sql, values);
        };
        try { await processDocument(doc.id, { ocrResult }); } finally { f.pool.query = query; }
        return (await caseRow(kycCase.id)).status;
      };
      assert.equal(await rollup(false), 'OCR_DONE', 'control: an unverified case rolls up');
      assert.equal(await rollup(true), 'VERIFIED');
    });
  } finally {
    await settle();
    await f.close();
  }
});
