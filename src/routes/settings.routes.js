import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import { getProjectSettings, saveProjectSettings } from '../controllers/settings.controller.js';

// Project Details: per-site Company + Payment details rendered on the booking form.
const router = express.Router();
router.use(authMiddleware);

router.get('/', getProjectSettings);
router.put('/', saveProjectSettings);

export default router;
