import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import upload from '../middlewares/multer.middleware.js';
import {
  searchClients, getClient, createClient, updateClient, availablePlots, uploadClientPhoto,
  getClientPayments,
} from '../controllers/booking.controller.js';

// Lookups used by the booking form: clients (existing members CLIENT) + plots inventory.
const router = express.Router();
router.use(authMiddleware);

router.get('/clients/search', searchClients);
router.post('/clients', createClient);
router.get('/clients/:id', getClient);
router.get('/clients/:id/payments', getClientPayments);
router.put('/clients/:id', updateClient);
router.post('/clients/:id/photo', upload.single('photo'), uploadClientPhoto);
router.get('/plots/available', availablePlots);

export default router;
