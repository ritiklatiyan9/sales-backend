/**
 * In-process OCR engine — Mistral Document OCR for full KYC forms and Groq vision
 * for legacy identity-document flows:
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
import { MEMBER_TYPES } from './memberRoles.service.js';
import { runMistralDocumentOcr } from './mistralOcr.service.js';

const fetchFn = globalThis.fetch
  ? globalThis.fetch.bind(globalThis)
  : (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const GROQ_API_KEY = process.env.GROQ_API_KEY;
// Keep the vision model explicit because Groq retires model IDs independently.
// groq.service.js uses GROQ_MODEL for text-only extraction; this service requires
// a model that accepts image_url input.
const CURRENT_GROQ_VISION_MODEL = 'qwen/qwen3.6-27b';
const GROQ_VISION_MODEL = process.env.GROQ_VISION_MODEL || CURRENT_GROQ_VISION_MODEL;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_TIMEOUT_MS = Number(process.env.GROQ_TIMEOUT_MS || 45000);

export const ENGINE_NAME = 'groq-vision';
export const KYC_FORM_ENGINE_NAME = 'mistral-ocr';

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
    'member_type (the PERSON ROLE printed/stamped on this role-specific form: CLIENT, MEMBER, VENDOR, SUPERVISOR, FARMER, EMPLOYEE, BROKER, PARTNER or OTHER)',
    'name (applicant full name)', 'father_name', 'mother_name', 'spouse_name',
    'dob (DD/MM/YYYY)', 'gender', 'marital_status', 'religion', 'nationality',
    'qualification', 'occupation', 'company_name (employer / firm name)',
    'mobile (10 digits)', 'alt_phone (10 digits)', 'whatsapp (10 digits)', 'email',
    'address (correspondence address, single line, WITHOUT city/state/pincode)',
    'city', 'state', 'pincode (6 digits)',
    'aadhaar_number (12 digits)', 'pan_number (10 chars)', 'voter_id_number',
    'nominee_name', 'nominee_relation', 'nominee_phone (10 digits)',
    'nominee_id (the nominee\'s Aadhaar / ID number from the "NOMINEE ID" line)',
    'nominee_dob (DD/MM/YYYY)',
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
  spellings are common. If a handwritten value is PARTIALLY legible (e.g. an IFSC or
  account number where you can read most characters), transcribe EXACTLY the characters
  you can see and give that field a LOW field_confidence (under 0.5) — do NOT invent
  missing characters, and return "" only when nothing at all is legible.
- The TOP-RIGHT corner has a machine block with "AGENT CODE" (like AGT-7KQ2M) and
  "KYC No." — transcribe these EXACTLY as printed; they are typed, not handwritten.
- The form is generated for one person role. Read the prominent printed/stamped
  "PERSON ROLE" / "REGISTRATION ROLE" value and return it as member_type. Do not infer
  a role from occupation or other handwriting; return "" when the stamp is not legible.
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

// Mistral OCR already returns the complete document transcription in pages[].markdown.
// Asking Document Annotation to repeat it as raw_text wastes output tokens, so this
// prompt requests only the structured form fields and confidence map.
const buildMistralAnnotationPrompt = (docType) => {
  const fields = FIELDS_BY_TYPE[docType] || FIELDS_BY_TYPE.OTHER;
  return `Read the complete Indian KYC form across every page.${docType === 'KYC_FORM' ? KYC_FORM_HINTS : ''}
Return ONE JSON object with these snake_case fields at the top level: ${fields.join(', ')}.
Also return "field_confidence", an object mapping every non-empty field to a number from 0 to 1.

Rules:
- Return valid JSON only. Do not nest the extracted values under "fields".
- Never guess. Use "" when a value is missing or illegible and omit its confidence.
- Keep address as one line without city, state, or pincode; return those separately.
- Use DD/MM/YYYY for dates, exactly 6 digits for pincode, 10 digits for phones,
  12 digits for Aadhaar, and the printed value for PAN/IFSC/agent code.
- Preserve handwritten spelling exactly.`;
};

const mistralFieldDefinitions = (docType) => (
  (FIELDS_BY_TYPE[docType] || FIELDS_BY_TYPE.OTHER).map((definition) => {
    const match = String(definition).match(/^([a-z0-9_]+)(?:\s*\((.*)\))?$/i);
    return {
      name: match?.[1] || String(definition).trim(),
      description: match?.[2] || `Exact ${match?.[1] || definition} value from the form`,
    };
  })
);

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
 * Render the printable KYC form's pages to one tall PNG. One-page legacy forms
 * remain supported; all three pages of the current template are stitched vertically so
 * nothing is silently dropped. Throws a friendly error on failure.
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
    pagesToProcess: [1, 2, 3], // current large-box form is three pages
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
 * Validate/normalise extracted fields.
 *
 * Two tiers — the human reviewer is part of this pipeline:
 *   - HARD fields (aadhaar / pan / agent_code): malformed values are DROPPED. A wrong
 *     identity number or agent attribution presented as truth is worse than a blank.
 *   - SOFT fields (ifsc, pincode, phones, email, kyc_no, amounts): an imperfect read
 *     is KEPT (cleaned) and flagged in `suspect` — the UI shows it with a red
 *     low-confidence meter so the reviewer corrects it against the paper instead of
 *     wondering why the field vanished (e.g. a handwritten IFSC misread as "PUBK 1206").
 *
 * Returns { fields, dropped, suspect }.
 */
