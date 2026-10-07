import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import { listDrawAttendance, markDrawAttendance, undoDrawAttendance } from '../controllers/drawAttendance.controller.js';
const router=express.Router();
router.use(authMiddleware);
router.get('/',listDrawAttendance);
router.post('/scan',markDrawAttendance);
router.patch('/:id/correct',undoDrawAttendance);
export default router;
