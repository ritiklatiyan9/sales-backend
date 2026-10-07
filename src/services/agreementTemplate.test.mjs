import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAgreementTemplate, validateAgreementDesign } from './agreementTemplate.js';

const design = {
  heading_font: 'EB Garamond', body_font: 'Source Sans 3', accent_color: '#1f2a44', ink_color: '#1a1a1a',
  header_style: 'centered', heading_style: 'classic', border: 'double',
  font_size: 11.5, line_height: 1.6, paragraph_gap: 8, margin_mm: 18, stamp_space_mm: 0,
  watermark: '', footer_text: ' Initials of Allottee ', justify: true, page_numbers: true,
};

test('agreement design keeps known keys and rejects unsafe or out-of-range values', () => {
  const out = validateAgreementDesign({ ...design, extra: 'dropped' });
  assert.equal(out.footer_text, 'Initials of Allottee');
  assert.equal(out.extra, undefined);
  for (const bad of [
    { heading_font: 'x;background:url(evil)' }, { accent_color: 'red' }, { border: 'dashed' },
    { font_size: 40 }, { margin_mm: 'wide' }, { watermark: 'x'.repeat(61) },
  ]) assert.throws(() => validateAgreementDesign({ ...design, ...bad }), { status: 400 });
});

test('agreement template requires a name, known preset and string body; partial updates skip absent keys', () => {
  const full = validateAgreementTemplate({ name: ' DLF style ', preset: 'dlf', design, body: '<p>x</p>' });
  assert.equal(full.name, 'DLF style');
  assert.throws(() => validateAgreementTemplate({ name: '', preset: 'dlf', design, body: '' }), { status: 400 });
  assert.throws(() => validateAgreementTemplate({ name: 'x', preset: 'unknown', design, body: '' }), { status: 400 });
  assert.throws(() => validateAgreementTemplate({ name: 'x', preset: 'dlf', design, body: 5 }), { status: 400 });
  assert.deepEqual(validateAgreementTemplate({ body: '<p>only body</p>' }, { partial: true }), { body: '<p>only body</p>' });
});

test('agreement formats: first is default, one default per site, revision conflicts and permissions', async () => {
  const { drawFixture } = await import('../test/drawFixture.mjs');
  const { migrateAgreementTemplates } = await import('../migrations/026_agreement_templates.js');
  const c = await import('../controllers/agreementTemplate.controller.js');
  const admin = { id: 1, role: 'admin' }, agent = { id: 2, role: 'agent' };
  const call = (handler, { body = {}, params = {}, query = {}, user = admin } = {}) => new Promise(resolve => handler({ body, params, query, user }, {
    statusCode: 200, status(v) { this.statusCode = v; return this; },
    json(data) { resolve({ status: this.statusCode, data }); }, end() { resolve({ status: this.statusCode }); },
  }, error => resolve({ status: error.status || 500, data: { message: error.message } })));
  const f = await drawFixture();
  try {
    await f.db.exec('CREATE TABLE user_sites(user_id INTEGER,site_id INTEGER);CREATE TABLE user_permissions(user_id INTEGER,module TEXT,can_read BOOLEAN,can_write BOOLEAN,can_update BOOLEAN,can_delete BOOLEAN);INSERT INTO user_sites VALUES(2,1);');
    await migrateAgreementTemplates(f.pool); await migrateAgreementTemplates(f.pool);
    const body = { site_id: 1, name: 'DLF style', preset: 'dlf', design, body: '<p>Agreement</p>' };
    const a = await call(c.createAgreementTemplate, { body });
    const b = await call(c.createAgreementTemplate, { body: { ...body, name: 'M3M style', preset: 'm3m' } });
    assert.equal(a.status, 201, JSON.stringify(a.data));
    assert.equal(a.data.is_default, true); assert.equal(b.data.is_default, false);
    assert.equal((await call(c.setDefaultAgreementTemplate, { params: { id: b.data.id } })).status, 200);
    const list = await call(c.listAgreementTemplates, { query: { site_id: 1 } });
    assert.deepEqual(list.data.map(t => [t.name, t.is_default]), [['M3M style', true], ['DLF style', false]]);
    const saved = await call(c.updateAgreementTemplate, { params: { id: a.data.id }, body: { body: '<p>Edited word</p>', revision: 1 } });
    assert.equal(saved.data.body, '<p>Edited word</p>'); assert.equal(saved.data.name, 'DLF style'); assert.equal(saved.data.revision, 2);
    assert.equal((await call(c.updateAgreementTemplate, { params: { id: a.data.id }, body: { body: '<p>stale</p>', revision: 1 } })).status, 409);
    // Agents can read their site's formats (for printing) but cannot edit without Access Control.
    assert.equal((await call(c.getAgreementTemplate, { params: { id: a.data.id }, user: agent })).status, 200);
    assert.equal((await call(c.createAgreementTemplate, { body, user: agent })).status, 403);
    assert.equal((await call(c.listAgreementTemplates, { query: { site_id: 2 }, user: agent })).status, 403);
    await f.query("INSERT INTO user_permissions VALUES (2,'booking_agreement_studio',true,true,true,false)");
    assert.equal((await call(c.deleteAgreementTemplate, { params: { id: a.data.id }, user: agent })).status, 403);
    assert.equal((await call(c.deleteAgreementTemplate, { params: { id: a.data.id } })).status, 204);
  } finally { await f.close(); }
});
