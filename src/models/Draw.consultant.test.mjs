import test from 'node:test';
import assert from 'node:assert/strict';
import { drawFixture } from '../test/drawFixture.mjs';
import drawModel from './Draw.model.js';

test('detail resolves consultant name and phone from the same assigned broker identity', async () => {
  const fixture = await drawFixture({ broker: true });
  try {
    const member = (await fixture.query("INSERT INTO members(site_id,full_name,phone) VALUES(1,'Application Client','9000000001') RETURNING id")).rows[0];
    const legacyBroker = (await fixture.query("INSERT INTO members(site_id,full_name,phone) VALUES(1,'Legacy Booking Broker','9000000002') RETURNING id")).rows[0];
    const booking = (await fixture.query('INSERT INTO bookings(site_id,client_member_id,booking_agent_id,agent_user_id,created_by) VALUES(1,$1,$2,2,1) RETURNING id', [member.id, legacyBroker.id])).rows[0];
    await fixture.query("UPDATE users SET phone='9000000003' WHERE id=2");
    const registration = await drawModel.create({ site_id: 1, client_member_id: member.id, registration_no: 'CONSULTANT-TEST', qr_token: 'consultant-test', created_by: 1, agent_user_id: 2, broker_member_id: 900, booking_id: booking.id }, fixture.pool);
    const consultant = async () => {
      const detail = await drawModel.getDetail(registration.id, fixture.pool);
      return { name: detail.broker_name, phone: detail.broker_phone };
    };
    assert.deepEqual(await consultant(), { name: 'Test Broker', phone: '9000000900' }, 'explicit registration broker overrides the office agent and linked booking');
    await fixture.query('UPDATE members SET phone=NULL WHERE id=900');
    assert.deepEqual(await consultant(), { name: 'Test Broker', phone: null }, 'a missing broker phone must not borrow another person’s number');
    await fixture.query('UPDATE draw_registrations SET broker_member_id=NULL WHERE id=$1', [registration.id]);
    assert.deepEqual(await consultant(), { name: 'Legacy Booking Broker', phone: '9000000002' }, 'legacy linked booking broker includes its mobile');
    await fixture.query('UPDATE members SET site_id=2 WHERE id=$1', [legacyBroker.id]);
    assert.deepEqual(await consultant(), { name: 'Test Agent', phone: '9000000003' }, 'another project cannot supply the booking consultant');
    await fixture.query('UPDATE draw_registrations SET agent_user_id=NULL WHERE id=$1', [registration.id]);
    assert.deepEqual(await consultant(), { name: 'Test Agent', phone: '9000000003' }, 'legacy booking agent supplies both fields');
    await fixture.query('UPDATE bookings SET agent_user_id=NULL WHERE id=$1', [booking.id]);
    assert.deepEqual(await consultant(), { name: null, phone: null }, 'the creator and client are not substituted for an unassigned broker');
  } finally { await fixture.close(); }
});

