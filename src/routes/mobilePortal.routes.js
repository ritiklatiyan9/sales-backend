import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import express from 'express';
import pool from '../config/db.js';
import { createMobilePortalService, normalizeMobile } from '../services/mobilePortal.service.js';

const gzipAsync = promisify(gzip);
async function sendPortfolioJson(req, res, payload) {
  res.vary('Accept-Encoding');
  // Small JSON stays uncompressed. Fast asynchronous gzip reduces mobile data
  // without blocking the event loop or changing private/no-store semantics.
  if (req.get('Accept-Encoding') && req.acceptsEncodings('gzip') === 'gzip') {
    const json = JSON.stringify(payload);
    if (Buffer.byteLength(json) > 2048) {
      const compressed = await gzipAsync(json, { level: 1 });
      if (compressed.length < Buffer.byteLength(json)) {
        res.set('Content-Encoding', 'gzip');
        return res.type('application/json').send(compressed);
      }
    }
  }
  return res.json(payload);
}

// Bounded, process-local sign-in limiter. Do not trust X-Forwarded-For supplied
// by a caller; req.ip honors only an explicitly configured Express proxy.
export function createMobileLoginLimiter({ now = Date.now, windowMs = 15 * 60 * 1000, maxEntries = 10000 } = {}) {
  const entries = new Map();
  return (req, res, next) => {
    const time = now();
    for (const [key, entry] of entries) if (entry.until <= time) entries.delete(key);
    const mobile = normalizeMobile(req.body?.mobile) || 'invalid';
    const keys = [
      [createHash('sha256').update(`ip:${req.ip || req.socket?.remoteAddress || 'unknown'}`).digest('hex'), 40],
      [createHash('sha256').update(`mobile:${mobile}`).digest('hex'), 10],
    ];
    for (const [key, maximum] of keys) {
      const entry = entries.get(key);
      if ((entry?.count || 0) >= maximum || (!entry && entries.size >= maxEntries)) {
        res.set('Retry-After', String(Math.ceil(((entry?.until || time + windowMs) - time) / 1000)));
        return res.status(429).json({ message: 'Too many sign-in attempts. Please try again shortly.' });
      }
    }
    for (const [key] of keys) {
      const entry = entries.get(key) || { count: 0, until: time + windowMs };
      entry.count += 1;
      entries.set(key, entry);
    }
    next();
  };
}

export function mobilePortalEnabled(env = process.env) {
  return env.MOBILE_PORTAL_ENABLED === 'true';
}

export function createMobilePortalRouter(service, {
  loginLimiter = createMobileLoginLimiter(), isEnabled = () => mobilePortalEnabled(),
} = {}) {
  const router = express.Router();
  const run = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(error => {
    const status = [400, 401, 403, 404, 429, 503].includes(error.statusCode) ? error.statusCode : 503;
    // Never send SQL, identity fields, credentials or signing failures.
    res.status(status).json({ message: status === 503 ? 'The service is temporarily unavailable. Please try again.' : error.message });
  });
  router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
  router.get('/status', (_req, res) => res.json({
    service: 'my-real-assets', apiVersion: 1, enabled: Boolean(isEnabled()),
  }));
  // Mobile access is independent of the existing paused web client portal.
  // A production deployment opts in explicitly; disabled access never enters auth.
  router.use((_req, res, next) => {
    if (!isEnabled()) return res.status(503).json({
      code: 'MOBILE_PORTAL_DISABLED', message: 'Client access is temporarily unavailable.',
    });
    next();
  });
  router.get('/health', (_req, res) => res.json({ status: 'ok', service: 'my-real-assets', backend: 'bookings' }));
  router.post('/auth/login', loginLimiter, run(async (req, res) => res.json(await service.login(req.body))));
  router.use(run(async (req, res, next) => {
    const authorization = req.get('Authorization');
    if (!/^Bearer [A-Za-z0-9_.-]+$/.test(authorization || '') || authorization.length > 4096) {
      return res.status(401).json({ message: 'Please sign in again.' });
    }
    req.mobileSession = await service.getSession(authorization.slice(7));
    next();
  }));
  router.get('/me', (req, res) => res.json({ user: req.mobileSession.user }));
  const forceFresh = req => /(?:^|,)\s*(?:no-cache|no-store|max-age=0)\s*(?:,|$)/i.test(req.get('Cache-Control') || '');
  router.get('/plots', run(async (req, res) => sendPortfolioJson(req, res, await service.portfolio(req.mobileSession, {
    includeDetails: req.query?.include === 'details', forceFresh: forceFresh(req),
  }))));
  router.get('/plots/:id', run(async (req, res) => sendPortfolioJson(req, res, await service.plot(req.mobileSession, req.params.id, { forceFresh: forceFresh(req) }))));
  return router;
}

export default createMobilePortalRouter(createMobilePortalService(pool));