export function validateFields(fields) {
  const out = { ...fields };
  const dropped = [];
  const suspect = [];
  const drop = (k) => { dropped.push(k); delete out[k]; };
  const keepSuspect = (k, cleaned) => { suspect.push(k); out[k] = cleaned; };

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
    if (RX.pincode.test(pin)) out.pincode = pin;
    else if (pin) keepSuspect('pincode', pin); else drop('pincode');
  }
  // Phone-shaped fields: valid → normalised; partial digits → kept as suspect.
  for (const k of ['mobile', 'alt_phone', 'whatsapp', 'nominee_phone']) {
    if (out[k] === undefined) continue;
    let m = digitsOnly(out[k]);
    if (m.length === 12 && m.startsWith('91')) m = m.slice(2);
    if (RX.mobile.test(m)) out[k] = m;
    else if (m.length >= 6) keepSuspect(k, m); else drop(k);
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
    const ifsc = String(out.ifsc).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (RX.ifsc.test(ifsc)) out.ifsc = ifsc;
    else if (ifsc.length >= 4) keepSuspect('ifsc', ifsc); else drop('ifsc');
  }
  if (out.kyc_no !== undefined) {
    const digits = digitsOnly(out.kyc_no);
    if (digits) out.kyc_no = digits; else drop('kyc_no');
  }
  if (out.member_type !== undefined) {
    const memberType = String(out.member_type).trim().toUpperCase().replace(/[\s-]+/g, '_');
    if (MEMBER_TYPES.includes(memberType)) out.member_type = memberType;
    else drop('member_type');
  }
  if (out.email !== undefined) {
    const email = String(out.email).trim().toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) out.email = email;
    else if (email.length >= 4) keepSuspect('email', email); else drop('email');
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
  return { fields: out, dropped, suspect };
}

/* ── Stage: Groq vision call ──────────────────────────────────────────────── */

/**
 * Run the full pipeline on an image buffer. `mimeType` should be an image/* type.
 * `onStage(stage)` (optional) is called at 'PREPROCESS' | 'OCR' | 'VALIDATE'.
 * Returns { text, fields, confidence (0-1), confidenceMap, engine }.
 */
function extractJsonObject(content) {
  if (!content) return {};
  const trimmed = String(content).trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced ? fenced[1] : trimmed;
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try { return JSON.parse(candidate.slice(firstBrace, lastBrace + 1)); }
    catch {}
  }
  try { return JSON.parse(candidate); }
  catch { return {}; }
}

