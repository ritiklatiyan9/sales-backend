import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import { listPlotPayments, createPlotPayment } from '../controllers/plotPayments.controller.js';

// Booking-side window onto the shared accounting plot_payments ledger. Admin only
// (enforced in the controller, mirroring the accounting module's role gate).
const router = express.Router();
router.use(authMiddleware);

router.get('/', listPlotPayments);
router.post('/', createPlotPayment);

export default router;
