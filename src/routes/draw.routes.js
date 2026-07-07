import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import {
  createDraw, listDraws, getDraw, addDrawPayment, deleteDrawPayment,
  issueSlip, markWinner, scanDraw, allotShop, cancelDraw,
} from '../controllers/draw.controller.js';

const router = express.Router();
router.use(authMiddleware);

router.get('/', listDraws);
router.post('/', createDraw);
// NB: must be registered before '/:id' so "scan" isn't parsed as a registration id.
router.post('/scan', scanDraw);
router.get('/:id', getDraw);
router.post('/:id/payments', addDrawPayment);
router.delete('/:id/payments/:paymentId', deleteDrawPayment);
router.post('/:id/issue-slip', issueSlip);
router.post('/:id/winner', markWinner);
router.post('/:id/allot', allotShop);
router.post('/:id/cancel', cancelDraw);

export default router;
