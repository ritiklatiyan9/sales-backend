/**
 * In-process OCR engine — Groq vision (multimodal LLM).
 *
 * Replaces the old Tesseract + Celery worker: a single Groq vision call reads the
 * document image AND extracts structured KYC fields in one shot, so booking-api needs
 * no Python, no system binaries (Tesseract/poppler) and no separate worker service.
 * Groq's inference is extremely fast, so a typical ID image resolves in ~1 second.
 *
 * Returns { text, fields, confidence, confidenceMap, engine }. On any failure it throws,
 * letting the processor mark the document FAILED (the UI then offers a Retry, exactly
 * like the old flow).
 */
import { normalizeExtracted } from './groq.service.js';

const fetchFn = globalThis.fetch
  ? globalThis.fetch.bind(globalThis)
  : (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const GROQ_API_KEY = process.env.GROQ_API_KEY;
// A Groq multimodal (vision) model. Llama-4 Scout is fast + accurate for ID OCR.
const GROQ_VISION_MODEL = process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

export const ENGINE_NAME = 'groq-vision';

// Field lists per document type — mirrors the text extractor so output shape is identical.
const FIELDS_BY_TYPE = {
  AADHAAR: ['name', 'aadhaar_number (12 digits)', 'dob (DD/MM/YYYY)', 'gender', 'address', 'city', 'state', 'pincode (6 digits)'],
  PAN: ['name', 'pan_number (10 chars)', 'dob (DD/MM/YYYY)', 'father_name', 'address', 'city'],
  VOTER_ID: ['name', 'voter_id_number', 'dob', 'gender', 'address', 'city', 'state', 'pincode'],
  PASSPORT: ['name', 'passport_number', 'dob', 'gender', 'nationality', 'address'],
  DL: ['name', 'dl_number', 'dob', 'gender', 'address', 'city', 'state', 'pincode'],
  DOMICILE: ['name', 'certificate_number (domicile / serial / registration number on the certificate)', 'issue_date (DD/MM/YYYY)', 'district', 'state'],
  INCOME: ['name', 'certificate_number (income certificate / serial number)', 'annual_income (amount in rupees)', 'issue_date (DD/MM/YYYY)', 'district', 'state'],
};

const buildPrompt = (docType) => {
  const fields = FIELDS_BY_TYPE[docType] || ['name', 'dob', 'address'];
  return `You are reading an Indian KYC identity document image (type: ${docType}).
Do two things and return ONE JSON object only:
1) "raw_text": a faithful plain-text transcription of all legible text in the image.
2) These snake_case fields (use "" when not confidently readable): ${fields.join(', ')}.

Rules:
- "address": clean single line (house/street, locality, area) — do NOT include city/state/pincode there; put those in their own fields.
- "city" = town/district, "state" = Indian state, "pincode" = 6 digits only, "dob" = DD/MM/YYYY.
- Do not invent values not supported by the image.
Return only the JSON object.`;
};

/**
 * Run OCR + extraction on an image buffer. `mimeType` should be an image/* type.
 * Returns { text, fields, confidence (0-1), confidenceMap, engine }.
 */
export async function runOcr(fileBuffer, mimeType, docType) {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY not set — cannot run OCR');
  if (!fileBuffer?.length) throw new Error('empty file buffer');

  const isPdf = mimeType === 'application/pdf' || fileBuffer.subarray(0, 5).toString('latin1') === '%PDF-';
  if (isPdf) {
    throw new Error('PDF not supported by the fast OCR engine — please upload an image (JPG/PNG) of the document');
  }

  const mediaType = mimeType && mimeType.startsWith('image/') ? mimeType : 'image/jpeg';
  const dataUrl = `data:${mediaType};base64,${fileBuffer.toString('base64')}`;

  const response = await fetchFn(GROQ_URL, {
    method: 'POST',
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
      max_tokens: 1200,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Groq vision API error ${response.status}: ${body.slice(0, 300)}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || '';
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  const raw = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

  const text = String(raw.raw_text || raw.text || '').trim();
  const fields = normalizeExtracted(raw, docType);

  // Vision models don't return a numeric OCR confidence; use a heuristic: high when we
  // got fields, lower when only text came back. Per-field map mirrors the old shape.
  const confidence = Object.keys(fields).length ? 0.92 : (text ? 0.6 : 0.0);
  const confidenceMap = Object.fromEntries(Object.keys(fields).map((k) => [k, confidence]));

  console.log(`[ocr] ${ENGINE_NAME} extracted ${Object.keys(fields).join(', ') || '(none)'} for ${docType}`);
  return { text, fields, confidence, confidenceMap, engine: ENGINE_NAME };
}
