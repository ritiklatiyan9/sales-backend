import express from 'express';
import { requireClientPortalEnabled } from '../services/clientPortalAvailability.js';
import { clientAuthMiddleware,clientMe,clientRecords,clientRefresh,clientUpdateProfile,clientLogout,clientDocument } from '../controllers/clientPortal.controller.js';

const router = express.Router();
router.use((req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
router.use(requireClientPortalEnabled);
router.post('/auth/refresh', clientRefresh);
router.use(clientAuthMiddleware);
router.get('/me', clientMe);
router.get('/records', clientRecords);
router.patch('/profile', clientUpdateProfile);
router.post('/auth/logout', clientLogout);
router.get('/documents/:id', clientDocument);
export default router;
