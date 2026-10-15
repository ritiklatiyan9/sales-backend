import test from 'node:test';
import assert from 'node:assert/strict';
import { drawFixture } from '../test/drawFixture.mjs';
import drawModel from './Draw.model.js';

test('workflow booking method follows approved website linkage and retains project and network scope', async () => {
  const fixture = await drawFixture();
  try {
    const member = (await fixture.query("INSERT INTO members(site_id,full_name,phone) VALUES(1,'Source Test','9876543210') RETURNING id")).rows[0];
    const booking = (await fixture.query('INSERT INTO bookings(site_id,client_member_id,created_by) VALUES(1,$1,1) RETURNING id', [member.id])).rows[0];
    const partner = await drawModel.create({ site_id: 1, client_member_id: member.id, registration_no: 'METHOD-PARTNER', qr_token: 'method-partner', created_by: 1, agent_user_id: 1, required_amount: 2000 }, fixture.pool);
    const website = await drawModel.create({ site_id: 1, client_member_id: member.id, registration_no: 'METHOD-WEBSITE', qr_token: 'method-website', created_by: 2, agent_user_id: 2, booking_id: booking.id, required_amount: 3000 }, fixture.pool);
    await fixture.query('INSERT INTO draw_payments(draw_registration_id, amount) VALUES($1,100.25),($2,200.50)', [partner.id, website.id]);
    const queue = options => drawModel.workflow({ siteId: 1, ...options }, fixture.pool);
    let result = await queue();
    assert.equal(result.total, 2);
    assert.deepEqual(result.totals, { total_paid: 300.75, required_amount: 5000 });
    assert.ok(result.items.every(row => row.booking_method === 'DIRECT'), 'older installations without website tables still load');
    assert.equal(result.items.find(row => row.id === partner.id).broker_name, 'Test Admin');
    assert.equal(result.items.find(row => row.id === website.id).broker_name, 'Test Agent');

    // Test-only schema: never connects to the configured inventory database.
    await fixture.query('CREATE TABLE website_booking_requests (booking_id INTEGER, site_id INTEGER, status TEXT)');
    await fixture.query("INSERT INTO website_booking_requests VALUES($1,1,'PAYMENT_REVIEW')", [booking.id]);
    assert.equal((await queue()).items.find(row => row.id === website.id).booking_method, 'DIRECT', 'unapproved payments do not change booking origin');
    await fixture.query("UPDATE website_booking_requests SET status='APPROVED'");
    result = await queue();
    assert.equal(result.items.find(row => row.id === website.id).booking_method, 'WEBSITE');
    assert.equal(result.items.find(row => row.id === partner.id).booking_method, 'DIRECT');
    assert.equal(result.items.find(row => row.id === website.id).broker_name, 'Test Agent', 'website method retains the linked broker');
    assert.equal(result.total, 2, 'classification cannot duplicate or add customers');
    const scoped = await queue({ visibleUserIds: [1] });
    assert.equal(scoped.total, 1);
    assert.equal(scoped.items[0].id, partner.id, 'another broker cannot see the website customer');
    assert.deepEqual(scoped.totals, { total_paid: 100.25, required_amount: 2000 }, 'network scope applies to money totals');
    const otherSite = await drawModel.workflow({ siteId: 2 }, fixture.pool);
    assert.equal(otherSite.total, 0);
    assert.deepEqual(otherSite.totals, { total_paid: 0, required_amount: 0 });
    assert.deepEqual((await queue({ stage: 'BOOKED' })).totals, { total_paid: 0, required_amount: 0 }, 'an empty stage has zero totals');
    await fixture.query('UPDATE website_booking_requests SET site_id=2');
    assert.equal((await queue()).items.find(row => row.id === website.id).booking_method, 'DIRECT', 'a different project cannot supply website attribution');

    const broker = (await fixture.query("INSERT INTO members(site_id,full_name) VALUES(1,'Selected Broker') RETURNING id")).rows[0];
    await fixture.query('UPDATE bookings SET booking_agent_id=$1 WHERE id=$2', [broker.id, booking.id]);
    assert.equal((await queue()).items.find(row => row.id === website.id).broker_name, 'Selected Broker', 'explicit booking broker takes precedence');
    await fixture.query('UPDATE members SET site_id=2 WHERE id=$1', [broker.id]);
    assert.equal((await queue()).items.find(row => row.id === website.id).broker_name, 'Test Agent', 'another project cannot supply the broker name');
    await fixture.query('UPDATE bookings SET booking_agent_id=NULL WHERE id=$1', [booking.id]);
    await fixture.query('UPDATE draw_registrations SET agent_user_id=NULL WHERE id=$1', [website.id]);
    await fixture.query('UPDATE bookings SET agent_user_id=2 WHERE id=$1', [booking.id]);
    assert.equal((await queue()).items.find(row => row.id === website.id).broker_name, 'Test Agent', 'linked booking supplies the broker when registration has none');

    const direct = await drawModel.create({ site_id: 1, client_member_id: member.id, registration_no: 'METHOD-DIRECT', qr_token: 'method-direct', created_by: 1 }, fixture.pool);
    const directRow = (await queue()).items.find(row => row.id === direct.id);
    assert.equal(directRow.booking_method, 'DIRECT');
    assert.equal(directRow.broker_name, null, 'staff creator must not be invented as the broker');
  } finally { await fixture.close(); }
});
