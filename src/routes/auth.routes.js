import express from 'express';
import { login, refresh, getMe } from '../controllers/auth.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';

const router = express.Router();

router.post('/login', login);
router.post('/refresh', refresh);
router.get('/me', authMiddleware, getMe);

export default router;
