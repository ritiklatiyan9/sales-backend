import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import {
  listAgreementTemplates, getAgreementTemplate, createAgreementTemplate,
  updateAgreementTemplate, setDefaultAgreementTemplate, deleteAgreementTemplate,
} from '../controllers/agreementTemplate.controller.js';

const router = express.Router();
router.use(authMiddleware);
router.get('/', listAgreementTemplates);
router.post('/', createAgreementTemplate);
router.get('/:id', getAgreementTemplate);
router.put('/:id', updateAgreementTemplate);
router.post('/:id/default', setDefaultAgreementTemplate);
router.delete('/:id', deleteAgreementTemplate);
export default router;
