import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import { getLayout, saveLayout } from '../controllers/homeLayout.controller.js';

// Always self-scoped (req.user.id) — no user id in the path, nothing to authorise
// beyond "is logged in".
const router = express.Router();
router.use(authMiddleware);

router.get('/', getLayout);
router.put('/', saveLayout);

export default router;
