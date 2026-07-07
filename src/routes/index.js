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
import drawRoutes from './draw.routes.js';
import plotPaymentRoutes from './plotPayments.routes.js';
import { publicVerifyDraw } from '../controllers/draw.controller.js';

const router = express.Router();

router.get('/health', (req, res) => res.json({ status: 'ok', service: 'booking-api' }));

// PUBLIC (no auth) — resolves a printed draw QR against the live registration so
// anyone scanning the form/slip can confirm it is genuine on the website.
router.get('/public/draws/verify', publicVerifyDraw);

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
router.use('/draws', drawRoutes);     // Draw-based shop allotment (lottery) module
router.use('/plot-payments', plotPaymentRoutes); // Shared accounting plot ledger (admin)

export default router;
