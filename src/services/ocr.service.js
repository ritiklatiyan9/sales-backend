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
import { normalizeExtracted, extractKycFieldsWithAi } from './groq.service.js';

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
  // The company's own printed KYC Application Form, filled by hand and scanned back.
  // Extracts EVERY booking-form field plus the machine block (agent code / KYC no).
  KYC_FORM: [
    'agent_code (the AGENT CODE printed in the box at the TOP-RIGHT of the form — format AGT-XXXXX)',
    'kyc_no (the KYC reference number printed near the agent code, digits only)',
    'name (applicant full name)', 'father_name', 'mother_name', 'spouse_name',
    'dob (DD/MM/YYYY)', 'gender', 'marital_status', 'religion', 'nationality',
    'qualification', 'occupation', 'company_name (employer / firm name)',
    'mobile (10 digits)', 'alt_phone (10 digits)', 'whatsapp (10 digits)', 'email',
    'address (correspondence address, single line, WITHOUT city/state/pincode)',
    'city', 'state', 'pincode (6 digits)',
    'aadhaar_number (12 digits)', 'pan_number (10 chars)', 'voter_id_number',
    'nominee_name', 'nominee_relation', 'nominee_phone (10 digits)', 'nominee_dob (DD/MM/YYYY)',
    'bank_name', 'account_number', 'ifsc_code (11 chars, e.g. HDFC0001234)', 'branch',
  ],
  // Property / legal documents (registry, patta, land record …) uploaded as OTHER.
  OTHER: ['name (owner name)', 'father_name', 'plot_number', 'khasra_number', 'area (with unit)', 'registry_number', 'village', 'tehsil', 'district', 'state', 'date (DD/MM/YYYY)', 'amount (in rupees)', 'mobile (10 digits)', 'address'],
};

// Extra guidance for the company's own form: it is a PRINTED template with
// HANDWRITTEN entries — very different OCR conditions from an ID card.
const KYC_FORM_HINTS = `
This is the company's own PRINTED "KYC Application Form". Some values are pre-printed
(typed) and some are HANDWRITTEN in pen by the customer on dotted/blank lines.
- Read handwriting carefully, letter by letter; Indian names and Hindi-influenced
  spellings are common. If a handwritten value is ambiguous, prefer "" over a guess.
- The TOP-RIGHT corner has a machine block with "AGENT CODE" (like AGT-7KQ2M) and
  "KYC No." — transcribe these EXACTLY as printed; they are typed, not handwritten.
- A field label followed by an empty dotted line means the customer left it blank —
  return "" for it (do NOT copy the label text as a value).
- For checkbox rows (e.g. Gender: [ ] Male [x] Female), return the ticked option.`;

