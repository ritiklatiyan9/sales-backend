import { subAdminPermission } from '../middlewares/subAdminPermission.middleware.js';
import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import upload from '../middlewares/multer.middleware.js';
import {
  searchClients, getClient, createClient, updateClient, availablePlots, uploadClientPhoto,
  getClientPayments, searchAgents, listClients, lookupClientReferral, listSiteBanks,
  uploadClientDocument, getClientDocuments, previewClientIdentity,
} from '../controllers/booking.controller.js';

// Shared Accounting member lookups (optionally member_type-filtered) + plot inventory.
const router = express.Router();
router.use(authMiddleware);

router.get('/clients/search', searchClients);
router.get('/clients', listClients);
router.get('/agents/referral', lookupClientReferral);
router.get('/agents/search', searchAgents);
router.get('/banks', listSiteBanks);
router.post('/clients', (req, res, next) => subAdminPermission([true, 'true', 1, '1'].includes(req.body?.registration) ? 'booking_clients' : ['booking_members', 'booking_kyc_new'], 'can_write')(req, res, next), createClient);
router.post('/clients/identity/preview', upload.single('file'), previewClientIdentity);
router.get('/clients/:id', getClient);
router.get('/clients/:id/payments', subAdminPermission(['booking_draws', 'booking_bookings'], 'can_read'), getClientPayments);
router.get('/clients/:id/documents', subAdminPermission(['booking_clients', 'booking_members', 'booking_kyc_all', 'booking_kyc_new'], 'can_read'), getClientDocuments);
router.post('/clients/:id/documents', upload.single('file'), uploadClientDocument);
router.put('/clients/:id', subAdminPermission(['booking_members', 'booking_clients'], 'can_update'), updateClient);
router.post('/clients/:id/photo', subAdminPermission(['booking_members', 'booking_clients'], 'can_update'), upload.single('photo'), uploadClientPhoto);
router.get('/plots/available', availablePlots);

export default router;
