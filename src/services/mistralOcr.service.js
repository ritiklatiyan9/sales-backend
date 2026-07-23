const fetchFn = globalThis.fetch
  ? globalThis.fetch.bind(globalThis)
  : (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const MISTRAL_OCR_URL = 'https://api.mistral.ai/v1/ocr';

const apiKey = () => String(process.env.MISTRAL_API_KEY || '').trim();
const ocrModel = () => process.env.MISTRAL_OCR_MODEL || 'mistral-ocr-latest';
const timeoutMs = () => Math.max(10_000, Number(process.env.MISTRAL_TIMEOUT_MS || 90_000));

function serviceError(message, { status = 502, code = 'MISTRAL_OCR_FAILED', cause } = {}) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.status = status;
  error.code = code;
  error.publicMessage = message;
  return error;
}

function retryAfterSeconds(response) {
  const raw = response.headers?.get?.('retry-after');
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null;
}

function providerError(response, body, operation = 'OCR') {
  if (response.status === 401 || response.status === 403) {
    return serviceError('Mistral API key was rejected. Check MISTRAL_API_KEY and restart the booking API.', {
      status: 503,
      code: 'MISTRAL_AUTH_FAILED',
    });
  }
  if (response.status === 429) {
    const wait = retryAfterSeconds(response);
    const error = serviceError(
      `Mistral ${operation} rate limit reached.${wait ? ` Retry in about ${wait} seconds.` : ' Please retry shortly.'}`,
      { status: 429, code: 'MISTRAL_RATE_LIMITED' }
    );
    error.retryAfterMs = Math.min(60_000, Math.max(5_000, (wait || 30) * 1000));
    return error;
  }
  // Log only a short, whitespace-normalised provider detail. The API response sent to
  // the browser remains stable and never exposes account/organisation diagnostics.
  const detail = String(body || '').replace(/\s+/g, ' ').slice(0, 180);
  if (detail) console.error(`[mistral-ocr] ${operation} ${response.status}: ${detail}`);
  return serviceError(`Mistral ${operation} could not process this document. Please retry.`, {
    status: 502,
    code: 'MISTRAL_OCR_FAILED',
  });
}

async function mistralFetch(url, payload, operation) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  try {
    const response = await fetchFn(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const body = await response.text();
    if (!response.ok) throw providerError(response, body, operation);
    try {
      return JSON.parse(body);
    } catch {
      throw serviceError(`Mistral ${operation} returned an unreadable response. Please retry.`, {
        status: 502,
        code: 'MISTRAL_INVALID_RESPONSE',
      });
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw serviceError(`Mistral ${operation} timed out. Please retry.`, {
        status: 504,
        code: 'MISTRAL_TIMEOUT',
        cause: error,
      });
    }
    if (error?.code && String(error.code).startsWith('MISTRAL_')) throw error;
    throw serviceError(`Could not connect to Mistral ${operation}. Please retry.`, {
      status: 502,
      code: 'MISTRAL_UNAVAILABLE',
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }
}

export function buildMistralDocument(fileBuffer, mimeType) {
  const mime = String(mimeType || 'application/octet-stream').toLowerCase();
  const isPdf = mime === 'application/pdf'
    || fileBuffer?.subarray?.(0, 5).toString('latin1') === '%PDF-';
  const resolvedMime = isPdf ? 'application/pdf' : mime;
  const dataUrl = `data:${resolvedMime};base64,${fileBuffer.toString('base64')}`;
  return resolvedMime.startsWith('image/')
    ? { type: 'image_url', image_url: dataUrl }
    : { type: 'document_url', document_url: dataUrl };
}

/**
 * Mistral document annotations require a complete JSON Schema (plain json_object is
 * rejected with API code 3050). Every field is required but may be an empty string,
 * which gives the model a deterministic shape without encouraging invented values.
 */
export function buildDocumentAnnotationFormat(fieldDefinitions) {
  const definitions = (fieldDefinitions || [])
    .filter((field) => field?.name)
    .filter((field, index, all) => all.findIndex((item) => item.name === field.name) === index);
  const fieldProperties = Object.fromEntries(definitions.map(({ name, description }) => [
    name,
    {
      type: 'string',
      description: description || `Exact ${name} value from the document; empty string when absent or illegible`,
    },
  ]));
  const confidenceProperties = Object.fromEntries(definitions.map(({ name }) => [
    name,
    { type: 'number', minimum: 0, maximum: 1 },
  ]));
  const fieldNames = definitions.map(({ name }) => name);

  return {
    type: 'json_schema',
    json_schema: {
      name: 'kyc_form_extraction',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          ...fieldProperties,
          field_confidence: {
            type: 'object',
            properties: confidenceProperties,
            required: fieldNames,
            additionalProperties: false,
          },
        },
        required: [...fieldNames, 'field_confidence'],
        additionalProperties: false,
      },
    },
  };
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (!value) return {};
  const content = String(value).trim();
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced ? fenced[1] : content;
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  try {
    return JSON.parse(first >= 0 && last > first ? candidate.slice(first, last + 1) : candidate);
  } catch {
    return {};
  }
}

