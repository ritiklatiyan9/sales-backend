import express from 'express';
import authRoutes from './auth.routes.js';
import bookingRoutes from './booking.routes.js';
import lookupRoutes from './lookups.routes.js';
import kycRoutes from './kyc.routes.js';
import settingsRoutes from './settings.routes.js';

const router = express.Router();

router.get('/health', (req, res) => res.json({ status: 'ok', service: 'booking-api' }));

router.use('/auth', authRoutes);
router.use('/bookings', bookingRoutes);
router.use('/', lookupRoutes);   // /clients/search, /clients, /clients/:id, /plots/available
router.use('/kyc', kycRoutes);
router.use('/project-settings', settingsRoutes);   // Project Details (company + payments)

export default router;
