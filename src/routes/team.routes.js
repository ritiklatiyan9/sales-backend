import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import {
  listTeams, getTeam, createTeam, updateTeam, deleteTeam, upsertMember, removeMember,
} from '../controllers/team.controller.js';

const router = express.Router();
router.use(authMiddleware);

router.get('/', listTeams);
router.post('/', createTeam);
router.get('/:id', getTeam);
router.patch('/:id', updateTeam);
router.delete('/:id', deleteTeam);
router.post('/:id/members', upsertMember);
router.delete('/:id/members/:userId', removeMember);

export default router;
