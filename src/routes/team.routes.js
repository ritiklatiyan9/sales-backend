import { subAdminPermission } from '../middlewares/subAdminPermission.middleware.js';
import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import {
  listTeams, getTeam, createTeam, updateTeam, deleteTeam, upsertMember, removeMember,
  addDealer, moveDealer, setTeamHead, removeDealer,
} from '../controllers/team.controller.js';

const router = express.Router();
router.use(authMiddleware);
router.use(subAdminPermission('booking_teams'));

router.get('/', listTeams);
router.post('/', createTeam);
router.get('/:id', getTeam);
router.patch('/:id', updateTeam);
router.delete('/:id', deleteTeam);
router.post('/:id/members', upsertMember);
router.delete('/:id/members/:userId', removeMember);
router.post('/:id/dealers', addDealer);
router.patch('/:id/dealers/:brokerId', moveDealer);
router.delete('/:id/dealers/:brokerId', removeDealer);
router.put('/:id/head', setTeamHead);

export default router;