function pageConfidence(page) {
  const candidates = [
    page?.confidence_scores?.average_page_confidence_score,
    page?.confidence_scores?.page_confidence,
    page?.confidence_score,
    page?.confidence,
  ];
  return candidates.map(Number).find((value) => Number.isFinite(value) && value >= 0 && value <= 1);
}

export function parseMistralOcrResponse(data) {
  const pages = Array.isArray(data?.pages) ? data.pages : [];
  const text = pages
    .map((page, index) => `--- Page ${Number(page?.index ?? index) + 1} ---\n${String(page?.markdown || '').trim()}`)
    .join('\n\n')
    .trim();
  const confidenceValues = pages.map(pageConfidence).filter(Number.isFinite);
  const confidence = confidenceValues.length
    ? confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length
    : undefined;
  const annotation = parseJsonObject(data?.document_annotation);
  const raw = annotation.fields && typeof annotation.fields === 'object'
    ? { ...annotation.fields, field_confidence: annotation.field_confidence || annotation.fields.field_confidence }
    : annotation;
  return { text, raw, confidence };
}

/**
 * One Mistral request performs both page OCR and schema-constrained field extraction.
 * If the provider cannot return annotations, the caller may sequentially fall back
 * to Groq; there is never a second Mistral chat request.
 */
export async function runMistralDocumentOcr(fileBuffer, mimeType, extractionPrompt, fieldDefinitions) {
  if (!apiKey()) {
    throw serviceError(
      'Fresh Form OCR is not configured. Add MISTRAL_API_KEY to sales-backend/.env and restart the booking API.',
      { status: 503, code: 'MISTRAL_OCR_NOT_CONFIGURED' }
    );
  }
  if (!fileBuffer?.length) {
    throw serviceError('The uploaded form is empty.', { status: 400, code: 'EMPTY_OCR_FILE' });
  }

  const payload = {
    model: ocrModel(),
    document: buildMistralDocument(fileBuffer, mimeType),
    include_image_base64: false,
    confidence_scores_granularity: 'page',
    document_annotation_format: buildDocumentAnnotationFormat(fieldDefinitions),
    document_annotation_prompt: extractionPrompt,
  };
  const data = await mistralFetch(MISTRAL_OCR_URL, payload, 'OCR');
  const parsed = parseMistralOcrResponse(data);
  if (!parsed.text) {
    throw serviceError('Mistral OCR found no readable text in this form. Try a clearer scan.', {
      status: 422,
      code: 'MISTRAL_NO_TEXT',
    });
  }
  if (!Object.keys(parsed.raw).length) {
    throw serviceError('Mistral OCR returned text but no structured KYC fields.', {
      status: 502,
      code: 'MISTRAL_NO_FIELDS',
    });
  }
  return {
    text: parsed.text,
    raw: parsed.raw,
    confidence: parsed.confidence,
    model: data?.model || ocrModel(),
  };
}
