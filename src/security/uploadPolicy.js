import path from 'node:path';
const types = {
  '.jpg': ['image/jpeg'], '.jpeg': ['image/jpeg'], '.png': ['image/png'], '.webp': ['image/webp'],
  '.pdf': ['application/pdf'], '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
};
export function uploadTypeAllowed(file) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  return Boolean(types[ext] && (types[ext].includes(String(file.mimetype).toLowerCase()) || file.mimetype === 'application/octet-stream'));
}
export function validUploadBytes(file) {
  const bytes = file.buffer;
  if (!Buffer.isBuffer(bytes) || !bytes.length) return false;
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  if (ext === '.png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (ext === '.webp') return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (ext === '.pdf') return bytes.toString('ascii', 0, 5) === '%PDF-';
  // DOCX is an OOXML ZIP; parsers still perform the full document validation.
  if (ext === '.docx') return bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]));
  return false;
}
