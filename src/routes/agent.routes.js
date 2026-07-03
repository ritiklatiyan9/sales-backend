import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import {
  getMe, getNetwork, getAgent, lookupReferral, createAgent, updateAgent, getLedger, addLedgerEntry,
} from '../controllers/agent.controller.js';

const router = express.Router();
router.use(authMiddleware);

router.get('/me', getMe);
router.get('/network', getNetwork);
router.get('/referral/:code', lookupReferral);
router.post('/', createAgent);
router.patch('/:id', updateAgent);
router.get('/:id/ledger', getLedger);
router.post('/:id/ledger', addLedgerEntry);
// Registered last so the more specific routes above win the match.
router.get('/:id', getAgent);

export default router;
