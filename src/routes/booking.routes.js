import { subAdminPermission } from '../middlewares/subAdminPermission.middleware.js';
import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import {
  listBookings, createBooking, getBooking, updateBooking, cancelBooking, deleteBooking,
  getDashboard, getBookingDrawCredits, getBookingIntake,
} from '../controllers/booking.controller.js';

const router = express.Router();
router.use(authMiddleware);

router.get('/', subAdminPermission("booking_bookings"), listBookings);
router.post('/', subAdminPermission("booking_new_booking", 'can_write'), createBooking);
// NB: must be registered before '/:id' so "dashboard" isn't parsed as a booking id.
router.get('/dashboard', subAdminPermission("booking_dashboard", 'can_read'), getDashboard);
router.get('/draw-credits', subAdminPermission(["booking_new_booking", "booking_draws"], 'can_read'), getBookingDrawCredits);
router.get('/intake', subAdminPermission("booking_new_booking", 'can_read'), getBookingIntake);
router.get('/:id', subAdminPermission("booking_bookings", 'can_read'), getBooking);
router.put('/:id', subAdminPermission("booking_bookings", 'can_update'), updateBooking);
router.post('/:id/cancel', subAdminPermission("booking_bookings", 'can_update'), cancelBooking);
router.delete('/:id', subAdminPermission("booking_bookings", 'can_delete'), deleteBooking);

export default router;
