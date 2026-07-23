import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MEMBER_TYPES,
  compareMemberTypes,
  memberTypeFilterFromQuery,
  memberTypeFromBody,
  memberTypePayload,
  normalizeMemberType,
} from './memberRoles.service.js';

test('normalizes canonical member roles case-insensitively', () => {
  assert.equal(normalizeMemberType(' supervisor '), 'SUPERVISOR');
  assert.equal(normalizeMemberType('employee'), 'EMPLOYEE');
  assert.ok(MEMBER_TYPES.includes('VENDOR'));
});

test('supports compatibility request keys and a legacy CLIENT fallback', () => {
  assert.equal(memberTypeFromBody({ applicant_role: 'member' }), 'MEMBER');
  assert.equal(memberTypeFromBody({ party_type: 'vendor' }), 'VENDOR');
  assert.equal(memberTypeFromBody({}), 'CLIENT');
  assert.equal(memberTypeFromBody({}, null), null);
  assert.equal(memberTypeFilterFromQuery({ member_type: 'ALL' }), null);
  assert.equal(memberTypeFilterFromQuery({ role: 'supervisor' }), 'SUPERVISOR');
});

test('rejects unknown roles instead of silently changing them', () => {
  assert.throws(
    () => normalizeMemberType('wizard'),
    (error) => error.status === 400 && error.code === 'INVALID_MEMBER_TYPE'
  );
});

test('returns stable role aliases for list and detail APIs', () => {
  assert.deepEqual(memberTypePayload({ member_type: 'broker' }), {
    member_type: 'BROKER',
    registration_role: 'BROKER',
    role: 'BROKER',
  });
});

test('blocks a clearly detected Fresh OCR role mismatch but not an unreadable stamp', () => {
  assert.deepEqual(compareMemberTypes('vendor', 'supervisor'), {
    selected: 'VENDOR',
    detected: 'SUPERVISOR',
    matches: false,
    blocking: true,
  });
  assert.deepEqual(compareMemberTypes('member', ''), {
    selected: 'MEMBER',
    detected: null,
    matches: null,
    blocking: false,
  });
});
