import express from 'express';
import {
  login, googleLogin, verifyLoginOtp, resendLoginOtp, refresh, getMe,
} from '../controllers/auth.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';

const router = express.Router();

router.post('/login', login);
router.post('/google', googleLogin);
router.post('/verify-otp', verifyLoginOtp);
router.post('/resend-otp', resendLoginOtp);
router.post('/refresh', refresh);
router.get('/me', authMiddleware, getMe);

export default router;
