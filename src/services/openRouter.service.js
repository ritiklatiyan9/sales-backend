/**
 * OpenRouter — the single AI provider for OCR and KYC field extraction (replaced
 * the direct Mistral + Groq integrations on 2026-10-19).
 *
 * One OpenAI-compatible request per document. `models` lists a fallback so
 * OpenRouter itself retries on the second model when the first is down or
 * rate-limited — no client-side retry loops.
 */
const fetchFn = (...args) => globalThis.fetch(...args); // looked up per call (tests swap it)

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
// Cheap, strong on printed + handwritten Indian documents (Hindi too), reads PDFs
// natively. Same model the Accounting app uses for KYC.
export const DEFAULT_OCR_MODEL = 'google/gemini-3.1-flash-lite';
export const DEFAULT_OCR_FALLBACK_MODEL = 'google/gemini-2.5-flash-lite';

const config = () => ({
  key: process.env.OPENROUTER_API_KEY,
  model: process.env.OPENROUTER_OCR_MODEL || DEFAULT_OCR_MODEL,
  fallback: process.env.OPENROUTER_OCR_FALLBACK_MODEL ?? DEFAULT_OCR_FALLBACK_MODEL,
  timeoutMs: Number(process.env.OPENROUTER_OCR_TIMEOUT_MS || 60000),
});

/** ocr_results.engine / documents.ocr_engine are varchar(40). */
export const engineLabel = (model) => `or:${String(model || '').split('/').pop()}`.slice(0, 40);

const providerError = (message, { status = 502, code = 'OCR_FAILED', publicMessage, retryAfterMs, cause } = {}) =>
  Object.assign(new Error(message, cause ? { cause } : undefined), { status, code, publicMessage, retryAfterMs });

/**
 * POST one chat completion. `content` is the user message content array.
 * Returns { content, model } or throws an error carrying status/code/publicMessage.
 */
export async function openRouterChat(content, { system, maxTokens = 1600, pdf = false } = {}) {
  const { key, model, fallback, timeoutMs } = config();
  if (!key) throw providerError('OPENROUTER_API_KEY not set — cannot run OCR', { status: 503, code: 'OCR_NOT_CONFIGURED', publicMessage: 'Document reading is not configured. Ask an administrator to set the OpenRouter key.' });
  const gemini3 = model.startsWith('google/gemini-3');
  const body = {
    model,
    ...(fallback && fallback !== model ? { models: [model, fallback] } : {}),
    temperature: 0,
    // Gemini 3 spends part of the budget on (hidden) reasoning; keep it low.
    max_tokens: gemini3 ? Math.max(maxTokens, 8192) : maxTokens,
    ...(gemini3 ? { reasoning: { effort: 'low', exclude: true } } : {}),
    ...(pdf ? { plugins: [{ id: 'file-parser', pdf: { engine: process.env.OPENROUTER_PDF_ENGINE || 'native' } }] } : {}),
    messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content }],
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchFn(OPENROUTER_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.OPENROUTER_APP_URL || 'https://dgbooking.com',
        'X-Title': process.env.OPENROUTER_APP_NAME || 'Defence Garden Booking ERP',
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw providerError(`OpenRouter request failed: ${error.message}`, { cause: error, code: 'OCR_PROVIDER_UNAVAILABLE', publicMessage: 'Document reading is temporarily unavailable. Please retry shortly.' });
  } finally { clearTimeout(timer); }

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    if ([401, 403].includes(response.status)) throw providerError('OpenRouter authentication was rejected', { status: 503, code: 'OCR_PROVIDER_AUTH', publicMessage: 'Document reading is not available because its server credentials were rejected. Ask an administrator to check the OCR configuration.' });
    if (response.status === 402) throw providerError('OpenRouter credit balance is unavailable', { status: 503, code: 'OCR_PROVIDER_BILLING', publicMessage: 'Document reading is unavailable because the OCR service needs credits. Ask an administrator to check its billing.' });
    if (response.status === 404) throw providerError('OpenRouter OCR model is unavailable', { status: 503, code: 'OCR_MODEL_UNAVAILABLE', publicMessage: 'The configured document reader is unavailable. Ask an administrator to check the OCR model setting.' });
    if (response.status === 429) {
      const retry = Number(response.headers?.get?.('retry-after'));
      throw providerError(`OpenRouter rate-limited: ${detail}`, { status: 429, code: 'OCR_RATE_LIMITED', publicMessage: 'Document reading is busy. Please retry this document shortly.',
        retryAfterMs: Math.min(60_000, Math.max(5_000, (Number.isFinite(retry) && retry > 0 ? retry : 30) * 1000)) });
    }
    throw providerError(`OpenRouter HTTP ${response.status}: ${detail}`, { publicMessage: 'Could not read this document. Try a clearer photo or scan, or type the details.' });
  }
  const data = await response.json();
  if (data.error) throw providerError(`OpenRouter: ${JSON.stringify(data.error).slice(0, 300)}`, { publicMessage: 'Could not read this document. Try a clearer photo or scan, or type the details.' });
  return { content: data.choices?.[0]?.message?.content || '', model: data.model || model };
}
