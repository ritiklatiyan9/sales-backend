import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBrokerPasswordResetEmail } from './brokerResetEmail.service.js';

test('broker reset email has neutral branding and escapes recipient-sourced content', () => {
  const message = buildBrokerPasswordResetEmail({
    to: 'broker@example.test', fromAddress: 'sender@example.test',
    name: '<img src=x onerror="alert(1)">', code: '123456', minutes: 5,
  });
  assert.deepEqual(message.from, { name: 'My Real Partners', address: 'sender@example.test' });
  assert.equal(message.to, 'broker@example.test');
  assert.match(message.subject, /My Real Partners/);
  assert.ok(!message.subject.includes('123456'));
  assert.ok(!message.html.includes('<img'));
  assert.match(message.html, /&#60;img/);
  assert.match(message.text, /expires in 5 minutes/);
  assert.ok(!/Defence Garden|Aadhaar|PAN number/.test(message.html));
});

test('invalid codes and recipients cannot become broker reset messages', () => {
  const valid = { to: 'broker@example.test', fromAddress: 'sender@example.test', code: '123456' };
  for (const change of [{ code: '<script>' }, { to: 'a@example.test\r\nBcc:other@example.test' }, { minutes: 0 }]) {
    assert.throws(() => buildBrokerPasswordResetEmail({ ...valid, ...change }), /Invalid/);
  }
});
