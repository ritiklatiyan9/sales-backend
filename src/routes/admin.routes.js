import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import {
  listUsers, getUserAccess, setUserSites, setUserPermission, getMyPermissions,
} from '../controllers/admin.controller.js';

const router = express.Router();
router.use(authMiddleware);

router.get('/my-permissions', getMyPermissions); // any authenticated user (sidebar gating)
router.get('/users', listUsers);
router.get('/users/:id/access', getUserAccess);
router.put('/users/:id/sites', setUserSites);
router.put('/users/:id/permissions', setUserPermission);

export default router;
