import test from 'node:test';
import assert from 'node:assert/strict';
import { requireAnyWorkspaceReadAccess, requireSiteAccess, requireWorkspaceAccess } from './bookingWorkspaceAccess.js';

test('site access keeps sub-admins and agents inside their assigned sites', async () => {
  // The user is assigned to site 1 only.
  const db = { query: async (sql, values) => ({ rows: [{ id: values[0], name: 'Test site', assigned: values[0] === 1 }] }) };
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

test('workspace guards decide from the request grants snapshot exactly as from user_permissions, without querying it', async () => {
  const modules = ['booking_agreement_studio', 'booking_agreements'];
  const outcome = promise => promise.then(() => 'allow', error => error.status);
  for (const role of ['sub_admin', 'agent', 'admin'])
    for (const flags of [undefined, [true, true, true, true], [true, false, true, false], [true, null, true, true], [false, true, true, true], [null, true, true, true]])
      for (const other of [undefined, [true, false, false, false]]) {
        const stored = Object.fromEntries([[modules[0], flags], [modules[1], other]].filter(([, row]) => row));
        let permissionQueries = 0;
        const db = { query: async (sql, values) => {
          if (sql.includes('FROM sites')) return { rows: [{ id: values[0], name: 'Test site', assigned: true }] };
          permissionQueries++;
          const row = m => sql.includes('ANY') ? { module: m, can_read: stored[m][0] }
            : { can_read: stored[m][0], can_write: stored[m][1], can_update: stored[m][2], can_delete: stored[m][3] };
          return { rows: [].concat(values[1]).filter(m => stored[m]).map(row) };
        } };
        const queried = { id: 8, role };
        const snapshot = { ...queried, grants: stored };
        for (const action of ['can_read', 'can_write', 'can_update', 'can_delete', 'unknown_flag']) {
          const expected = await outcome(requireWorkspaceAccess(queried, 1, modules[0], action, db));
          const before = permissionQueries;
          assert.equal(await outcome(requireWorkspaceAccess(snapshot, 1, modules[0], action, db)), expected, `${role} ${flags} ${action}`);
          assert.equal(permissionQueries, before, 'the snapshot replaces the permissions query');
        }
        const expected = await outcome(requireAnyWorkspaceReadAccess(queried, 1, modules, db));
        const before = permissionQueries;
        assert.equal(await outcome(requireAnyWorkspaceReadAccess(snapshot, 1, modules, db)), expected, `${role} ${flags} ${other} any-read`);
        assert.equal(permissionQueries, before);
      }
  // Anchors for the shared decision table (not just snapshot == query).
  const db = { query: async (sql, values) => ({ rows: sql.includes('FROM sites') ? [{ id: values[0], name: 'Test site', assigned: true }] : [] }) };
  assert.equal(await outcome(requireWorkspaceAccess({ id: 8, role: 'sub_admin', grants: {} }, 1, modules[0], 'can_write', db)), 'allow', 'no row + sub_admin = allowed');
  assert.equal(await outcome(requireWorkspaceAccess({ id: 8, role: 'agent', grants: {} }, 1, modules[0], 'can_read', db)), 403, 'no row + agent = denied');
  assert.equal(await outcome(requireWorkspaceAccess({ id: 8, role: 'sub_admin', grants: { [modules[0]]: [true, null, true, true] } }, 1, modules[0], 'can_write', db)), 403, 'a null flag denies');
  assert.equal(await outcome(requireWorkspaceAccess({ id: 8, role: 'sub_admin', grants: { [modules[0]]: [true, true, true, true] } }, 1, modules[0], 'can_approve', db)), 403, 'an unknown action denies');
  let queries = 0;
  const counting = { query: async (sql, values) => { queries++; return db.query(sql, values); } };
  await requireWorkspaceAccess({ id: 8, role: 'sub_admin', grants: {} }, 1, 'documents', 'can_read', counting);
  assert.equal(queries, 2, 'a non-booking module is not in the snapshot, so it still queries');
});
