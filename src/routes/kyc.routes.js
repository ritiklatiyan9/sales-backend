import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import upload from '../middlewares/multer.middleware.js';
import {
  uploadDocument, getDocument, deleteDocument, getCase, retryDocument, extractPreview, verifyCase,
  updateDocumentFields, createCase, listCases, updateCaseCustomer, deleteCase,
} from '../controllers/kyc.controller.js';

const router = express.Router();
router.use(authMiddleware);

router.post('/upload', upload.single('file'), uploadDocument);
router.get('/document/:id', getDocument);
router.delete('/document/:id', deleteDocument);
router.post('/document/:id/retry', retryDocument);
router.patch('/document/:id/fields', updateDocumentFields);
// NB: '/cases' before '/case/:id' — member-first KYC list + quick-add (agent flow).
router.get('/cases', listCases);
router.post('/cases', createCase);
router.get('/case/:id', getCase);
router.patch('/case/:id/customer', updateCaseCustomer);
router.delete('/case/:id', deleteCase);
router.post('/case/:id/extract-preview', extractPreview);
router.post('/case/:id/verify', verifyCase);

export default router;
