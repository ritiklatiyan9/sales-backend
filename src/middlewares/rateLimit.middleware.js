import { createHash } from 'node:crypto';

/** Bounded, per-process abuse protection. req.ip relies only on configured proxies. */
export function rateLimit({ limit, windowMs, key = req => req.ip || req.socket?.remoteAddress || 'unknown', maxKeys = 10000, clock = Date.now }) {
  const buckets = new Map();
  let nextSweep = 0;
  return (req, res, next) => {
    const now = clock();
    if (now >= nextSweep || buckets.size >= maxKeys) {
      for (const [id, bucket] of buckets) if (bucket.until <= now) buckets.delete(id);
      nextSweep = now + Math.min(windowMs, 60000);
    }
    // Identifiers and tokens never remain as plaintext in limiter state/logs.
    const id = createHash('sha256').update(String(key(req))).digest('hex');
    let bucket = buckets.get(id);
    if (!bucket || bucket.until <= now) {
      if (!bucket && buckets.size >= maxKeys) {
        res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
        return res.status(429).json({ message: 'Too many requests. Please wait and try again.', code: 'RATE_LIMITED' });
      }
      bucket = { count: 0, until: now + windowMs }; buckets.set(id, bucket);
    }
    if (++bucket.count > limit) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((bucket.until - now) / 1000))));
      res.set('Cache-Control', 'no-store');
      return res.status(429).json({ message: 'Too many requests. Please wait and try again.', code: 'RATE_LIMITED' });
    }
    next();
  };
}
export const loginIpLimit = rateLimit({ limit: 60, windowMs: 5 * 60_000 });
export const loginAccountLimit = rateLimit({ limit: 10, windowMs: 10 * 60_000,
  key: req => `${req.ip}:${String(req.body?.identifier ?? req.body?.email ?? req.body?.phone ?? '').trim().toLowerCase().replace(/[\s()+.-]/g, '')}` });
export const refreshLimit = rateLimit({ limit: 120, windowMs: 60_000 });
export const publicVerifyLimit = rateLimit({ limit: 90, windowMs: 60_000 });
export const documentUploadLimit = rateLimit({ limit: 40, windowMs: 60_000, key: req => req.user?.id || req.ip });
