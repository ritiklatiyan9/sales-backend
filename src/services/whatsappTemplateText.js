// Kept equivalent in booking-api and booking-ui so a rejected message is caught before upload.
const segments = new Intl.Segmenter('en', { granularity: 'grapheme' });
export const normalizeLineEndings = (body) => String(body ?? '').replace(/\r\n?/g, '\n');
export const countTemplateEmojis = (body) => Array.from(segments.segment(String(body ?? '')))
  .filter(({ segment }) => /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(segment)).length;
export function templateFormattingIssues(body) {
  const text = normalizeLineEndings(body).trim();
  const issues = [];
  if (/\n(?:[^\S\n]*\n){2,}/u.test(text)) issues.push('Use at most one blank line between paragraphs (two consecutive newline characters).');
  const count = countTemplateEmojis(text);
  if (count > 10) issues.push(`This message has ${count} emojis. Use 10 or fewer before submitting.`);
  return issues;
}
export function cleanTemplateSpacing(body) {
  return normalizeLineEndings(body).replace(/[\t ]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}
export function compiledBodyLength(body) {
  let position = 0;
  return normalizeLineEndings(body).trim().replace(/\{([a-z_]+)\}/g, () => `{{${++position}}}`).length;
}