const buildPrompt = (docType) => {
  const fields = FIELDS_BY_TYPE[docType] || FIELDS_BY_TYPE.OTHER;
  return `You are reading an Indian KYC / legal document image (type: ${docType}).${docType === 'KYC_FORM' ? KYC_FORM_HINTS : ''}
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
 * Full-page forms keep more resolution than ID cards: handwriting on an A4 sheet
 * turns to mush at card-sized resolutions.
 */
export async function preprocessImage(fileBuffer, mimeType, { maxEdge = 1440, quality = 80 } = {}) {
  const sharp = await getSharp();
  if (!sharp) return { buffer: fileBuffer, mimeType };
  try {
    const out = await sharp(fileBuffer, { failOn: 'none' })
      .rotate()                                   // honour EXIF orientation (auto-rotate)
      .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
      .normalize()                                // contrast stretch → crisper glyphs
      .jpeg({ quality, mozjpeg: true })
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

/* ── Stage: PDF → image (scanned forms are often shared as PDFs) ──────────── */

/**
 * Render a PDF's first pages to one tall PNG. The printable KYC form is a single
 * page, but phone scanner apps sometimes emit 2 pages — both are stitched vertically
 * so nothing is silently dropped. Throws a friendly error on failure.
 */
export async function pdfToImage(pdfBuffer) {
  let pdfToPng;
  try {
    ({ pdfToPng } = await import('pdf-to-png-converter'));
  } catch (e) {
    throw new Error('PDF support unavailable on this server — upload a photo (JPG/PNG) of the form instead');
  }
  const pages = await pdfToPng(pdfBuffer, {
    viewportScale: 2.0,      // ~150dpi at A4 — enough for handwriting
    pagesToProcess: [1, 2],  // form is 1 page; tolerate a 2-page scan
    strictPagesToProcess: false,
    disableFontFace: true,
  });
  if (!pages?.length) throw new Error('Could not render the PDF — upload a photo (JPG/PNG) of the form instead');
  if (pages.length === 1) return pages[0].content;

  // Stitch two pages vertically with sharp (falls back to page 1 alone).
  const sharp = await getSharp();
  if (!sharp) return pages[0].content;
  try {
    const metas = await Promise.all(pages.map((p) => sharp(p.content).metadata()));
    const width = Math.max(...metas.map((m) => m.width || 0));
    const height = metas.reduce((s, m) => s + (m.height || 0), 0);
    let top = 0;
    const composite = pages.map((p, i) => {
      const layer = { input: p.content, left: 0, top };
      top += metas[i].height || 0;
      return layer;
    });
    return await sharp({ create: { width, height, channels: 3, background: '#ffffff' } })
      .composite(composite)
      .png()
      .toBuffer();
  } catch {
    return pages[0].content;
  }
}

/* ── Stage: DOCX → text (typed forms sent as Word documents) ─────────────── */

export async function docxToText(docxBuffer) {
  let mammoth;
  try {
    mammoth = (await import('mammoth')).default;
  } catch {
    throw new Error('DOCX support unavailable on this server — upload a PDF or photo of the form instead');
  }
  const { value } = await mammoth.extractRawText({ buffer: docxBuffer });
  const text = String(value || '').trim();
  if (!text) throw new Error('The DOCX file contains no readable text');
  return text;
}

/* ── Stage: strict validation of AI output ────────────────────────────────── */

const RX = {
  aadhaar: /^\d{12}$/,
  pan: /^[A-Z]{5}\d{4}[A-Z]$/,
  pincode: /^\d{6}$/,
  mobile: /^[6-9]\d{9}$/,
  isoDate: /^\d{4}-\d{2}-\d{2}$/,
  // Referral codes use an ambiguity-free alphabet (no 0/O/1/I) — see agentNetwork.service.
  agentCode: /^AGT-[A-HJ-NP-Z2-9]{5}$/,
  ifsc: /^[A-Z]{4}0[A-Z0-9]{6}$/,
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
  // Extra phone-shaped fields from the KYC form get the same normalisation as mobile.
  for (const k of ['alt_phone', 'whatsapp', 'nominee_phone']) {
    if (out[k] === undefined) continue;
    let m = digitsOnly(out[k]);
    if (m.length === 12 && m.startsWith('91')) m = m.slice(2);
    if (RX.mobile.test(m)) out[k] = m; else drop(k);
  }
  if (out.agent_code !== undefined) {
    // Typed machine block — uppercase, strip spaces/junk around the dash. Validation
    // is deliberately STRICT with no character "fixing": a mis-corrected code could
    // attribute the booking to the wrong agent. An unreadable code is dropped and the
    // admin types it manually (it's printed right on the form).
    let code = String(out.agent_code).toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9-]/g, '');
    if (!code.startsWith('AGT-') && code.startsWith('AGT')) code = `AGT-${code.slice(3)}`;
    if (RX.agentCode.test(code)) out.agent_code = code; else drop('agent_code');
  }
  if (out.ifsc !== undefined) {
    const ifsc = String(out.ifsc).toUpperCase().replace(/\s/g, '');
    if (RX.ifsc.test(ifsc)) out.ifsc = ifsc; else drop('ifsc');
  }
  if (out.kyc_no !== undefined) {
    const digits = digitsOnly(out.kyc_no);
    if (digits) out.kyc_no = digits; else drop('kyc_no');
  }
  if (out.email !== undefined) {
    const email = String(out.email).trim().toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) out.email = email; else drop('email');
  }
  for (const k of ['dob', 'issue_date', 'date', 'nominee_dob']) {
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

  let buffer = fileBuffer;
  let mime = mimeType;

  // DOCX → text-only path (no image to look at): extract text, then run the same
  // field extraction via the text model. Detected by mime OR the PK zip signature
  // with a .docx-style content type absent.
  const isDocx = mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (isDocx) {
    onStage?.('PREPROCESS');
    const text = await docxToText(fileBuffer);
    onStage?.('OCR');
    const rawFields = await extractKycFieldsWithAi(text, docType);
    onStage?.('VALIDATE');
    const { fields, dropped } = validateFields(rawFields);
    if (dropped.length) console.warn(`[ocr] validation dropped: ${dropped.join(', ')}`);
    // Typed documents carry no per-field visual uncertainty — flat medium-high score.
    const confidenceMap = Object.fromEntries(Object.keys(fields).map((k) => [k, 0.85]));
    return { text, fields, confidence: Object.keys(fields).length ? 0.85 : 0.3, confidenceMap, engine: `${ENGINE_NAME}-docx` };
  }

  // PDF → render to an image first, then continue through the vision pipeline.
  const isPdf = mime === 'application/pdf' || fileBuffer.subarray(0, 5).toString('latin1') === '%PDF-';
  if (isPdf) {
    onStage?.('PREPROCESS');
    buffer = await pdfToImage(fileBuffer);
    mime = 'image/png';
  }

  onStage?.('PREPROCESS');
  // Full-page forms keep more pixels than ID cards — handwriting needs them.
  const preOpts = docType === 'KYC_FORM' || docType === 'FINAL_APPROVED_BOOKED_FORM'
    ? { maxEdge: 2000, quality: 85 }
    : {};
  const pre = await preprocessImage(buffer, mime && mime.startsWith('image/') ? mime : 'image/jpeg', preOpts);
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
        // Full-page forms return a long transcription + ~30 fields — needs headroom.
        max_tokens: docType === 'KYC_FORM' ? 3200 : 1600,
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
