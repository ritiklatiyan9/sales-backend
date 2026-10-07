import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import {
  listBookings, createBooking, getBooking, updateBooking, cancelBooking, deleteBooking,
  getDashboard, getBookingDrawCredits,
} from '../controllers/booking.controller.js';

const router = express.Router();
router.use(authMiddleware);

router.get('/', listBookings);
router.post('/', createBooking);
// NB: must be registered before '/:id' so "dashboard" isn't parsed as a booking id.
router.get('/dashboard', getDashboard);
router.get('/draw-credits', getBookingDrawCredits);
router.get('/:id', getBooking);
router.put('/:id', updateBooking);
router.post('/:id/cancel', cancelBooking);
router.delete('/:id', deleteBooking);

export default router;
