import test from 'node:test';
import assert from 'node:assert/strict';
import { requireSiteAccess } from './bookingWorkspaceAccess.js';

test('site access keeps sub-admins and agents inside their assigned sites', async () => {
  const db = { query: async (sql, values) => ({ rows: sql.includes('FROM sites') ? [{ id: values[0], name: 'Test site' }] : values[1] === 1 ? [{ '?column?': 1 }] : [] }) };
  for (const role of ['sub_admin', 'agent']) {
    assert.equal((await requireSiteAccess({ id: 8, role }, 1, db)).id, 1);
    await assert.rejects(requireSiteAccess({ id: 8, role }, 2, db), error => error.status === 403);
  }
  for (const role of ['admin', 'super_admin']) assert.equal((await requireSiteAccess({ id: 8, role }, 2, db)).id, 2);
});

test('invalid or missing sites are rejected before an operation is performed', async () => {
  const db = { query: async () => ({ rows: [] }) };
  await assert.rejects(requireSiteAccess({ id: 8, role: 'admin' }, 'bad', db), error => error.status === 400);
  await assert.rejects(requireSiteAccess({ id: 8, role: 'admin' }, 2, db), error => error.status === 404);
});
