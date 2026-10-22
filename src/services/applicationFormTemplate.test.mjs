import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateApplicationTemplate, requirePublishableTemplate } from './applicationFormTemplate.js';

const template = JSON.parse(await readFile(new URL('../seeds/mount-valley-application.json', import.meta.url), 'utf8'));
const features = ['roads', 'courtyard', 'retail', 'landscape', 'lighting', 'access'].map(icon => ({ icon, title: icon, body: 'Project amenity.' }));

test('six commercial amenities retain their selected icons', () => {
  assert.deepEqual(validateApplicationTemplate({ ...template, features }).features, features);
  assert.deepEqual(validateApplicationTemplate(template).features, template.features);
});

test('amenities reject unsupported icons and more than six entries', () => {
  assert.throws(() => validateApplicationTemplate({ ...template, features: [...features, features[0]] }), /up to six/);
  assert.throws(() => validateApplicationTemplate({ ...template, features: [{ ...features[0], icon: 'unknown' }] }), /supported commercial amenity icon/);
  assert.throws(() => validateApplicationTemplate({ ...template, features: [{ ...features[0], body: 123 }] }), /Each highlight/);
});

test('commercial overview copy is optional, while the actual project name and artwork remain required', () => {
  const ready = { ...template, terms:'1. Scheme terms.', commercial_heading:'', commercial_description:'' };
  assert.doesNotThrow(() => requirePublishableTemplate(ready));
  assert.throws(() => requirePublishableTemplate({ ...ready, commercial_title:'  ' }), /Complete Commercial name before publishing/);
  assert.throws(() => requirePublishableTemplate({ ...ready, commercial_image:'' }), /Complete Commercial artwork before publishing/);
});
