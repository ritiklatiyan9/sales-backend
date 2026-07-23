// Central error handler. Surfaces a useful message but never leaks stack traces to clients.
const errorMiddleware = (err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[booking-api error]', err.stack || err.message);
  const status = err.status || 500;
  const payload = { message: err.publicMessage || err.message || 'Something went wrong' };
  // Application error codes are safe/stable for the UI; PostgreSQL's numeric codes
  // and internal details are intentionally not exposed.
  if (/^[A-Z][A-Z0-9_]+$/.test(String(err.code || ''))) payload.code = err.code;
  if (err.existing_member_id) payload.existing_member_id = err.existing_member_id;
  if (err.existing_member_type) payload.existing_member_type = err.existing_member_type;
  res.status(status).json(payload);
};

export default errorMiddleware;
