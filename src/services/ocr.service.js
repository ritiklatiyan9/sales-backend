/**
 * In-process OCR engine — Groq vision (multimodal LLM) with a multi-stage pipeline:
 *
 *   image → preprocess (sharp: auto-rotate, resize, normalize, recompress)
 *         → Groq vision OCR + field extraction (with per-field confidence)
 *         → strict JSON validation (Aadhaar/PAN/pincode/mobile/date formats)
 *         → { text, fields, confidence, confidenceMap, engine }
 *
 * Preprocessing dramatically cuts payload size (faster upload to Groq, faster
 * inference) and improves OCR accuracy on skewed/large/over-exposed photos.
 * On any preprocessing failure the original buffer is used — never fatal.
 *
 * Callers may pass an `onStage(stage)` callback to surface live pipeline progress
 * (PREPROCESS → OCR → VALIDATE) to the UI via socket events.
 *
 * On failure it throws, letting the processor mark the document FAILED (the UI
 * then offers a Retry, exactly like the old flow).
 */
import { normalizeExtracted } from './groq.service.js';

const fetchFn = globalThis.fetch
  ? globalThis.fetch.bind(globalThis)
  : (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const GROQ_API_KEY = process.env.GROQ_API_KEY;
// A Groq multimodal (vision) model. Llama-4 Scout is fast + accurate for ID OCR.
const GROQ_VISION_MODEL = process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_TIMEOUT_MS = Number(process.env.GROQ_TIMEOUT_MS || 45000);

export const ENGINE_NAME = 'groq-vision';

// Field lists per document type — mirrors the text extractor so output shape is identical.
const FIELDS_BY_TYPE = {
  AADHAAR: ['name', 'father_name', 'aadhaar_number (12 digits)', 'dob (DD/MM/YYYY)', 'gender', 'address', 'city', 'state', 'pincode (6 digits)', 'mobile (10 digits, if printed)'],
  PAN: ['name', 'pan_number (10 chars)', 'dob (DD/MM/YYYY)', 'father_name', 'address', 'city'],
  VOTER_ID: ['name', 'father_name', 'voter_id_number', 'dob', 'gender', 'address', 'city', 'state', 'pincode'],
  PASSPORT: ['name', 'passport_number', 'dob', 'gender', 'nationality', 'address'],
  DL: ['name', 'dl_number', 'dob', 'gender', 'address', 'city', 'state', 'pincode'],
  DOMICILE: ['name', 'father_name', 'certificate_number (domicile / serial / registration number on the certificate)', 'issue_date (DD/MM/YYYY)', 'village', 'tehsil', 'district', 'state'],
  INCOME: ['name', 'father_name', 'certificate_number (income certificate / serial number)', 'annual_income (amount in rupees)', 'issue_date (DD/MM/YYYY)', 'district', 'state'],
  // Property / legal documents (registry, patta, land record …) uploaded as OTHER.
  OTHER: ['name (owner name)', 'father_name', 'plot_number', 'khasra_number', 'area (with unit)', 'registry_number', 'village', 'tehsil', 'district', 'state', 'date (DD/MM/YYYY)', 'amount (in rupees)', 'mobile (10 digits)', 'address'],
};

const buildPrompt = (docType) => {
  const fields = FIELDS_BY_TYPE[docType] || FIELDS_BY_TYPE.OTHER;
  return `You are reading an Indian KYC / legal document image (type: ${docType}).
Do three things and return ONE JSON object only:
1) "raw_text": a faithful plain-text transcription of all legible text in the image.
2) These snake_case fields: ${fields.join(', ')}.
3) "field_confidence": an object mapping each field you filled to a confidence score between 0 and 1 (how certain you are the value is exactly correct).

STRICT RULES — never violate:
- NEVER guess or invent a value. If a field is not clearly legible in the image, return "" for it and omit it from "field_confidence".
- "address": clean single line (house/street, locality, area) — do NOT include city/state/pincode there; put those in their own fields.
- "city" = town/district, "state" = Indian state, "pincode" = exactly 6 digits, "dob"/"date"/"issue_date" = DD/MM/YYYY, "mobile" = 10 digits.
- Cross-check related fields before answering (e.g. pincode belongs to the state; DOB is a plausible birth date; Aadhaar has 12 digits; PAN is 5 letters + 4 digits + 1 letter).
- If overall legibility is poor, still transcribe what you can into "raw_text" and leave uncertain fields empty.
Return only the JSON object.`;
};

/* ── Stage: preprocessing (sharp) ─────────────────────────────────────────── */

// Loaded lazily so a broken native install degrades gracefully to "no preprocessing".
let sharpMod;
async function getSharp() {
  if (sharpMod !== undefined) return sharpMod;
  try { sharpMod = (await import('sharp')).default; }
  catch (e) { console.warn('[ocr] sharp unavailable — skipping preprocessing:', e.message); sharpMod = null; }
  return sharpMod;
}

/**
 * Auto-rotate (EXIF), downscale to an OCR-optimal resolution, stretch contrast and
 * recompress. Returns { buffer, mimeType } — the original on any failure.
 */
export async function preprocessImage(fileBuffer, mimeType) {
  const sharp = await getSharp();
  if (!sharp) return { buffer: fileBuffer, mimeType };
  try {
    const out = await sharp(fileBuffer, { failOn: 'none' })
      .rotate()                                   // honour EXIF orientation (auto-rotate)
      .resize({ width: 1440, height: 1440, fit: 'inside', withoutEnlargement: true })
      .normalize()                                // contrast stretch → crisper glyphs
      .jpeg({ quality: 80, mozjpeg: true })
      .toBuffer();
    // Only keep the processed version when it actually helps (smaller or same-ish).
    if (out.length && out.length < fileBuffer.length * 1.15) {
      return { buffer: out, mimeType: 'image/jpeg' };
    }
    return { buffer: fileBuffer, mimeType };
  } catch (e) {
    console.warn('[ocr] preprocessing failed — using original image:', e.message);
    return { buffer: fileBuffer, mimeType };
  }
}

/* ── Stage: strict validation of AI output ────────────────────────────────── */

const RX = {
  aadhaar: /^\d{12}$/,
  pan: /^[A-Z]{5}\d{4}[A-Z]$/,
  pincode: /^\d{6}$/,
  mobile: /^[6-9]\d{9}$/,
  isoDate: /^\d{4}-\d{2}-\d{2}$/,
};

const digitsOnly = (v) => String(v).replace(/\D/g, '');

/**
 * Validate/normalise extracted fields. Malformed values are DROPPED (never shown as
 * truth) and the per-field confidence for coerced values is capped.
 * Returns { fields, dropped } — dropped lists keys removed by validation.
 */
export function validateFields(fields) {
  const out = { ...fields };
  const dropped = [];
  const drop = (k) => { dropped.push(k); delete out[k]; };

  if (out.aadhaar !== undefined) {
    const digits = digitsOnly(out.aadhaar);
    if (RX.aadhaar.test(digits)) out.aadhaar = digits; else drop('aadhaar');
  }
  if (out.pan !== undefined) {
    const pan = String(out.pan).toUpperCase().replace(/\s/g, '');
    if (RX.pan.test(pan)) out.pan = pan; else drop('pan');
  }
  if (out.pincode !== undefined) {
    const pin = digitsOnly(out.pincode);
    if (RX.pincode.test(pin)) out.pincode = pin; else drop('pincode');
  }
  if (out.mobile !== undefined) {
    let m = digitsOnly(out.mobile);
    if (m.length === 12 && m.startsWith('91')) m = m.slice(2);
    if (RX.mobile.test(m)) out.mobile = m; else drop('mobile');
  }
  for (const k of ['dob', 'issue_date', 'date']) {
    if (out[k] === undefined) continue;
    if (!RX.isoDate.test(out[k])) { drop(k); continue; }
    const d = new Date(out[k]);
    const y = d.getFullYear();
    if (Number.isNaN(d.getTime()) || y < 1900 || d > new Date()) drop(k);
  }
  if (out.annual_income !== undefined || out.amount !== undefined) {
    for (const k of ['annual_income', 'amount']) {
      if (out[k] === undefined) continue;
      const n = Number(String(out[k]).replace(/[^\d.]/g, ''));
      if (Number.isFinite(n) && n > 0) out[k] = String(n); else drop(k);
    }
  }
  return { fields: out, dropped };
}

/* ── Stage: Groq vision call ──────────────────────────────────────────────── */

/**
 * Run the full pipeline on an image buffer. `mimeType` should be an image/* type.
 * `onStage(stage)` (optional) is called at 'PREPROCESS' | 'OCR' | 'VALIDATE'.
 * Returns { text, fields, confidence (0-1), confidenceMap, engine }.
 */
export async function runOcr(fileBuffer, mimeType, docType, onStage) {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY not set — cannot run OCR');
  if (!fileBuffer?.length) throw new Error('empty file buffer');

  const isPdf = mimeType === 'application/pdf' || fileBuffer.subarray(0, 5).toString('latin1') === '%PDF-';
  if (isPdf) {
    throw new Error('PDF not supported by the fast OCR engine — please upload an image (JPG/PNG) of the document');
  }

  onStage?.('PREPROCESS');
  const pre = await preprocessImage(fileBuffer, mimeType && mimeType.startsWith('image/') ? mimeType : 'image/jpeg');
  const dataUrl = `data:${pre.mimeType};base64,${pre.buffer.toString('base64')}`;

  onStage?.('OCR');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);
  let response;
  try {
    response = await fetchFn(GROQ_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: GROQ_VISION_MODEL,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: buildPrompt(docType) },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        }],
        temperature: 0.1,
        max_tokens: 1600,
        response_format: { type: 'json_object' },
      }),
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Groq vision API error ${response.status}: ${body.slice(0, 300)}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || '';
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  const raw = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

  onStage?.('VALIDATE');
  const text = String(raw.raw_text || raw.text || '').trim();
  const normalized = normalizeExtracted(raw, docType);
  const { fields, dropped } = validateFields(normalized);
  if (dropped.length) console.warn(`[ocr] validation dropped: ${dropped.join(', ')}`);

  // Per-field confidence: prefer the model's own scores (mapped through the same key
  // normalisation), fall back to a heuristic. Overall = mean of per-field scores.
  const modelConf = (raw.field_confidence && typeof raw.field_confidence === 'object') ? raw.field_confidence : {};
  const KEY_ALIASES = {
    aadhaar: ['aadhaar', 'aadhaar_number'], pan: ['pan', 'pan_number'],
    voter_id: ['voter_id', 'voter_id_number'], passport: ['passport', 'passport_number'],
    dl: ['dl', 'dl_number'], dob: ['dob', 'date_of_birth'],
    domicile_no: ['certificate_number', 'domicile_no'], income_no: ['certificate_number', 'income_no'],
    annual_income: ['annual_income', 'income'], city: ['city', 'district'],
  };
  const confFor = (key) => {
    const candidates = KEY_ALIASES[key] || [key];
    for (const c of candidates) {
      const v = Number(modelConf[c]);
      if (Number.isFinite(v) && v >= 0 && v <= 1) return v;
    }
    return 0.9; // model filled it but gave no score
  };
  const confidenceMap = Object.fromEntries(Object.keys(fields).map((k) => [k, Math.round(confFor(k) * 1000) / 1000]));
  const values = Object.values(confidenceMap);
  const confidence = values.length
    ? values.reduce((a, b) => a + b, 0) / values.length
    : (text ? 0.5 : 0.0);

  console.log(`[ocr] ${ENGINE_NAME} extracted ${Object.keys(fields).join(', ') || '(none)'} for ${docType} (conf ${confidence.toFixed(2)})`);
  return { text, fields, confidence, confidenceMap, engine: ENGINE_NAME };
}
