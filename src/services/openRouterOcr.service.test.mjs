import test from 'node:test';
import assert from 'node:assert/strict';

const reply = (content, status = 200, headers = {}) => new Response(
  status === 200 ? JSON.stringify({ model: 'google/gemini-3.1-flash-lite', choices: [{ message: { content } }] }) : 'busy',
  { status, headers: { 'content-type': 'application/json', ...headers } },
);

test('OCR goes to OpenRouter only: one request, fallback model, native PDF, clear errors', async () => {
  const previousFetch = globalThis.fetch, previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
  const calls = [];
  let next = () => reply(JSON.stringify({ raw_text: 'GOVERNMENT OF INDIA', name: 'Asha Devi', aadhaar_number: '2345 6789 0123', field_confidence: { name: 0.95 } }));
  globalThis.fetch = async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return next(); };
  try {
    const { runOcr } = await import(`./ocr.service.js?openrouter=${Date.now()}`);

    const image = await runOcr(Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg', 'AADHAAR');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.deepEqual(calls[0].body.models, ['google/gemini-3.1-flash-lite', 'google/gemini-2.5-flash-lite']);
    assert.equal(calls[0].body.messages[0].content[1].type, 'image_url');
    assert.equal(image.fields.name, 'Asha Devi');
    assert.equal(image.engine, 'or:gemini-3.1-flash-lite');
    assert.ok(image.engine.length <= 40, 'fits documents.ocr_engine');

    await runOcr(Buffer.from('%PDF-1.7 test'), 'application/pdf', 'KYC_FORM');
    const pdf = calls[1].body;
    assert.equal(pdf.messages[0].content[1].type, 'file', 'PDF is sent whole, every page');
    assert.deepEqual(pdf.plugins, [{ id: 'file-parser', pdf: { engine: 'native' } }]);

    next = () => reply('', 429, { 'retry-after': '7' });
    await assert.rejects(runOcr(Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg', 'PAN'),
      (e) => e.status === 429 && e.retryAfterMs === 7000 && !/Mistral|Groq/.test(e.publicMessage));
    assert.ok(calls.every((c) => c.url.startsWith('https://openrouter.ai/')), 'no Mistral or Groq calls');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = previousKey;
  }
});
