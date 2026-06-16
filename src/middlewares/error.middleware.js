// Central error handler. Surfaces a useful message but never leaks stack traces to clients.
const errorMiddleware = (err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[booking-api error]', err.stack || err.message);
  const status = err.status || 500;
  res.status(status).json({ message: err.publicMessage || err.message || 'Something went wrong' });
};

export default errorMiddleware;
