import { currentStaffSession } from '../services/staffSession.js';

const authMiddleware = async (req, res, next) => {
  const authorization = req.header('Authorization');
  const match = typeof authorization === 'string' && /^Bearer ([^\s]+)$/i.exec(authorization);
  if (!match) return res.status(401).json({ message: 'No token provided' });
  try {
    req.user = await currentStaffSession(match[1]);
    res.set?.('Cache-Control', 'private, no-store');
  } catch {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
  next();
};
export default authMiddleware;
