import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDocumentAnnotationFormat,
  buildMistralDocument,
  parseMistralOcrResponse,
  runMistralDocumentOcr,
} from './mistralOcr.service.js';

test('passes an original PDF to Mistral as a document data URL', () => {
  const pdf = Buffer.from('%PDF-1.7 fake two page form');
  const document = buildMistralDocument(pdf, 'application/octet-stream');
  assert.equal(document.type, 'document_url');
  assert.match(document.document_url, /^data:application\/pdf;base64,/);
  assert.equal(Buffer.from(document.document_url.split(',')[1], 'base64').toString(), pdf.toString());
});

test('passes photos as image data URLs', () => {
  const image = Buffer.from([0xff, 0xd8, 0xff]);
  const document = buildMistralDocument(image, 'image/jpeg');
  assert.deepEqual(Object.keys(document).sort(), ['image_url', 'type']);
  assert.match(document.image_url, /^data:image\/jpeg;base64,/);
});

test('builds the explicit strict schema required by Mistral annotations', () => {
  const format = buildDocumentAnnotationFormat([
    { name: 'name', description: 'Applicant name' },
    { name: 'mobile', description: 'Ten-digit phone' },
  ]);
  assert.equal(format.type, 'json_schema');
  assert.equal(format.json_schema.strict, true);
  assert.deepEqual(format.json_schema.schema.required, ['name', 'mobile', 'field_confidence']);
  assert.equal(format.json_schema.schema.properties.name.type, 'string');
  assert.equal(format.json_schema.schema.properties.field_confidence.properties.mobile.type, 'number');
  assert.equal(format.json_schema.schema.additionalProperties, false);
});

test('combines every OCR page and parses the document annotation', () => {
  const parsed = parseMistralOcrResponse({
    pages: [
      { index: 0, markdown: 'First page', confidence_scores: { average_page_confidence_score: 0.8 } },
      { index: 1, markdown: 'Second page', confidence_scores: { average_page_confidence_score: 1 } },
    ],
    document_annotation: '{"name":"Asha","member_type":"CLIENT"}',
  });
  assert.match(parsed.text, /First page[\s\S]*Second page/);
  assert.deepEqual(parsed.raw, { name: 'Asha', member_type: 'CLIENT' });
  assert.equal(parsed.confidence, 0.9);
});

test('returns a typed configuration error when the Mistral key is absent', async () => {
  const previous = process.env.MISTRAL_API_KEY;
  delete process.env.MISTRAL_API_KEY;
  await assert.rejects(
    runMistralDocumentOcr(Buffer.from('%PDF-'), 'application/pdf', 'Return JSON'),
    (error) => error.status === 503 && error.code === 'MISTRAL_OCR_NOT_CONFIGURED'
  );
  if (previous === undefined) delete process.env.MISTRAL_API_KEY;
  else process.env.MISTRAL_API_KEY = previous;
});

test('uses one schema-annotated Mistral request for OCR and fields', async () => {
  const previousKey = process.env.MISTRAL_API_KEY;
  const previousFetch = globalThis.fetch;
  const requests = [];
  process.env.MISTRAL_API_KEY = 'test-only-key';
  globalThis.fetch = async (url, options) => {
    const request = { url, options, payload: JSON.parse(options.body) };
    requests.push(request);
    const response = {
      model: 'mistral-ocr-2505',
      pages: [
        { index: 0, markdown: 'Page one content' },
        { index: 1, markdown: 'Page two content' },
      ],
      document_annotation: JSON.stringify({
        name: 'Asha',
        member_type: 'CLIENT',
        field_confidence: { name: 0.97, member_type: 0.99 },
      }),
    };
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    // Cache-bust so this module instance captures the mocked fetch implementation.
    const service = await import(`./mistralOcr.service.js?mock=${Date.now()}`);
    const result = await service.runMistralDocumentOcr(
      Buffer.from('%PDF-1.7 two pages'),
      'application/pdf',
      'Return one JSON object',
      [
        { name: 'name', description: 'Applicant name' },
        { name: 'member_type', description: 'Applicant role' },
      ]
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://api.mistral.ai/v1/ocr');
    assert.equal(requests[0].payload.model, 'mistral-ocr-latest');
    assert.equal(requests[0].payload.document.type, 'document_url');
    assert.equal(requests[0].payload.document_annotation_format.type, 'json_schema');
    assert.equal(requests[0].payload.document_annotation_format.json_schema.schema.properties.name.type, 'string');
    assert.match(result.text, /Page one content[\s\S]*Page two content/);
    assert.equal(result.raw.name, 'Asha');
    assert.equal(result.model, 'mistral-ocr-2505');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.MISTRAL_API_KEY;
    else process.env.MISTRAL_API_KEY = previousKey;
  }
});
