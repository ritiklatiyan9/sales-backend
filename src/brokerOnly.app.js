import express from 'express';
import helmet from 'helmet';
import brokerRouter, { createBrokerMobileRouter } from './routes/brokerMobile.routes.js';

const posts = new Set([
  '/api/broker-mobile/auth/login',
  '/api/broker-mobile/auth/password-reset/request',
  '/api/broker-mobile/auth/password-reset/confirm',
  '/api/broker-mobile/auth/password/change',
  '/api/broker-mobile/auth/logout',
  '/api/broker-mobile/device-tokens',
]);
const gets = new Set([
  '/api/broker-mobile/status', '/api/broker-mobile/me', '/api/broker-mobile/portfolio', '/api/broker-mobile/commissions',
]);

/** Direct Bookings services, without mounting its website, staff or client APIs. */
export function createBrokerOnlyApp({ service, routerOptions, trustProxy } = {}) {
  const app = express();
  app.disable('x-powered-by');
  if (trustProxy) app.set('trust proxy', trustProxy);
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } }));
  app.use((req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    res.set('Referrer-Policy', 'no-referrer');
    if (req.method === 'GET' && req.url === '/health') {
      return res.json({ status: 'ok', service: 'my-real-partners-api' });
    }
    const permitted = req.method === 'DELETE' ? req.url==='/api/broker-mobile/device-tokens' : req.method === 'POST' ? posts.has(req.url)
      : req.method === 'GET' && (gets.has(req.url) || /^\/api\/broker-mobile\/plots\/pr_[a-f0-9]{32}$/.test(req.url));
    if (!permitted) return res.status(404).json({ message: 'Not found.' });
    if (['POST','DELETE'].includes(req.method) && !req.is('application/json')) {
      return res.status(415).json({ message: 'Send a JSON request.' });
    }
    next();
  });
  app.use(express.json({ limit: '16kb', strict: true }));
  app.use((req, res, next) => {
    if (['POST','DELETE'].includes(req.method) && (!req.body || Array.isArray(req.body) || typeof req.body !== 'object')) {
      return res.status(400).json({ message: 'Please check the request.' });
    }
    next();
  });
  app.use('/api/broker-mobile', service ? createBrokerMobileRouter(service, routerOptions) : brokerRouter);
  app.use((_req, res) => res.status(404).json({ message: 'Not found.' }));
  app.use((error, _req, res, _next) => {
    if (res.headersSent) return res.destroy();
    const status = error.type === 'entity.too.large' ? 413 : error.type === 'entity.parse.failed' ? 400 : 503;
    res.status(status).json({ message: status === 413 ? 'Request too large.' : status === 400
      ? 'Please check the request.' : 'The service is temporarily unavailable. Please try again.' });
  });
  return app;
}
