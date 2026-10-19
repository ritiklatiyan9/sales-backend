import { subAdminPermission } from '../middlewares/subAdminPermission.middleware.js';
import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import {
  listWorkflow, paymentStatement, startDrawKyc, createDraw, listDraws, getDraw, updateDraw, addDrawPayment, deleteDrawPayment,
  issueSlip, markWinner, scanDraw, allotShop, cancelDraw, deleteDraw,
  getDrawSettingsHandler, setDrawSettings,
} from '../controllers/draw.controller.js';

const router = express.Router();
router.use(authMiddleware);

router.get('/', subAdminPermission("booking_draws", 'can_read'), listDraws);
router.post('/', subAdminPermission("booking_draws", 'can_write'), createDraw);
// NB: fixed paths must be registered before '/:id' so they aren't parsed as ids.
router.post('/scan', subAdminPermission("booking_draws", 'can_read'), scanDraw);
router.get('/workflow', subAdminPermission("booking_draws", 'can_read'), listWorkflow);
router.get('/payments-statement', subAdminPermission("booking_draws", 'can_read'), paymentStatement);
router.post('/:id/start-kyc', subAdminPermission("booking_draws", 'can_update'), startDrawKyc);
router.get('/settings', subAdminPermission("booking_draws", 'can_read'), getDrawSettingsHandler);
router.put('/settings', subAdminPermission("booking_draws", 'can_update'), setDrawSettings);
router.get('/:id', subAdminPermission("booking_draws", 'can_read'), getDraw);
router.patch('/:id', subAdminPermission("booking_draws", 'can_update'), updateDraw);
router.delete('/:id', subAdminPermission("booking_draws", 'can_delete'), deleteDraw);
router.post('/:id/payments', subAdminPermission("booking_draws", 'can_write'), addDrawPayment);
router.delete('/:id/payments/:paymentId', subAdminPermission("booking_draws", 'can_delete'), deleteDrawPayment);
router.post('/:id/issue-slip', subAdminPermission("booking_draws", 'can_update'), issueSlip);
router.post('/:id/winner', subAdminPermission("booking_draws", 'can_update'), markWinner);
router.post('/:id/allot', subAdminPermission("booking_draws", 'can_update'), allotShop);
router.post('/:id/cancel', subAdminPermission("booking_draws", 'can_update'), cancelDraw);

export default router;
