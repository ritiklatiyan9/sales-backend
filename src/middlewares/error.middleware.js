// Only application-defined OCR errors can expose their prewritten setup/retry
// message on a 5xx response. Provider responses and credentials stay private.
const SAFE_OCR_ERRORS = new Set(['OCR_NOT_CONFIGURED', 'OCR_FAILED', 'OCR_PROVIDER_UNAVAILABLE', 'OCR_PROVIDER_AUTH', 'OCR_PROVIDER_BILLING', 'OCR_MODEL_UNAVAILABLE', 'OCR_TIMEOUT']);
// Expected validation errors remain useful; server/DB/provider details stay private.
const errorMiddleware = (err, req, res, next) => {
  if (res.headersSent) return next(err);
  const uploadError = err.name === 'MulterError';
  const status = uploadError ? (err.code === 'LIMIT_FILE_SIZE' ? 413 : 400)
    : Number.isInteger(err.status) && err.status >= 400 && err.status <= 599 ? err.status : 500;
  console.error('[booking-api error]', err.code || err.name || 'ERROR');
  const safeOcrError = SAFE_OCR_ERRORS.has(err.code) && typeof err.publicMessage === 'string';
  const message = err.type === 'entity.parse.failed' ? 'Request body must be valid JSON.'
    : err.type === 'entity.too.large' || err.code === 'LIMIT_FILE_SIZE' ? 'The upload or request is too large.'
    : uploadError ? 'Invalid upload. Check the file and try again.'
    : status >= 500 ? safeOcrError ? err.publicMessage : 'The service could not complete this request. Please try again.'
    : err.publicMessage || err.message || 'Invalid request';
  const payload = { message };
  if ((status < 500 || safeOcrError) && /^[A-Z][A-Z0-9_]+$/.test(String(err.code || ''))) payload.code = err.code;
  if (status < 500 && err.existing_member_id) payload.existing_member_id = err.existing_member_id;
  if (status < 500 && err.existing_member_type) payload.existing_member_type = err.existing_member_type;
  res.set('Cache-Control', 'no-store');
  res.status(status).json(payload);
};
export default errorMiddleware;
