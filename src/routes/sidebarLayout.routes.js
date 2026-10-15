import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import { getSidebarLayout, saveSidebarLayout } from '../controllers/sidebarLayout.controller.js';
const router = express.Router();
router.use(authMiddleware);
router.get('/',getSidebarLayout);
router.put('/',saveSidebarLayout);
export default router;
