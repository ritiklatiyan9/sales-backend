import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import {
  createDraw, listDraws, getDraw, updateDraw, addDrawPayment, deleteDrawPayment,
  issueSlip, markWinner, scanDraw, allotShop, cancelDraw,
  getDrawSettingsHandler, setDrawSettings,
} from '../controllers/draw.controller.js';

const router = express.Router();
router.use(authMiddleware);

router.get('/', listDraws);
router.post('/', createDraw);
// NB: fixed paths must be registered before '/:id' so they aren't parsed as ids.
router.post('/scan', scanDraw);
router.get('/settings', getDrawSettingsHandler);
router.put('/settings', setDrawSettings);
router.get('/:id', getDraw);
router.patch('/:id', updateDraw);
router.post('/:id/payments', addDrawPayment);
router.delete('/:id/payments/:paymentId', deleteDrawPayment);
router.post('/:id/issue-slip', issueSlip);
router.post('/:id/winner', markWinner);
router.post('/:id/allot', allotShop);
router.post('/:id/cancel', cancelDraw);

export default router;
