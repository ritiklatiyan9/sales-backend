import test from 'node:test';
import assert from 'node:assert/strict';

test('serializes concurrent OCR callers so only one provider request is active', async () => {
  const previousFetch = globalThis.fetch;
  const previousGroqKey = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = 'test-groq-key';
  let activeRequests = 0;
  let maximumActiveRequests = 0;
  let requestCount = 0;

  globalThis.fetch = async () => {
    requestCount += 1;
    activeRequests += 1;
    maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
    await new Promise((resolve) => setTimeout(resolve, 15));
    activeRequests -= 1;
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            name: 'Test User',
            aadhaar_number: '123412341234',
            field_confidence: { name: 0.9, aadhaar_number: 0.9 },
          }),
        },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const { runOcr } = await import(`./ocr.service.js?singleflight=${Date.now()}`);
    const image = Buffer.from([0xff, 0xd8, 0xff]);
    const [first, second] = await Promise.all([
      runOcr(image, 'image/jpeg', 'AADHAAR'),
      runOcr(image, 'image/jpeg', 'AADHAAR'),
    ]);
    assert.equal(requestCount, 2);
    assert.equal(maximumActiveRequests, 1);
    assert.equal(first.fields.name, 'Test User');
    assert.equal(second.fields.name, 'Test User');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousGroqKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = previousGroqKey;
  }
});
