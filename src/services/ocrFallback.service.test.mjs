import test from 'node:test';
import assert from 'node:assert/strict';

test('falls back from failed Mistral OCR to one concise Groq request', async () => {
  const previousFetch = globalThis.fetch;
  const previousMistralKey = process.env.MISTRAL_API_KEY;
  const previousGroqKey = process.env.GROQ_API_KEY;
  const calls = [];
  process.env.MISTRAL_API_KEY = 'test-mistral-key';
  process.env.GROQ_API_KEY = 'test-groq-key';

  globalThis.fetch = async (url, options) => {
    calls.push({ url, payload: JSON.parse(options.body) });
    if (url === 'https://api.mistral.ai/v1/ocr') {
      return new Response('{"message":"temporary OCR failure"}', {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === 'https://api.groq.com/openai/v1/chat/completions') {
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              name: 'Asha Sharma',
              mobile: '9876543210',
              member_type: 'CLIENT',
              field_confidence: { name: 0.91, mobile: 0.96, member_type: 0.99 },
            }),
          },
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    // An intentionally tiny invalid JPEG makes sharp take its documented
    // "use original buffer" path without affecting the provider orchestration.
    const { runOcr } = await import(`./ocr.service.js?fallback=${Date.now()}`);
    const result = await runOcr(Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg', 'KYC_FORM');
    assert.equal(calls.filter((call) => call.url.includes('mistral.ai')).length, 1);
    assert.equal(calls.filter((call) => call.url.includes('groq.com')).length, 1);
    assert.equal(calls[1].payload.response_format, undefined);
    assert.equal(calls[1].payload.max_tokens, 1800);
    assert.match(result.engine, /^groq-vision:/);
    assert.equal(result.fields.name, 'Asha Sharma');
    assert.equal(result.fields.mobile, '9876543210');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousMistralKey === undefined) delete process.env.MISTRAL_API_KEY;
    else process.env.MISTRAL_API_KEY = previousMistralKey;
    if (previousGroqKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = previousGroqKey;
  }
});
