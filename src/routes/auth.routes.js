import express from 'express';
import {
  login, googleLogin, verifyLoginOtp, resendLoginOtp, refresh, getMe, updateProfile, linkStaffKyc, getKycLoginOptions,
} from '../controllers/auth.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';

const router = express.Router();

router.post('/login', login);
router.post('/google', googleLogin);
router.post('/verify-otp', verifyLoginOtp);
router.post('/resend-otp', resendLoginOtp);
router.post('/refresh', refresh);
router.get('/me', authMiddleware, getMe);
router.patch('/profile', authMiddleware, updateProfile);
router.patch('/staff/:userId/kyc', authMiddleware, linkStaffKyc);
router.get('/kyc-login/:caseId', authMiddleware, getKycLoginOptions);

export default router;
