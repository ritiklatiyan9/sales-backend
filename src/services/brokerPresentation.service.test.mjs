import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrokerPresentation, createCompanyRedactor } from './brokerPresentation.service.js';

test('broker presentation uses stable scoped nonreversible identifiers and distinct readable references', () => {
  const previous = process.env.MOBILE_PORTAL_SECRET;
  process.env.MOBILE_PORTAL_SECRET = 'synthetic-presentation-secret-more-than-thirty-two-characters';
  try {
    const a = createBrokerPresentation({ account: { id: 1 } });
    const same = createBrokerPresentation({ account: { id: 1 } });
    const other = createBrokerPresentation({ account: { id: 2 } });
    assert.match(a.propertyId(117), /^pr_[a-f0-9]{32}$/);
    assert.equal(a.propertyId(117), same.propertyId(117));
    assert.notEqual(a.propertyId(117), other.propertyId(117));
    assert.notEqual(a.clientId(117), a.propertyId(117));
    assert.notEqual(a.collection(5).collectionId, other.collection(5).collectionId);
    assert.match(a.collection(5).collectionLabel, /^Collection [A-F0-9]{4}-[A-F0-9]{4}$/);
    assert.equal(new Set(Array.from({ length: 1000 }, (_, i) => a.propertyId(i + 1))).size, 1000);
    assert.equal(new Set(Array.from({ length: 1000 }, (_, i) => a.plot({
      id: i + 1, projectId: 5, number: 'B34', installments: [], payments: [], paymentPlan: {},
    }).propertyRef)).size, 1000);
  } finally {
    if (previous === undefined) delete process.env.MOBILE_PORTAL_SECRET;
    else process.env.MOBILE_PORTAL_SECRET = previous;
  }
});

test('known company names, compact brands and raw bookkeeping text cannot escape the public projection', () => {
  const previous = process.env.MOBILE_PORTAL_SECRET;
  process.env.MOBILE_PORTAL_SECRET = 'synthetic-presentation-secret-more-than-thirty-two-characters';
  try {
    const p = createBrokerPresentation({ account: { id: 1 } }, { brands: ['Private Company Branding', 'Owner Organization'] });
    const source = {
      id: 117, projectId: 5, projectName: 'Private Company Branding', number: 'B34', status: 'REGISTRY',
      totalAmount: 1000, paidAmount: 600, balanceAmount: 400, progress: .6,
      paymentPlan: { name: 'PrivateCompanyBranding finance plan', installmentCount: 1 },
      installments: [{ id: 55, title: 'Private Company Branding — 234567890123', amount: 1000, paidAmount: 600, balanceAmount: 400, status: 'partial' }],
      payments: [{ id: 'payment:23', date: '2026-01-01', amount: 600, mode: 'OwnerOrganization bank', reference: 'https://PrivateCompanyBranding.example/receipt/ABCDE1234F', status: 'approved' }],
    };
    const view = p.plot(source);
    assert.equal(view.number, 'B34');
    assert.equal(view.totalAmount, 1000); assert.equal(view.paidAmount, 600);
    assert.equal(view.installments[0].title, 'Installment 1');
    assert.match(view.installments[0].id, /^ins_[a-f0-9]{32}$/);
    assert.match(view.payments[0].id, /^pay_[a-f0-9]{32}$/);
    assert.match(view.payments[0].reference, /^Receipt RX-(?:[A-F0-9]{4}-){2}[A-F0-9]{4}$/);
    assert.equal(view.payments[0].mode, 'Payment');
    assert.ok(!Object.hasOwn(view, 'projectId'));
    assert.ok(!/Private.?Company.?Branding|Owner.?Organization|234567890123|ABCDE1234F|https?:|payment:23/i.test(JSON.stringify(view)));
    const contact = p.client({ id: 10, name: 'Client Name', phone: '+91 98765 43210', email: 'a@privatecompanybranding.example', address: 'Private-Company-Branding, Example Street', city: 'Example City' });
    assert.equal(contact.name, 'Client Name'); assert.equal(contact.phone, '9876543210');
    assert.equal(contact.email, ''); assert.equal(contact.address, '[Private], Example Street');
    for (const email of ['234567890123@example.test', 'ABCDE1234F@example.test']) {
      assert.equal(p.client({ id: 10, name: 'Client Name', email }).email, '', 'government identifiers in freeform contacts stay private');
    }
    assert.equal(p.client({ id: 10, name: 'Client Name', email: 'personal@example.test' }).email, 'personal@example.test');
    const redact = createCompanyRedactor(['Owner Organization']);
    assert.equal(redact.text('OwnerOrganization and Owner_Organization'), '[Private] and [Private]');
  } finally {
    if (previous === undefined) delete process.env.MOBILE_PORTAL_SECRET;
    else process.env.MOBILE_PORTAL_SECRET = previous;
  }
});
