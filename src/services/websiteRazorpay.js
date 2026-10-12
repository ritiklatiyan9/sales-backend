import { createHmac, timingSafeEqual } from 'node:crypto';
import Razorpay from 'razorpay';

export function secureHexEqual(expected, supplied) {
  if (!/^[a-fA-F0-9]{64}$/.test(String(supplied || ''))) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(supplied, 'hex'));
}

export function verifyCheckoutSignature(orderId, paymentId, signature, secret) {
  if (!secret) return false;
  return secureHexEqual(createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex'), signature);
}

export function verifyWebhookSignature(rawBody, signature, secret) {
  return !!secret && Buffer.isBuffer(rawBody) && secureHexEqual(
    createHmac('sha256', secret).update(rawBody).digest('hex'), signature,
  );
}

export function createRazorpayGateway({ keyId = process.env.RAZORPAY_KEY_ID, secret = process.env.RAZORPAY_KEY_SECRET, clientFactory = options => new Razorpay(options) } = {}) {
  const ready = !!keyId && !!secret;
  const client = ready ? clientFactory({ key_id: keyId, key_secret: secret }) : null;
  // Bound SDK requests too: a lost response must retain the existing reservation
  // for reconciliation rather than allow another order to be created.
  if (client?.api?.rq) client.api.rq.defaults.timeout = 15000;
  async function call(operation) {
    if (!ready) throw Object.assign(new Error('Online payment is not configured'), { status: 503, code: 'PAYMENT_UNAVAILABLE' });
    try {
      return await operation();
    } catch (error) {
      const status = Number(error?.statusCode);
      if (status === 401) throw Object.assign(new Error('Payment provider authentication failed. Please contact the booking team.'), {
        status: 401, code: 'GATEWAY_AUTH_FAILED', uncertain: false,
      });
      if (!status) throw Object.assign(new Error('Payment provider did not respond. Your request is saved; retry verification or contact the office.'), {
        status: 500, code: 'GATEWAY_TIMEOUT', uncertain: true,
      });
      throw Object.assign(new Error('The payment provider could not complete this request. Please retry or contact the office.'), {
        status: 500, code: 'GATEWAY_ERROR', uncertain: status >= 500,
        gatewayCode: String(error?.error?.code || 'HTTP_ERROR').slice(0, 100),
      });
    }
  }
  return {
    keyId, secret, ready,
    createOrder: async (data) => {
      if (!Number.isSafeInteger(data?.amount) || data.amount < 100) throw Object.assign(new Error('Order amount must be at least 100 paise.'), {
        status: 400, code: 'INVALID_ORDER_AMOUNT',
      });
      return call(() => client.orders.create(data));
    },
    fetchOrder: (id) => call(() => client.orders.fetch(id)),
    fetchPayment: (id) => call(() => client.payments.fetch(id)),
    fetchOrderPayments: (id) => call(() => client.orders.fetchPayments(id)),
  };
}
