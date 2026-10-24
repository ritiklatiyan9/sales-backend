import test from 'node:test';
import assert from 'node:assert/strict';
import { drawFixture } from '../test/drawFixture.mjs';
import { verifyWhenIdentityComplete } from './kyc.controller.js';

test('onboarding KYC is verified once Aadhaar front, back and PAN are on file', async () => {
  const f = await drawFixture();
  try {
    const { rows: [member] } = await f.query(`INSERT INTO members (site_id, member_type, full_name, phone) VALUES (1, 'CLIENT', 'Onboard Test', '9555500001') RETURNING id`);
    const { rows: [kyc] } = await f.query(`INSERT INTO kyc_cases (client_member_id, site_id, status) VALUES ($1, 1, 'OPEN') RETURNING *`, [member.id]);
    const add = (type, field) => f.query(`INSERT INTO documents (kyc_case_id, client_member_id, site_id, type, member_document_field, file_path, mime_type, file_size, ocr_status)
      VALUES ($1, $2, 1, $3, $4, $5, 'image/jpeg', 1, 'PENDING')`, [kyc.id, member.id, type, field, `test/${type}-${field}`]);
    await add('AADHAAR', 'aadhar_front_url');
    await add('PAN', 'pan_card_url');
    assert.equal(await verifyWhenIdentityComplete(kyc, 1), false, 'Aadhaar back still missing');
    assert.equal((await f.query('SELECT status FROM kyc_cases WHERE id = $1', [kyc.id])).rows[0].status, 'OPEN');
    await add('AADHAAR', 'aadhar_back_url');
    assert.equal(await verifyWhenIdentityComplete(kyc, 1), true);
    const after = (await f.query('SELECT status, verified_by FROM kyc_cases WHERE id = $1', [kyc.id])).rows[0];
    assert.deepEqual(after, { status: 'VERIFIED', verified_by: 1 });
    assert.equal(await verifyWhenIdentityComplete(kyc, 1), false, 'already verified — no second write');
    // An office rejection is never auto-verified, even with all three documents on file.
    const { rows: [rejected] } = await f.query(`INSERT INTO kyc_cases (client_member_id, site_id, status) VALUES ($1, 1, 'REJECTED') RETURNING *`, [member.id]);
    for (const [type, field] of [['AADHAAR', 'aadhar_front_url'], ['AADHAAR', 'aadhar_back_url'], ['PAN', 'pan_card_url']]) {
      await f.query(`INSERT INTO documents (kyc_case_id, client_member_id, site_id, type, member_document_field, file_path, mime_type, file_size, ocr_status)
        VALUES ($1, $2, 1, $3, $4, 'test/rejected', 'image/jpeg', 1, 'DONE')`, [rejected.id, member.id, type, field]);
    }
    assert.equal(await verifyWhenIdentityComplete(rejected, 1), false);
    assert.deepEqual((await f.query('SELECT status, verified_by FROM kyc_cases WHERE id = $1', [rejected.id])).rows[0], { status: 'REJECTED', verified_by: null });
  } finally { await f.close(); }
});
