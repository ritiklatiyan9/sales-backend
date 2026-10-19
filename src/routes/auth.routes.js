import express from 'express';
import {
  login, googleLogin, verifyLoginOtp, resendLoginOtp, refresh, getMe, updateProfile, linkStaffKyc, getKycLoginOptions,
} from '../controllers/auth.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';

import { loginIpLimit, loginAccountLimit, refreshLimit } from '../middlewares/rateLimit.middleware.js';

const router = express.Router();
router.use((req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });

router.post('/login', loginIpLimit, loginAccountLimit, login);
router.post('/google', loginIpLimit, googleLogin);
router.post('/verify-otp', loginIpLimit, verifyLoginOtp);
router.post('/resend-otp', loginIpLimit, resendLoginOtp);
router.post('/refresh', refreshLimit, refresh);
router.get('/me', authMiddleware, getMe);
router.patch('/profile', authMiddleware, updateProfile);
router.patch('/staff/:userId/kyc', authMiddleware, linkStaffKyc);
router.get('/kyc-login/:caseId', authMiddleware, getKycLoginOptions);

export default router;
