import { createHmac } from 'node:crypto';
import { normalizeMobile } from './mobilePortal.service.js';

const fail = () => { throw Object.assign(new Error('The service is temporarily unavailable. Please try again.'), { statusCode: 503 }); };
const rootKey = () => {
  const dedicated = process.env.BROKER_MOBILE_IDENTITY_SECRET;
  const root = dedicated ?? process.env.MOBILE_PORTAL_SECRET ?? process.env.JWT_ACCESS_SECRET;
  if (typeof root !== 'string' || root.length < 32) fail();
  return createHmac('sha256', root).update('bookings/my-real-assets-broker/presentation/v1').digest();
};
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const compact = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const redactIdentity = value => String(value || '')
  .replace(/\b[A-Z]{5}[0-9]{4}[A-Z]\b/gi, '[Private]')
  .replace(/(?<![0-9])(?:[0-9][ -]?){11}[0-9](?![0-9])/g, '[Private]');

/** Server-only brand vocabulary. No names or their matching rules leave the API. */
export function createCompanyRedactor(brands = []) {
  const values = [...new Set(brands.filter(value => typeof value === 'string').map(value => value.trim()).filter(value => compact(value).length >= 4))];
  const patterns = values.map(value => {
    const words = value.normalize('NFKC').match(/[\p{L}\p{N}]+/gu) || [];
    return new RegExp(`(?<![\\p{L}\\p{N}])${words.map(escapeRegex).join('[\\s._/()&-]*')}(?![\\p{L}\\p{N}])`, 'giu');
  });
  const containsCompany = value => {
    const normalized = compact(value);
    return values.some(brand => normalized.includes(compact(brand)));
  };
  const text = value => {
    let result = redactIdentity(value);
    for (const pattern of patterns) result = result.replace(pattern, '[Private]');
    return result;
  };
  return { text, containsCompany };
}

export const isBrokerPropertyId = value => typeof value === 'string' && /^pr_[a-f0-9]{32}$/.test(value);

/** Stable, broker-scoped pseudonyms, never encoded numeric database keys. */
export function createBrokerPresentation(session, { brands = [] } = {}) {
  const accountId = session?.account?.id;
  if (!Number.isSafeInteger(accountId) || accountId <= 0) fail();
  const key = rootKey();
  const hash = (purpose, value) => createHmac('sha256', key).update(`${purpose}\0${accountId}\0${String(value)}`).digest('hex');
  const token = (prefix, value) => `${prefix}_${hash(prefix, value).slice(0, 32)}`;
  const readable = (prefix, purpose, value, groups = 3) => `${prefix}-${hash(purpose, value).slice(0, groups * 4).toUpperCase().match(/.{4}/g).join('-')}`;
  const redactor = createCompanyRedactor(brands);
  const propertyId = value => token('pr', value);
  const clientId = value => token('cl', value);
  const collection = siteId => ({
    collectionId: token('col', siteId),
    collectionLabel: readable('Collection', 'collection-label', siteId, 2).replace('Collection-', 'Collection '),
  });
  const publicNumber = value => {
    const number = redactor.text(value).trim();
    if (number.includes('[Private]') || number.length > 40 || !/^[\p{L}\p{N} ._/#()-]+$/u.test(number)) return 'Plot';
    if (!/[0-9]/.test(number) && number.length > 8) return 'Plot';
    return number || 'Plot';
  };
  const safeMode = value => {
    const normalized = String(value || '').trim().toUpperCase().replace(/[ -]+/g, '_');
    return new Set(['CASH', 'BANK', 'CHEQUE', 'UPI', 'CARD', 'ONLINE', 'NEFT', 'RTGS', 'IMPS', 'NET_BANKING', 'BANK_TRANSFER', 'DD']).has(normalized) ? normalized : 'Payment';
  };
  const client = value => {
    const email = String(value.email || '').trim();
    return {
      id: clientId(value.id),
      name: redactor.text(value.name).trim() || 'Client',
      phone: normalizeMobile(value.phone) || '',
      email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && redactIdentity(email) === email && !redactor.containsCompany(email) ? email : '',
      address: redactor.text(value.address), city: redactor.text(value.city),
      state: redactor.text(value.state), pincode: /^[0-9]{6}$/.test(String(value.pincode || '').trim()) ? String(value.pincode).trim() : '',
    };
  };
  const plot = value => {
    const planName = ['Full payment', 'Installment plan', 'Payment plan not set'].includes(value.paymentPlan?.name) ? value.paymentPlan.name : 'Installment plan';
    const states = { booked: 'Booked', sold: 'Sold', registry: 'Registered', registered: 'Registered', active: 'Active', transferred: 'Transferred', cancelled: 'Cancelled', canceled: 'Cancelled', 'under cancellation': 'Under cancellation' };
    let numbered = 0;
    const installments = value.installments.map(row => {
      const original = String(row.title || '').trim().toLowerCase();
      const title = original === 'booking amount' ? 'Booking amount' : original === 'full payment' ? 'Full payment' : `Installment ${++numbered}`;
      return {
        id: token('ins', `${value.id}:${row.id}`), title,
        dueDate: row.dueDate, amount: row.amount, paidAmount: row.paidAmount,
        balanceAmount: row.balanceAmount,
        status: ['paid', 'partial', 'overdue', 'upcoming'].includes(row.status) ? row.status : 'upcoming',
        interestAmount: row.interestAmount,
      };
    });
    return {
      id: propertyId(value.id), number: publicNumber(value.number), projectName: 'Your Property',
      propertyRef: readable('RA', 'property-reference', value.id), ...collection(value.projectId),
      area: value.area, areaUnit: value.areaUnit === 'sq ft' ? 'sq ft' : 'sq yd',
      status: states[String(value.status || '').toLowerCase()] || 'Active',
      totalAmount: value.totalAmount, paidAmount: value.paidAmount, balanceAmount: value.balanceAmount,
      interestAmount: value.interestAmount, totalDueAmount: value.totalDueAmount, progress: value.progress,
      nextDueDate: value.nextDueDate, nextDueAmount: value.nextDueAmount,
      nextDueInterestAmount: value.nextDueInterestAmount,
      paymentPlan: { name: planName, installmentCount: value.paymentPlan?.installmentCount || 0, bookingDate: value.paymentPlan?.bookingDate || null },
      installments,
      payments: value.payments.map(row => ({
        id: token('pay', `${value.id}:${row.id}`), date: row.date, amount: row.amount,
        mode: safeMode(row.mode),
        reference: `Receipt ${readable('RX', 'receipt-reference', `${value.id}:${row.id}`)}`,
        status: Number(row.amount) < 0 ? 'refund' : ['pending', 'approved', 'recorded', 'paid', 'completed'].includes(String(row.status || '').toLowerCase()) ? String(row.status).toLowerCase() : 'recorded',
      })),
    };
  };
  return { propertyId, clientId, collection, client, plot, redact: redactor.text };
}
