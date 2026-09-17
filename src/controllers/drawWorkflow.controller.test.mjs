import test from 'node:test';
import assert from 'node:assert/strict';
import { drawFixture } from '../test/drawFixture.mjs';
import * as controller from './draw.controller.js';
import { todayIST } from '../services/drawWorkflow.js';
import { syncDrawLedgerToPlot } from '../services/drawLedgerSync.js';

const admin = { id: 1, role: 'admin', email: 'admin@example.test' };
const call = (
  handler,
  { body = {}, params = {}, query = {}, user = admin } = {},
) =>
  new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(value) {
        this.statusCode = value;
        return this;
      },
      json(value) {
        resolve({ status: this.statusCode, data: value });
      },
    };
    handler({ body, params, query, user }, res, (error) =>
      resolve({
        status: error.status || 500,
        data: { message: error.message },
      }),
    );
  });

test('booking journey on isolated PostgreSQL, including rollback and replay protection', async (t) => {
  const fixture = await drawFixture();
  let id;
  try {
    await t.test(
      'settings and quick intake create a member but defer KYC',
      async () => {
        assert.equal(
          (
            await call(controller.setDrawSettings, {
              body: { site_id: 1, required_amount: 5000, wait_days: 10 },
            })
          ).status,
          200,
        );
        const body = {
          site_id: 1,
          phone: '9876543210',
          full_name: 'Asha Test',
          request_key: 'registration-test-001',
        };
        const created = await call(controller.createDraw, { body });
        assert.equal(created.status, 201, JSON.stringify(created.data));
        id = created.data.id;
        assert.equal(created.data.kyc_case_id, null);
        assert.equal(created.data.status, 'REGISTERED');
        assert.ok(created.data.draw_opening_date > todayIST());
        assert.equal((await call(controller.createDraw, { body })).data.id, id);
        assert.equal(
          (
            await fixture.query(
              'SELECT count(*)::int AS n FROM draw_registrations',
            )
          ).rows[0].n,
          1,
        );
      },
    );
    await t.test(
      'payment precedes KYC and retry does not double-charge',
      async () => {
        assert.equal(
          (await call(controller.startDrawKyc, { params: { id } })).status,
          409,
        );
        const body = {
          amount: 5000,
          payment_from: 'CASH',
          request_key: 'payment-test-001',
        };
        const first = await call(controller.addDrawPayment, {
          params: { id },
          body,
        });
        assert.equal(first.status, 201, JSON.stringify(first.data));
        assert.equal(first.data.payments.length, 1);
        assert.ok(first.data.payments[0].receipt_no);
        const replay = await call(controller.addDrawPayment, {
          params: { id },
          body,
        });
        assert.equal(replay.data.total_paid, 5000);
        assert.equal(replay.data.payments.length, 1);
        assert.equal(
          (
            await call(controller.addDrawPayment, {
              params: { id },
              body: { ...body, amount: 6000 },
            })
          ).status,
          409,
        );
        assert.equal(
          (
            await call(controller.addDrawPayment, {
              params: { id },
              body,
              user: { id: 2, role: 'agent' },
            })
          ).status,
          403,
        );
        assert.equal(
          (await call(controller.startDrawKyc, { params: { id } })).status,
          200,
        );
        assert.equal(
          (await call(controller.startDrawKyc, { params: { id } })).status,
          200,
        );
        assert.equal(
          (await fixture.query('SELECT count(*)::int AS n FROM kyc_cases'))
            .rows[0].n,
          1,
        );
      },
    );
    await t.test(
      'documents require verified KYC and preserve issued terms',
      async () => {
        assert.equal(
          (await call(controller.issueSlip, { params: { id } })).status,
          400,
        );
        await fixture.query("UPDATE kyc_cases SET status = 'VERIFIED'");
        const issued = await call(controller.issueSlip, { params: { id } });
        assert.equal(issued.status, 200, JSON.stringify(issued.data));
        assert.ok(issued.data.slip_no);
        const terms = issued.data.terms_snapshot;
        await call(controller.setDrawSettings, {
          body: {
            site_id: 1,
            required_amount: 5000,
            terms: 'Updated project terms.',
          },
        });
        assert.equal(
          (await call(controller.getDraw, { params: { id } })).data
            .terms_snapshot,
          terms,
        );
        assert.equal(
          (await call(controller.issueSlip, { params: { id } })).status,
          409,
        );
      },
    );
    await t.test(
      'physical result is blocked before opening and rejects mismatched slips',
      async () => {
        const reg = (await call(controller.getDraw, { params: { id } })).data;
        assert.equal(
          (
            await call(controller.markWinner, {
              params: { id },
              body: { slip_no: reg.slip_no },
            })
          ).status,
          409,
        );
        assert.equal(
          (
            await call(controller.updateDraw, {
              params: { id },
              body: { draw_opening_date: todayIST() },
            })
          ).status,
          200,
        );
        assert.equal(
          (
            await call(controller.markWinner, {
              params: { id },
              body: { slip_no: 'WRONG' },
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await call(controller.markWinner, {
              params: { id },
              body: { slip_no: reg.slip_no },
            })
          ).status,
          200,
        );
        assert.equal(
          (
            await call(controller.markWinner, {
              params: { id },
              body: { slip_no: reg.slip_no },
            })
          ).status,
          409,
        );
      },
    );
    await t.test(
      'allotment rolls back if the accounting receipt cannot be inserted',
      async () => {
        await fixture.query(
          'ALTER TABLE plot_payments ADD CONSTRAINT fail_test CHECK (amount < 1000)',
        );
        const failed = await call(controller.allotShop, {
          params: { id },
          body: { plot_id: 1, payment_plan: 'INSTALLMENT' },
        });
        assert.equal(failed.status, 409, JSON.stringify(failed));
        assert.equal(
          (await fixture.query('SELECT count(*)::int AS n FROM bookings'))
            .rows[0].n,
          0,
        );
        assert.equal(
          (await fixture.query('SELECT status FROM plots WHERE id=1')).rows[0]
            .status,
          'AVAILABLE',
        );
        assert.equal(
          (
            await fixture.query(
              'SELECT status FROM draw_registrations WHERE id=$1',
              [id],
            )
          ).rows[0].status,
          'WINNER',
        );
        await fixture.query(
          'ALTER TABLE plot_payments DROP CONSTRAINT fail_test',
        );
      },
    );
    await t.test(
      'allotment creates installment booking with KYC and one mirrored receipt',
      async () => {
        const allotted = await call(controller.allotShop, {
          params: { id },
          body: {
            plot_id: 1,
            sale_price: 1050000,
            payment_plan: 'INSTALLMENT',
          },
        });
        assert.equal(allotted.status, 200, JSON.stringify(allotted));
        assert.equal(allotted.data.status, 'ALLOTTED');
        assert.equal(allotted.data.booking_kyc_status, 'VERIFIED');
        const booking = (await fixture.query('SELECT * FROM bookings')).rows[0];
        assert.equal(booking.payment_plan, 'INSTALLMENT');
        assert.equal(Number(booking.sale_price), 1050000);
        const mirror = await syncDrawLedgerToPlot(id, fixture.pool);
        assert.equal(mirror.ok, true);
        assert.equal(mirror.created, 0);
        assert.equal(
          (await fixture.query('SELECT count(*)::int AS n FROM plot_payments'))
            .rows[0].n,
          1,
        );
        assert.equal(
          (
            await call(controller.allotShop, {
              params: { id },
              body: { plot_id: 1 },
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await call(controller.deleteDrawPayment, {
              params: { id, paymentId: allotted.data.payments[0].id },
            })
          ).status,
          409,
        );
        assert.equal(
          (await call(controller.deleteDraw, { params: { id } })).status,
          409,
        );
      },
    );
    await t.test(
      'workflow queue has filtered totals, bounded pages and network scoping',
      async () => {
        const list = await call(controller.listWorkflow, {
          query: { site_id: 1 },
        });
        assert.equal(list.status, 200, JSON.stringify(list));
        assert.equal(list.data.total, 1);
        assert.equal(list.data.counts.BOOKED, 1);
        assert.equal(list.data.items[0].stage, 'BOOKED');
        assert.equal(
          (
            await call(controller.listWorkflow, {
              query: { site_id: 1, stage: 'PAYMENT' },
            })
          ).data.total,
          0,
        );
        assert.equal(
          (
            await call(controller.listWorkflow, {
              query: { site_id: 1 },
              user: { id: 2, role: 'agent' },
            })
          ).data.total,
          0,
        );
        assert.equal(
          (
            await call(controller.startDrawKyc, {
              params: { id },
              user: { id: 2, role: 'agent' },
            })
          ).status,
          403,
        );
      },
    );
    await t.test(
      'repeat customers still need a paid, linked KYC and cannot take an allotted unit',
      async () => {
        const second = await call(controller.createDraw, {
          body: {
            site_id: 1,
            phone: '9876543210',
            full_name: 'Asha Test',
            request_key: 'registration-test-002',
          },
        });
        assert.equal(second.status, 201);
        const nextId = second.data.id;
        assert.equal(second.data.kyc_case_id, null);
        assert.equal(second.data.kyc_status, null);
        assert.equal(
          (await call(controller.startDrawKyc, { params: { id: nextId } }))
            .status,
          409,
        );
        await call(controller.addDrawPayment, {
          params: { id: nextId },
          body: { amount: 5000, request_key: 'payment-test-002' },
        });
        const started = await call(controller.startDrawKyc, {
          params: { id: nextId },
        });
        assert.equal(started.data.kyc_status, 'OPEN');
        await fixture.query(
          "UPDATE kyc_cases SET status = 'VERIFIED' WHERE id = $1",
          [started.data.kyc_case_id],
        );
        await call(controller.updateDraw, {
          params: { id: nextId },
          body: { draw_opening_date: todayIST() },
        });
        const slip = await call(controller.issueSlip, {
          params: { id: nextId },
        });
        assert.equal(slip.status, 200);
        await call(controller.markWinner, {
          params: { id: nextId },
          body: { slip_no: slip.data.slip_no },
        });
        assert.equal(
          (
            await call(controller.allotShop, {
              params: { id: nextId },
              body: { plot_id: 1 },
            })
          ).status,
          409,
        );
        assert.equal(
          (await fixture.query('SELECT count(*)::int AS n FROM bookings'))
            .rows[0].n,
          1,
        );
      },
    );
    await t.test(
      'legacy winners without a scheduled date can still be allotted',
      async () => {
        const { rows } = await fixture.query(
          "SELECT id FROM draw_registrations WHERE status = 'WINNER' LIMIT 1",
        );
        assert.ok(rows[0]);
        await fixture.query(
          'UPDATE draw_registrations SET workflow_version = 0, draw_opening_date = NULL WHERE id = $1',
          [rows[0].id],
        );
        const allotted = await call(controller.allotShop, {
          params: { id: rows[0].id },
          body: { plot_id: 2, payment_plan: 'FULL' },
        });
        assert.equal(allotted.status, 200, JSON.stringify(allotted));
        assert.equal(allotted.data.status, 'ALLOTTED');
      },
    );
    await t.test(
      'queue pagination does not truncate totals or return more than 25 customers',
      async () => {
        await fixture.query(`INSERT INTO draw_registrations (site_id, client_member_id, registration_no, required_amount, qr_token, created_by, workflow_version)
        SELECT 1, 1, 'TEST-' || n, 5000, 'pagination-token-' || n, 1, 1 FROM generate_series(1, 27) n`);
        const page1 = await call(controller.listWorkflow, {
          query: { site_id: 1, stage: 'PAYMENT', page: 1 },
        });
        const page2 = await call(controller.listWorkflow, {
          query: { site_id: 1, stage: 'PAYMENT', page: 2 },
        });
        assert.equal(page1.data.total, 27);
        assert.equal(page1.data.items.length, 25);
        assert.equal(page2.data.items.length, 2);
        assert.equal(
          new Set(
            [...page1.data.items, ...page2.data.items].map((row) => row.id),
          ).size,
          27,
        );
      },
    );
  } finally {
    await fixture.close();
  }
});
