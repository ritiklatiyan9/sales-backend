import { currentStaffSession } from '../services/staffSession.js';

const authMiddleware = async (req, res, next) => {
  // Only this middleware sets req.user: routers mounted after the '/' lookups router
  // would otherwise look the session up a second time.
  if (req.user) return next();
  const authorization = req.header('Authorization');
  const match = typeof authorization === 'string' && /^Bearer ([^\s]+)$/i.exec(authorization);
  if (!match) return res.status(401).json({ message: 'No token provided' });
  try {
    req.user = await currentStaffSession(match[1]);
    res.set?.('Cache-Control', 'private, no-store');
  } catch (error) {
    if (error.code === 'INVALID_SESSION') return res.status(401).json({ message: 'Invalid or expired token' });
    // Failure to look up the current account does not revoke its credentials.
    // Deny this request, but let the browser retry without erasing its session.
    res.set?.('Retry-After', '3');
    res.set?.('Cache-Control', 'no-store');
    return res.status(503).json({ code: 'AUTH_SERVICE_UNAVAILABLE', message: 'The session service is temporarily unavailable. Please retry.' });
  }
  next();
};
export default authMiddleware;
