import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);
const upstreamDefault = 'https://sales-backend-ponq.onrender.com';
const postPaths = new Set([
  '/api/broker-mobile/auth/login',
  '/api/broker-mobile/auth/password-reset/request',
  '/api/broker-mobile/auth/password-reset/confirm',
  '/api/broker-mobile/auth/password/change',
]);
const getPaths = new Set([
  '/api/broker-mobile/status', '/api/broker-mobile/me', '/api/broker-mobile/portfolio',
]);

function permitted(method, path) {
  return method === 'POST' ? postPaths.has(path)
    : method === 'GET' && (getPaths.has(path) || /^\/api\/broker-mobile\/plots\/pr_[a-f0-9]{32}$/.test(path));
}

async function readBody(req, maximum) {
  const parts = [];
  let bytes = 0;
  for await (const part of req) {
    bytes += part.length;
    if (bytes > maximum) throw Object.assign(new Error('BODY_LIMIT'), { statusCode: 413 });
    parts.push(part);
  }
  const body = Buffer.concat(parts).toString('utf8');
  let parsed;
  try { parsed = JSON.parse(body); } catch { throw Object.assign(new Error('INVALID_JSON'), { statusCode: 400 }); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw Object.assign(new Error('INVALID_JSON'), { statusCode: 400 });
  }
  return body;
}

async function boundedResponse(response, maximum) {
  if (!response.body) return Buffer.from('{}');
  const parts = [];
  let bytes = 0;
  for await (const part of response.body) {
    bytes += part.length;
    if (bytes > maximum) throw new Error('RESPONSE_LIMIT');
    parts.push(Buffer.from(part));
  }
  return Buffer.concat(parts);
}

/** A separate, neutral origin. It cannot browse/proxy the upstream website. */
export function createBrokerGateway({
  upstreamOrigin = process.env.BROKER_UPSTREAM_ORIGIN || upstreamDefault,
  fetchImpl = globalThis.fetch,
  timeoutMs = 75000,
  maximumRequestBytes = 16384,
  maximumResponseBytes = 16 * 1024 * 1024,
} = {}) {
  const upstream = new URL(upstreamOrigin);
  if (upstream.protocol !== 'https:' || upstream.username || upstream.password
      || upstream.pathname !== '/' || upstream.search || upstream.hash) {
    throw new Error('The broker upstream must be an HTTPS origin.');
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    const reply = (status, message) => { res.statusCode = status; res.end(JSON.stringify({ message })); };
    try {
      const rawPath = req.url || '/';
      if (!rawPath.startsWith('/') || rawPath.startsWith('//') || /(?:%2e|%2f|%5c|\\|\.\.)/i.test(rawPath)) {
        return reply(404, 'Not found.');
      }
      const url = new URL(rawPath, 'http://gateway.invalid');
      if (url.search) return reply(404, 'Not found.');
      if (req.method === 'GET' && url.pathname === '/health') {
        return res.end(JSON.stringify({ status: 'ok', service: 'my-real-partners-gateway' }));
      }
      if (!permitted(req.method, url.pathname)) return reply(404, 'Not found.');
      const headers = { Accept: 'application/json', 'Accept-Encoding': 'gzip' };
      const authorization = req.headers.authorization;
      if (authorization) {
        if (typeof authorization !== 'string' || authorization.length > 4096 || !/^Bearer [A-Za-z0-9_.-]+$/.test(authorization)) {
          return reply(401, 'Please sign in again.');
        }
        headers.Authorization = authorization;
      }
      if (/(?:^|,)\s*(?:no-cache|no-store|max-age=0)\s*(?:,|$)/i.test(req.headers['cache-control'] || '')) {
        headers['Cache-Control'] = 'no-cache';
      }
      let body;
      if (req.method === 'POST') {
        if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return reply(415, 'Send a JSON request.');
        if (Number(req.headers['content-length']) > maximumRequestBytes) return reply(413, 'Request too large.');
        body = await readBody(req, maximumRequestBytes);
        headers['Content-Type'] = 'application/json';
      }
      const response = await fetchImpl(new URL(url.pathname, upstream), {
        method: req.method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
      });
      // Never forward upstream redirects, HTML, cookies or infrastructure headers.
      if (response.status < 200 || response.status >= 600 || response.status >= 300 && response.status < 400
          || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) {
        return reply(502, 'The service is temporarily unavailable. Please try again.');
      }
      let result = await boundedResponse(response, maximumResponseBytes);
      try { JSON.parse(result.toString('utf8')); } catch { return reply(502, 'The service is temporarily unavailable. Please try again.'); }
      res.statusCode = response.status;
      const retry = response.headers.get('retry-after');
      if (retry && /^[0-9]{1,5}$/.test(retry)) res.setHeader('Retry-After', retry);
      if (result.length > 2048 && /(?:^|,)\s*gzip\b/i.test(req.headers['accept-encoding'] || '')) {
        result = await gzipAsync(result, { level: 1 });
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Vary', 'Accept-Encoding');
      }
      res.end(result);
    } catch (error) {
      if (res.headersSent) return res.destroy();
      reply([400, 413].includes(error.statusCode) ? error.statusCode : 503,
        error.statusCode === 413 ? 'Request too large.' : error.statusCode === 400 ? 'Please check the request.'
          : 'The service is temporarily unavailable. Please try again.');
    }
  });
  server.requestTimeout = 100000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 60000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createBrokerGateway();
  server.listen(Number(process.env.PORT) || 8001, '0.0.0.0', () => console.log('My Real Partners gateway ready.'));
}