function finalizeOcrResult(raw, fallbackText, docType, engine, providerConfidence) {
  const text = String(raw.raw_text || raw.text || fallbackText || '').trim();
  const normalized = normalizeExtracted(raw, docType);
  const { fields, dropped, suspect } = validateFields(normalized);
  if (dropped.length) console.warn(`[ocr] validation dropped: ${dropped.join(', ')}`);
  if (suspect.length) console.warn(`[ocr] format-suspect (kept, low confidence): ${suspect.join(', ')}`);

  const modelConf = (raw.field_confidence && typeof raw.field_confidence === 'object') ? raw.field_confidence : {};
  const KEY_ALIASES = {
    aadhaar: ['aadhaar', 'aadhaar_number'], pan: ['pan', 'pan_number'],
    voter_id: ['voter_id', 'voter_id_number'], passport: ['passport', 'passport_number'],
    dl: ['dl', 'dl_number'], dob: ['dob', 'date_of_birth'],
    domicile_no: ['certificate_number', 'domicile_no'], income_no: ['certificate_number', 'income_no'],
    annual_income: ['annual_income', 'income'], city: ['city', 'district'],
    ifsc: ['ifsc', 'ifsc_code'], account_number: ['account_number', 'account_no'],
    nominee_id: ['nominee_id', 'nominee_aadhaar'],
  };
  const safeProviderConfidence = Number.isFinite(Number(providerConfidence))
    ? Math.min(1, Math.max(0, Number(providerConfidence)))
    : 0.9;
  const confFor = (key) => {
    if (suspect.includes(key)) return 0.35;
    const candidates = KEY_ALIASES[key] || [key];
    for (const candidate of candidates) {
      const value = Number(modelConf[candidate]);
      if (Number.isFinite(value) && value >= 0 && value <= 1) return value;
    }
    return safeProviderConfidence;
  };
  const confidenceMap = Object.fromEntries(
    Object.keys(fields).map((key) => [key, Math.round(confFor(key) * 1000) / 1000])
  );
  const values = Object.values(confidenceMap);
  const confidence = values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : (text ? (Number.isFinite(Number(providerConfidence)) ? Number(providerConfidence) : 0.5) : 0);

  console.log(`[ocr] ${engine} extracted ${Object.keys(fields).join(', ') || '(none)'} for ${docType} (conf ${confidence.toFixed(2)})`);
  return { text, fields, confidence, confidenceMap, engine: String(engine).slice(0, 64) };
}

