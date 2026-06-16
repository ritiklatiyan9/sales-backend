import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import upload from '../middlewares/multer.middleware.js';
import {
  uploadDocument, getDocument, deleteDocument, getCase, retryDocument, extractPreview, verifyCase,
} from '../controllers/kyc.controller.js';

const router = express.Router();
router.use(authMiddleware);

router.post('/upload', upload.single('file'), uploadDocument);
router.get('/document/:id', getDocument);
router.delete('/document/:id', deleteDocument);
router.post('/document/:id/retry', retryDocument);
router.get('/case/:id', getCase);
router.post('/case/:id/extract-preview', extractPreview);
router.post('/case/:id/verify', verifyCase);

export default router;
