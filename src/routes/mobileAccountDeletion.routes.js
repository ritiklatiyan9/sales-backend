import express from 'express';
import pool from '../config/db.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import { createMobileAccountDeletion } from '../services/mobileAccountDeletion.service.js';

// A super-admin must first verify the customer outside this API, inspect the
// returned linked identities, and obtain a specific deletion request.
export function createMobileAccountDeletionRouter({
  db = pool,
  authenticate = authMiddleware,
  service = createMobileAccountDeletion(db, { secureEnrollmentEnabled: () => true }),
} = {}) {
  const router = express.Router();
  router.use(authenticate);
  router.use((req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    if (String(req.user?.role || '').toLowerCase() !== 'super_admin') {
      return res.status(403).json({message: 'Only the super admin can manage app account deletion.'});
    }
    next();
  });
  const run = handler => (req,res) => Promise.resolve(handler(req,res)).catch(error => {
    const status = [400,403,404,409,503].includes(error.statusCode) ? error.statusCode : 503;
    res.status(status).json({message: status === 503 ? 'Account deletion is temporarily unavailable.' : error.message});
  });
  router.get('/members/:memberId', run(async (req,res) => res.json(await service.lookup(req.params.memberId))));
  router.post('/delete', run(async (req,res) => res.json(await service.remove(req.body || {}))));
  return router;
}
export default createMobileAccountDeletionRouter();