async function runOcrPipeline(fileBuffer, mimeType, docType, onStage) {
  if (!fileBuffer?.length) throw new Error('empty file buffer');

  let mistralResult = null;
  let mistralError = null;

  // Prefer Mistral because it reads the original multi-page PDF. If it errors or
  // extracts fewer than three meaningful applicant fields, continue through the
  // Groq vision pipeline below. A sparse Mistral result is retained so it can still
  // be returned if the fallback provider is unavailable/rate-limited.
  if (docType === 'KYC_FORM') {
    onStage?.('PREPROCESS');
    onStage?.('OCR');
    try {
      const result = await runMistralDocumentOcr(
        fileBuffer,
        mimeType,
        buildMistralAnnotationPrompt(docType),
        mistralFieldDefinitions(docType)
      );
      onStage?.('VALIDATE');
      mistralResult = finalizeOcrResult(
        result.raw,
        result.text,
        docType,
        `${KYC_FORM_ENGINE_NAME}:${result.model}`,
        result.confidence
      );
      const machineOnly = new Set(['agent_code', 'kyc_no', 'member_type']);
      const meaningfulFields = Object.keys(mistralResult.fields).filter((key) => !machineOnly.has(key));
      if (meaningfulFields.length >= 3) return mistralResult;
      console.warn(`[ocr] Mistral result too sparse (${meaningfulFields.length} applicant fields); falling back to Groq`);
    } catch (error) {
      mistralError = error;
      console.warn(`[ocr] Mistral failed (${error.code || error.message}); falling back to Groq`);
    }
  }

  if (!GROQ_API_KEY) {
    if (mistralResult) return mistralResult;
    if (mistralError) throw mistralError;
    throw new Error('GROQ_API_KEY not set — cannot run OCR');
  }

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
    const { fields, dropped, suspect } = validateFields(rawFields);
    if (dropped.length) console.warn(`[ocr] validation dropped: ${dropped.join(', ')}`);
    // Typed documents carry no per-field visual uncertainty — flat medium-high score;
    // format-suspect values surface red so the reviewer corrects them. The document
    // score is the MEAN of the per-field map so an all-suspect doc reads low too.
    const confidenceMap = Object.fromEntries(Object.keys(fields).map((k) => [k, suspect.includes(k) ? 0.35 : 0.85]));
    const confVals = Object.values(confidenceMap);
    const overall = confVals.length ? confVals.reduce((a, b) => a + b, 0) / confVals.length : 0.3;
    return { text, fields, confidence: overall, confidenceMap, engine: `${ENGINE_NAME}-docx` };
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
    ? { maxEdge: docType === 'KYC_FORM' ? 4200 : 3600, quality: 88 }
    : {};
  const pre = await preprocessImage(buffer, mime && mime.startsWith('image/') ? mime : 'image/jpeg', preOpts);
  const dataUrl = `data:${pre.mimeType};base64,${pre.buffer.toString('base64')}`;

  onStage?.('OCR');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);
  const requestVision = (model) => {
    // Ask Groq only for concise structured fields to reduce completion tokens/TPM.
    const prompt = docType === 'KYC_FORM'
      ? buildMistralAnnotationPrompt(docType)
      : buildPrompt(docType);
    const payload = {
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      }],
      temperature: 0.1,
      max_tokens: docType === 'KYC_FORM' ? 1800 : 1600,
    };
    return fetchFn(GROQ_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  };

  let response;
  let responseBody = '';
  const modelUsed = GROQ_VISION_MODEL;
  try {
    // Exactly one Groq request per document. The prompt mandates JSON and the parser
    // tolerates fenced/plain output, avoiding response_format rejection + retry loops.
    response = await requestVision(modelUsed);
    if (!response.ok) {
      responseBody = await response.text();
    }
  } catch (error) {
    if (mistralResult) {
      console.warn(`[ocr] Groq fallback connection failed; using sparse Mistral result: ${error.message}`);
      return mistralResult;
    }
    const combinedError = new Error('Both Mistral and Groq OCR providers failed', { cause: error });
    combinedError.status = 502;
    combinedError.code = 'OCR_PROVIDERS_UNAVAILABLE';
    combinedError.publicMessage = 'Both OCR providers are temporarily unavailable. Please retry shortly.';
    throw combinedError;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    if (mistralResult) {
      console.warn(`[ocr] Groq fallback failed (${response.status}); using sparse Mistral result`);
      return mistralResult;
    }
    const error = new Error(`Groq fallback could not read the form (HTTP ${response.status})`);
    error.status = response.status === 429 ? 429 : 502;
    error.code = response.status === 429
      ? (docType === 'KYC_FORM' ? 'OCR_PROVIDERS_RATE_LIMITED' : 'GROQ_RATE_LIMITED')
      : 'GROQ_OCR_FAILED';
    error.publicMessage = response.status === 429
      ? (docType === 'KYC_FORM'
          ? 'Both OCR providers are temporarily rate-limited. Please retry shortly.'
          : 'OCR is temporarily rate-limited. Please retry this document shortly.')
      : 'Mistral and Groq could not read this form. Try a clearer scan.';
    if (response.status === 429) {
      const retryHeader = Number(response.headers?.get?.('retry-after'));
      const retryBody = Number(responseBody.match(/try again in\s+([\d.]+)s/i)?.[1]);
      const retrySeconds = Number.isFinite(retryHeader) && retryHeader > 0
        ? retryHeader
        : (Number.isFinite(retryBody) && retryBody > 0 ? retryBody : 30);
      error.retryAfterMs = Math.min(60_000, Math.max(5_000, Math.ceil(retrySeconds * 1000)));
    }
    throw error;
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || '';
  const raw = extractJsonObject(content);

  onStage?.('VALIDATE');
  const groqResult = finalizeOcrResult(raw, '', docType, `${ENGINE_NAME}:${modelUsed}`);
  if (mistralResult && Object.keys(mistralResult.fields).length > Object.keys(groqResult.fields).length) {
    console.warn('[ocr] Groq fallback was sparser than Mistral; keeping the better Mistral extraction');
    return mistralResult;
  }
  return groqResult;
}

// Global provider single-flight for this API process. Queue jobs, synchronous Fresh
// Form previews, retries, and any future callers all share this same chain: the next
// OCR pipeline starts only after the previous one has resolved or failed.
let ocrPipelineTail = Promise.resolve();
let ocrCooldownUntil = 0;

export function runOcr(fileBuffer, mimeType, docType, onStage) {
  const execute = async () => {
    const waitMs = Math.max(0, ocrCooldownUntil - Date.now());
    if (waitMs) {
      onStage?.('RATE_LIMIT_WAIT');
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    try {
      return await runOcrPipeline(fileBuffer, mimeType, docType, onStage);
    } catch (error) {
      if (error?.status === 429) {
        ocrCooldownUntil = Math.max(
          ocrCooldownUntil,
          Date.now() + Math.min(60_000, Math.max(5_000, Number(error.retryAfterMs) || 30_000))
        );
      }
      throw error;
    }
  };
  const current = ocrPipelineTail.then(execute, execute);
  ocrPipelineTail = current.catch(() => {});
  return current;
}
