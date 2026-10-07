import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDocumentConfig } from './documentSettings.js';
import { drawFixture } from '../test/drawFixture.mjs';
import { getBySite, upsertBySite } from '../models/ProjectSettings.model.js';
import { saveProjectSettings } from '../controllers/settings.controller.js';

test('document content validates without inventing company or policy information', () => {
  assert.deepEqual(validateDocumentConfig({ receipt_note: '  Customer wording  ', footer_text: '' }), { receipt_note: 'Customer wording', footer_text: '' });
  for (const value of [null, [], 'text', { unknown: 'value' }, { constructor: 'value' }, { receipt_note: false }, { receipt_title: 'x'.repeat(101) }]) assert.throws(() => validateDocumentConfig(value), { status: 400 });
});
test('document settings persist by site and can be cleared without changing draw rules', async () => {
  const fixture = await drawFixture();
  try {
    await upsertBySite(1, { company_legal_name: 'Configured company', document_config: { receipt_note: 'Custom acknowledgement', office_signature: 'Accounts officer', agreement_terms: 'Configured agreement wording' } });
    await upsertBySite(2, { document_config: { receipt_note: 'Other project wording' } });
    assert.equal((await getBySite(1)).document_config.receipt_note, 'Custom acknowledgement');
    assert.equal((await getBySite(1)).document_config.agreement_terms, 'Configured agreement wording');
    assert.equal((await getBySite(2)).document_config.receipt_note, 'Other project wording');
    await fixture.query('UPDATE project_settings SET draw_required_amount = 5000 WHERE site_id = 1');
    await upsertBySite(1, { document_config: { receipt_note: '' } });
    const saved = await getBySite(1);
    assert.equal(saved.document_config.receipt_note, '');
    assert.equal(saved.company_legal_name, 'Configured company');
    assert.equal(Number(saved.draw_required_amount), 5000);
    const result = await new Promise(resolve => {
      const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(data) { resolve({ status: this.statusCode, data }); } };
      saveProjectSettings({ body: { site_id: 1, company_legal_name: 'Unauthorised' }, user: { role: 'agent' } }, response, error => resolve({ status: error.status }));
    });
    assert.equal(result.status, 403);
    assert.equal((await getBySite(1)).company_legal_name, 'Configured company');
  } finally { await fixture.close(); }
});
