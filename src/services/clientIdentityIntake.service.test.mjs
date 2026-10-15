import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import pool from '../config/db.js';
import { createClientIdentityIntake, identityMemberFields } from './clientIdentityIntake.service.js';
import { processDocument } from './ocrProcessor.js';

const image = { buffer: Buffer.from([0xff,0xd8,0xff,0x01]), mimetype: 'image/jpeg' };
const result = { text: 'Isolated document', fields: { name: 'Test Client', aadhaar: '2345 6789 0123', dob: '12/06/1990', mobile: '+91 98765 43210' }, confidenceMap: { name: .9, aadhaar: .95 }, confidence: .93, engine: 'isolated-test' };

test('identity reading maps only valid KYC fields and preserves uncertainty', () => {
  const output = identityMemberFields({ ...result.fields, pan: 'abcde1234f', gender: 'female', role: 'admin', account_no: 'private-bank', pincode: '123abc' }, result.confidenceMap);
  assert.deepEqual(output.member_fields, { full_name: 'Test Client', date_of_birth: '1990-06-12', gender: 'FEMALE', phone: '9876543210', aadhar_no: '234567890123', pan_no: 'ABCDE1234F' });
  assert.equal(output.confidence_map.full_name, .9);
  assert.deepEqual(identityMemberFields({ aadhaar: 'XXXX12345678', pan: 'bad', dob: '31/02/1990', mobile: 'call9876543210' }).member_fields, {});
});

test('preview reuses one OCR call and binds results to actor, site, type, bytes and expiry', async () => {
  let calls = 0, clock = 1;
  const intake = createClientIdentityIntake({ authorize: async () => {}, ocr: async () => { calls++; return result; }, now: () => clock });
  const request = { user: { id: 7 }, siteId: 2, type: 'AADHAAR', file: image };
  const [one, two] = await Promise.all([intake.preview(request), intake.preview(request)]);
  assert.equal(calls, 1); assert.equal(one.preview_key, two.preview_key);
  assert.equal(one.member_fields.aadhar_no, '234567890123');
  assert.deepEqual(intake.cachedResult({ ...request, previewKey: one.preview_key }), result);
  for (const patch of [{ user: { id: 8 } }, { siteId: 3 }, { type: 'PAN' }, { file: { buffer: Buffer.from([0xff,0xd8,0xff,0x02]) } }]) {
    assert.equal(intake.cachedResult({ ...request, ...patch, previewKey: one.preview_key }), null);
  }
  clock += 11 * 60_000;
  assert.equal(intake.cachedResult({ ...request, previewKey: one.preview_key }), null);
  await intake.preview(request); assert.equal(calls, 2);
});

test('unauthorized sites, malformed uploads and unsupported OCR types never reach a provider', async () => {
  let calls = 0;
  const ocr = async () => { calls++; return result; };
  const denied = createClientIdentityIntake({ authorize: async () => { throw Object.assign(new Error('Site denied'), { status: 403 }); }, ocr });
  await assert.rejects(denied.preview({ user: { id: 7 }, siteId: 3, type: 'AADHAAR', file: image }), /Site denied/);
  const intake = createClientIdentityIntake({ authorize: async () => {}, ocr });
  for (const patch of [{ type: 'PHOTO' }, { file: null }, { file: { buffer: Buffer.from('renamed-file.jpg') } }]) {
    await assert.rejects(intake.preview({ user: { id: 7 }, siteId: 2, type: 'AADHAAR', file: image, ...patch }));
  }
  assert.equal(calls, 0);
});

test('preview OCR is archived into normal KYC results without storage access or another provider call', async () => {
  const db = new PGlite(), previous = pool.query;
  pool.query = (sql, values) => db.query(sql, values);
  try {
    await db.exec(`CREATE TABLE kyc_cases(id INT PRIMARY KEY, booking_id INT, status TEXT, updated_at TIMESTAMPTZ DEFAULT now());
      CREATE TABLE documents(id INT PRIMARY KEY,kyc_case_id INT,type TEXT,file_hash TEXT,file_path TEXT,ocr_status TEXT,
        ocr_started_at TIMESTAMPTZ,ocr_engine TEXT,ocr_completed_at TIMESTAMPTZ,ocr_error TEXT,updated_at TIMESTAMPTZ DEFAULT now());
      CREATE TABLE ocr_results(id SERIAL PRIMARY KEY,document_id INT,raw_text JSONB,extracted_fields JSONB,
        confidence_overall NUMERIC,confidence_map JSONB,engine TEXT,processed_at TIMESTAMPTZ);
      INSERT INTO kyc_cases VALUES(1,NULL,'OPEN',now());
      INSERT INTO documents(id,kyc_case_id,type,file_hash,file_path,ocr_status) VALUES(1,1,'AADHAAR','hash','must-never-be-read','PENDING');`);
    await processDocument(1, { ocrResult: result });
    await processDocument(1, { ocrResult: result });
    assert.equal((await db.query('SELECT ocr_status FROM documents')).rows[0].ocr_status, 'DONE');
    assert.equal((await db.query('SELECT status FROM kyc_cases')).rows[0].status, 'OCR_DONE');
    const rows = (await db.query('SELECT * FROM ocr_results')).rows;
    assert.equal(rows.length, 1); assert.deepEqual(rows[0].extracted_fields, result.fields);
  } finally { pool.query = previous; await db.close(); }
});
