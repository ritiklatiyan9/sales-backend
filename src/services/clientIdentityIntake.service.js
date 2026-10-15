import crypto from 'node:crypto';
import { runOcr } from './ocr.service.js';
import { requireSiteAccess } from './bookingWorkspaceAccess.js';

const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
const FIELD_MAP = {
  name: 'full_name', father_name: 'father_name', dob: 'date_of_birth', gender: 'gender',
  mobile: 'phone', aadhaar: 'aadhar_no', pan: 'pan_no', address: 'address',
  city: 'city', state: 'state', pincode: 'pincode',
};

export function identityMemberFields(fields = {}, confidence = {}) {
  const member_fields = {}, confidence_map = {};
  for (const [key, target] of Object.entries(FIELD_MAP)) {
    if (typeof fields[key] !== 'string' && typeof fields[key] !== 'number') continue;
    let value = String(fields[key]).trim().slice(0, key === 'address' ? 1000 : 200);
    if (key === 'aadhaar') { value = value.replace(/[\s-]/g, ''); if (!/^\d{12}$/.test(value)) continue; }
    if (key === 'pan') { value = value.replace(/\s/g, '').toUpperCase(); if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(value)) continue; }
    if (key === 'mobile') {
      value = value.replace(/[\s()+.-]/g, '');
      if (/^(91|0)[6-9]\d{9}$/.test(value)) value = value.slice(-10);
      if (!/^[6-9]\d{9}$/.test(value)) continue;
    }
    if (key === 'pincode' && !/^\d{6}$/.test(value)) continue;
    if (key === 'gender') { value = value.toUpperCase(); if (!['MALE', 'FEMALE', 'OTHER'].includes(value)) continue; }
    if (key === 'dob') {
      const match = value.match(/^(\d{2})[/.-](\d{2})[/.-](\d{4})$/);
      if (match) value = `${match[3]}-${match[2]}-${match[1]}`;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) continue;
      const date = new Date(`${value}T00:00:00Z`);
      if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) continue;
    }
    if (!value) continue;
    member_fields[target] = value;
    const score = Number(confidence[key]);
    if (Number.isFinite(score) && score >= 0 && score <= 1) confidence_map[target] = score;
  }
  return { member_fields, confidence_map };
}

function fileIdentity(file, type) {
  if (!['AADHAAR', 'PAN'].includes(type)) fail('Choose Aadhaar or PAN for document reading');
  if (!file?.buffer?.length) fail('Attach an Aadhaar or PAN document first');
  if (file.buffer.length > 10 * 1024 * 1024) fail('Each identity document must be 10 MB or smaller');
  const bytes = file.buffer;
  const mime = bytes.subarray(0, 5).toString() === '%PDF-' ? 'application/pdf'
    : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? 'image/jpeg'
      : bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
        : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : null;
  if (!mime) fail('Use a valid PDF, JPG, PNG or WebP identity document');
  return { hash: crypto.createHash('sha256').update(bytes).digest('hex'), mime };
}

/** Scoped, short-lived results avoid running paid OCR twice for preview + KYC save.
 * Only the server may supply a cached result to the background KYC processor. */
export function createClientIdentityIntake({ ocr = runOcr, authorize = requireSiteAccess, now = Date.now } = {}) {
  const results = new Map(), pending = new Map();
  const ttl = 10 * 60_000, capacity = 128;
  const scope = (user, siteId, type, hash) => `${user.id}:${Number(siteId)}:${type}:${hash}`;
  function prune() {
    for (const [key, entry] of results) if (entry.expires <= now()) results.delete(key);
    while (results.size > capacity) results.delete(results.keys().next().value);
  }
  return {
    async preview({ user, siteId, type, file }) {
      await authorize(user, siteId);
      const { hash, mime } = fileIdentity(file, type);
      const identity = scope(user, siteId, type, hash);
      prune();
      const cached = [...results.values()].find(entry => entry.identity === identity);
      if (cached) return cached.response;
      if (pending.has(identity)) return pending.get(identity);
      if (pending.size >= 16) throw Object.assign(new Error('Document reading is busy. Try again shortly.'), { status: 429 });
      const task = (async () => {
        const result = await ocr(file.buffer, mime, type);
        const preview_key = crypto.randomBytes(24).toString('hex');
        const response = { preview_key, type, ...identityMemberFields(result.fields, result.confidenceMap), needs_review: true };
        results.set(preview_key, { identity, response, result, expires: now() + ttl });
        prune(); return response;
      })();
      pending.set(identity, task);
      try { return await task; } finally { pending.delete(identity); }
    },
    cachedResult({ user, siteId, type, file, previewKey }) {
      if (!previewKey || !['AADHAAR','PAN'].includes(type)) return null;
      prune();
      const entry = results.get(String(previewKey));
      if (!entry) return null;
      const { hash } = fileIdentity(file, type);
      return entry.identity === scope(user, siteId, type, hash) ? entry.result : null;
    },
  };
}

export const clientIdentityIntake = createClientIdentityIntake();
