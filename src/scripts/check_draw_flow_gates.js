import 'dotenv/config';
import jwt from 'jsonwebtoken';
import pool from '../config/db.js';

/**
 * Self-check for the draw-flow role gates (agents = register + KYC only; money =
 * admin roles; decisions = admin/super_admin). Boots the real app on a scratch
 * port and asserts the 403/400 gates with tokens signed for real active users.
 * SAFE on the live DB: every asserted path is rejected BEFORE any write.
 *
 * Run: node src/scripts/check_draw_flow_gates.js
 */
const PORT = 8977;

const signFor = (u) =>
  jwt.sign({ id: u.id, email: u.email, role: u.role, version: u.token_version },
    process.env.JWT_ACCESS_SECRET, { expiresIn: '5m' });

const call = async (method, path, token, body) => {
  const res = await fetch(`http://localhost:${PORT}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const main = async () => {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (role) id, email, role, token_version
       FROM users WHERE is_active = true AND role IN ('agent','sub_admin','admin')
      ORDER BY role, id`
  );
  const users = Object.fromEntries(rows.map((r) => [r.role, r]));
  // ONLY pre-slip registrations whose resolved KYC is NOT verified: on such a row the
  // admin slip call is guaranteed to be rejected by the KYC gate (400) before any
  // write. A VERIFIED+ELIGIBLE row would let issueSlip COMMIT a real slip — never
  // point this check at one.
  const { rows: draws } = await pool.query(
    `SELECT r.id FROM draw_registrations r
     LEFT JOIN LATERAL (
       SELECT kc.status FROM kyc_cases kc
        WHERE kc.id = r.kyc_case_id OR kc.client_member_id = r.client_member_id
        ORDER BY (kc.id = r.kyc_case_id) DESC NULLS LAST, kc.id DESC LIMIT 1
     ) k ON true
     WHERE r.status IN ('REGISTERED','ELIGIBLE') AND COALESCE(k.status, '') <> 'VERIFIED'
     ORDER BY r.id DESC LIMIT 1`
  );
  if (!users.agent || !users.admin || !draws[0]) {
    console.log('SKIP: need an active agent, an admin and one pre-slip draw registration with unverified KYC');
    process.exit(0);
  }
  const drawId = draws[0].id;
  const agent = signFor(users.agent);
  const admin = signFor(users.admin);
  const subAdmin = users.sub_admin ? signFor(users.sub_admin) : null;

  // server.js listens on import (PORT env read at module load) — boot on the scratch port.
  process.env.PORT = String(PORT);
  await import('../server.js');
  await new Promise((r) => setTimeout(r, 1200));

  const checks = [];
  const expect = (name, got, want) => {
    const ok = got === want;
    checks.push([ok, `${name}: expected ${want}, got ${got}`]);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name} (${got})`);
  };

  // Agents: no money, no slip, no decisions, no amount edits.
  expect('agent add payment → 403', (await call('POST', `/draws/${drawId}/payments`, agent, { amount: 100 })).status, 403);
  expect('agent issue slip → 403', (await call('POST', `/draws/${drawId}/issue-slip`, agent)).status, 403);
  expect('agent mark winner → 403', (await call('POST', `/draws/${drawId}/winner`, agent, { winner: true })).status, 403);
  expect('agent allot → 403', (await call('POST', `/draws/${drawId}/allot`, agent, { plot_id: 1 })).status, 403);
  expect('agent set amount → 403', (await call('PATCH', `/draws/${drawId}`, agent, { required_amount: 5000 })).status, 403);
  expect('agent register w/ payment → 403', (await call('POST', '/draws', agent, { site_id: 1, phone: '0000000000', required_amount: 100, amount: 50 })).status, 403);

  // Draw Settings: readable by anyone, writable only by admin/super_admin.
  expect('agent set draw settings → 403', (await call('PUT', '/draws/settings', agent, { site_id: 1, required_amount: 5000 })).status, 403);
  expect('agent read draw settings → 200', (await call('GET', '/draws/settings?site_id=1', agent)).status, 200);

  // sub_admin: manages money-adjacent gates but does NOT decide winners/allotments/amounts.
  if (subAdmin) {
    expect('sub_admin mark winner → 403', (await call('POST', `/draws/${drawId}/winner`, subAdmin, { winner: true })).status, 403);
    expect('sub_admin allot → 403', (await call('POST', `/draws/${drawId}/allot`, subAdmin, { plot_id: 1 })).status, 403);
    expect('sub_admin set amount → 403', (await call('PATCH', `/draws/${drawId}`, subAdmin, { required_amount: 5000 })).status, 403);
    expect('sub_admin set draw settings → 403', (await call('PUT', '/draws/settings', subAdmin, { site_id: 1, required_amount: 5000 })).status, 403);
  }

  // Admin: slip on an unverified-KYC draw must be blocked by the KYC gate (400), not
  // 403 — and never succeed (the selection above guarantees the KYC gate fires).
  const slip = await call('POST', `/draws/${drawId}/issue-slip`, admin);
  const kycGated = slip.status === 400 && /KYC/i.test(slip.body?.message || '');
  const slipMsg = `admin slip pre-KYC → 400 KYC gate: got ${slip.status} "${slip.body?.message}"`;
  checks.push([kycGated, slipMsg]);
  console.log(`${kycGated ? 'PASS' : 'FAIL'} ${slipMsg}`);

  // Detail carries the KYC linkage fields.
  const detail = await call('GET', `/draws/${drawId}`, admin);
  expect('admin get detail → 200', detail.status, 200);
  const hasKycFields = 'kyc_case_id' in detail.body && 'kyc_status' in detail.body;
  checks.push([hasKycFields, 'detail includes kyc_case_id/kyc_status']);
  console.log(`${hasKycFields ? 'PASS' : 'FAIL'} detail includes kyc_case_id/kyc_status`);

  const failed = checks.filter(([ok]) => !ok);
  console.log(failed.length ? `\n${failed.length} FAILED` : '\nALL GATES OK');
  process.exit(failed.length ? 1 : 0);
};

main().catch((e) => { console.error(e); process.exit(1); });
