import test from 'node:test';
import assert from 'node:assert/strict';
import { drawFixture } from '../test/drawFixture.mjs';
import * as booking from './booking.controller.js';
import * as draw from './draw.controller.js';
import { migrateDrawBookingBin } from '../migrations/054_draw_booking_bin.js';

const call = (handler, params, { query = {}, body = {}, user = { id: 1, role: 'admin' } } = {}) => new Promise(resolve => {
  const res = { statusCode: 200, set() {}, status(v) { this.statusCode = v; return this; }, json(data) { resolve({ status: this.statusCode, data }); } };
  handler({ params, body, query, user }, res, error => resolve({ status: error.status || 500, data: { message: error.message } }));
});

test('Draws moves cancelled registrations and linked bookings into Booking Bin', async () => {
  const f = await drawFixture();
  try {
    await f.db.exec(`
      INSERT INTO members (id, site_id, full_name) VALUES (11, 1, 'Test Customer'), (12, 2, 'Other Customer');
      INSERT INTO bookings (id, site_id, client_member_id, booking_no, status) VALUES
        (1, 1, 11, 'BK-DRAW-1', 'CONFIRMED'), (2, 1, 11, 'BK-DRAW-2', 'CONFIRMED'),
        (3, 1, 11, 'BK-LEGACY', 'CANCELLED'), (4, 1, 11, 'BK-OLD-EDIT', 'CANCELLED');
      INSERT INTO draw_registrations (id, site_id, client_member_id, registration_no, qr_token, status, booking_id, agent_user_id, allotted_plot_id) VALUES
        (1, 1, 11, 'REG-A', 'draw-a', 'REGISTERED', NULL, 2, NULL),
        (2, 1, 11, 'REG-B', 'draw-b', 'ALLOTTED', 1, 2, 1),
        (3, 1, 11, 'REG-C', 'draw-c', 'ALLOTTED', 2, 2, 2),
        (4, 1, 11, 'REG-D', 'draw-d', 'WINNER', NULL, 2, NULL),
        (5, 1, 11, 'REG-E', 'draw-e', 'ALLOTTED', 4, 2, NULL),
        (6, 1, 11, 'REG-F', 'draw-f', 'WINNER', NULL, 2, NULL),
        (7, 2, 12, 'REG-G', 'draw-g', 'CANCELLED', NULL, 2, NULL),
        (8, 1, 11, 'REG-H', 'draw-h', 'CANCELLED', NULL, 1, NULL);
      INSERT INTO draw_events (draw_registration_id, event_type, detail, actor_user_id) VALUES
        (4, 'ALLOTMENT_REVERTED', '{"booking_id": 3}', 1),
        (6, 'ALLOTMENT_REVERTED', '{"booking_id": 3}', 1), (6, 'WINNER_MARKED', NULL, 1);
      INSERT INTO draw_payments (draw_registration_id, amount) VALUES (2, 500);
    `);
    const agent = { id: 2, role: 'agent' };
    const list = (view, query) => call(draw.listDraws, {}, { user: agent, query: { site_id: 1, view, ...query } });
    const ids = res => res.data.map(row => row.id).sort((a, b) => a - b);
    assert.deepEqual(ids(await list('active')), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(ids(await list('bin')), []);
    assert.equal((await list('bin', { site_id: 2 })).status, 403);

    assert.equal((await call(draw.cancelDraw, { id: 1 })).status, 200);
    const cancelled = await call(booking.cancelBooking, { id: 1 });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.data));
    assert.equal(cancelled.data.draw_reverted, 1);
    assert.equal((await call(booking.cancelBooking, { id: 1 })).data.draw_reverted, 0);
    assert.equal((await call(booking.updateBooking, { id: 2 }, { body: { status: 'CANCELLED' } })).status, 200);

    assert.deepEqual(ids(await list('active')), [4, 5, 6]);
    assert.deepEqual(ids(await list('bin')), [1, 2, 3]);
    const { data: [archived] } = await list('bin', { q: 'BK-DRAW-1' });
    assert.equal(archived.booking_id, 1);
    assert.equal(archived.allotted_plot_id, null);
    assert.equal(archived.total_paid, 500);
    const { rows: audit } = await f.query("SELECT detail FROM draw_events WHERE draw_registration_id = 2 AND event_type = 'CANCELLED'");
    assert.deepEqual(audit.map(event => event.detail), [{ booking_id: 1 }]);

    assert.equal(await migrateDrawBookingBin(f.pool), 2);
    assert.equal(await migrateDrawBookingBin(f.pool), 0);
    assert.deepEqual(ids(await list('active')), [6]);
    assert.deepEqual(ids(await list('bin')), [1, 2, 3, 4, 5]);
    assert.deepEqual(ids(await list(undefined, { client_member_id: 11 })), [1, 2, 3, 4, 5, 6]);
  } finally {
    await f.close();
  }
});
