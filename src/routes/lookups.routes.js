import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import upload from '../middlewares/multer.middleware.js';
import {
  searchClients, getClient, createClient, updateClient, availablePlots, uploadClientPhoto,
  getClientPayments, searchAgents, listClients, lookupClientReferral,
  uploadClientDocument, getClientDocuments, previewClientIdentity,
} from '../controllers/booking.controller.js';

// Shared Accounting member lookups (optionally member_type-filtered) + plot inventory.
const router = express.Router();
router.use(authMiddleware);

router.get('/clients/search', searchClients);
router.get('/clients', listClients);
router.get('/agents/referral', lookupClientReferral);
router.get('/agents/search', searchAgents);
router.post('/clients', createClient);
router.post('/clients/identity/preview', upload.single('file'), previewClientIdentity);
router.get('/clients/:id', getClient);
router.get('/clients/:id/payments', getClientPayments);
router.get('/clients/:id/documents', getClientDocuments);
router.post('/clients/:id/documents', upload.single('file'), uploadClientDocument);
router.put('/clients/:id', updateClient);
router.post('/clients/:id/photo', upload.single('photo'), uploadClientPhoto);
router.get('/plots/available', availablePlots);

export default router;
