import express from 'express';
import authRoutes from './auth.routes.js';
import bookingRoutes from './booking.routes.js';
import lookupRoutes from './lookups.routes.js';
import kycRoutes from './kyc.routes.js';
import plotDocumentRoutes from './plotDocument.routes.js';
import settingsRoutes from './settings.routes.js';
import agentRoutes from './agent.routes.js';
import teamRoutes from './team.routes.js';
import adminRoutes from './admin.routes.js';
import homeLayoutRoutes from './homeLayout.routes.js';

const router = express.Router();

router.get('/health', (req, res) => res.json({ status: 'ok', service: 'booking-api' }));

router.use('/auth', authRoutes);
router.use('/bookings', bookingRoutes);
router.use('/', lookupRoutes);   // /clients/search, /clients, /clients/:id, /plots/available
router.use('/kyc', kycRoutes);
router.use('/plot-documents', plotDocumentRoutes);   // Plot-centric shared document store
router.use('/project-settings', settingsRoutes);   // Project Details (company + payments)
router.use('/agents', agentRoutes);   // Agent network: hierarchy, referrals, ledger
router.use('/teams', teamRoutes);     // Team management (admin only)
router.use('/admin', adminRoutes);    // Access control: sites + module permissions
router.use('/home-layout', homeLayoutRoutes); // Per-user launcher screen layout

export default router;
