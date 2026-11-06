import { currentStaffSession } from '../services/staffSession.js';
import { isBookingToken } from '../services/bookingAppAccess.js';

export const createAuthMiddleware = ({ allowAccountancyOnly = false, allowAccountsIntegration = false } = {}) => async (req, res, next) => {
  // Only this middleware sets req.user: routers mounted after the '/' lookups router
  // would otherwise look the session up a second time.
  if (req.user) {
    const accountsIntegration = allowAccountsIntegration && req.user.app === 'accounts'
      && req.user.role === 'super_admin' && req.user.can_login_accounts === true
      && !req.user.realm && !req.user.aud && !req.user.client;
    if (!isBookingToken(req.user) && !accountsIntegration) {
      return res.status(401).json({ message: 'Invalid or expired token' });
    }
    if (!accountsIntegration && !allowAccountancyOnly && req.user.can_login_booking === false) {
      return res.status(403).json({ code: 'BOOKING_ACCESS_DENIED', message: 'This ID is not allowed to access Booking.' });
    }
    return next();
  }
  const authorization = req.header('Authorization');
  const match = typeof authorization === 'string' && /^Bearer ([^\s]+)$/i.exec(authorization);
  if (!match) return res.status(401).json({ message: 'No token provided' });
  try {
    req.user = await currentStaffSession(match[1], undefined, { allowAccountancyOnly, allowAccountsIntegration });
    res.set?.('Cache-Control', 'private, no-store');
  } catch (error) {
    if (error.code === 'BOOKING_ACCESS_DENIED') return res.status(403).json({ code: error.code, message: error.message });
    if (error.code === 'INVALID_SESSION') return res.status(401).json({ message: 'Invalid or expired token' });
    // Failure to look up the current account does not revoke its credentials.
    // Deny this request, but let the browser retry without erasing its session.
    res.set?.('Retry-After', '3');
    res.set?.('Cache-Control', 'no-store');
    return res.status(503).json({ code: 'AUTH_SERVICE_UNAVAILABLE', message: 'The session service is temporarily unavailable. Please retry.' });
  }
  next();
};
// Only the session bootstrap can admit an Accountancy-only user. All business
// routers, sockets and mobile staff sessions retain the stricter default.
export const authBootstrapMiddleware = createAuthMiddleware({ allowAccountancyOnly: true });
export const clientInvitationAuthMiddleware = createAuthMiddleware({ allowAccountsIntegration: true });
export default createAuthMiddleware();
