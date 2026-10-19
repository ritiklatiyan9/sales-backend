import { subAdminPermission } from '../middlewares/subAdminPermission.middleware.js';
import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import upload from '../middlewares/multer.middleware.js';
import {
  uploadDocument, getDocument, deleteDocument, getCase, retryDocument, extractPreview, verifyCase,
  updateDocumentFields, createCase, listCases, updateCaseCustomer, deleteCase,
  previewFreshForm, commitFreshForm, listMemberTypes,
} from '../controllers/kyc.controller.js';

const router = express.Router();
router.use(authMiddleware);

router.post('/upload', subAdminPermission(["booking_kyc_new", "booking_kyc_all"], 'can_write'), upload.single('file'), uploadDocument);
router.get('/document/:id', subAdminPermission(["booking_kyc_new", "booking_kyc_all"], 'can_read'), getDocument);
router.delete('/document/:id', subAdminPermission("booking_kyc_all", 'can_delete'), deleteDocument);
router.post('/document/:id/retry', subAdminPermission("booking_kyc_all", 'can_update'), retryDocument);
router.patch('/document/:id/fields', subAdminPermission("booking_kyc_all", 'can_update'), updateDocumentFields);
router.post('/fresh-form/preview', subAdminPermission("booking_kyc_new", 'can_write'), upload.single('file'), previewFreshForm);
router.post('/fresh-form/commit', subAdminPermission("booking_kyc_new", 'can_write'), upload.single('file'), commitFreshForm);
router.get('/member-types', subAdminPermission(["booking_kyc_new", "booking_members"], 'can_read'), listMemberTypes);
// NB: '/cases' before '/case/:id' — member-first KYC list + quick-add (agent flow).
router.get('/cases', subAdminPermission("booking_kyc_all", 'can_read'), listCases);
router.post('/cases', subAdminPermission("booking_kyc_new", 'can_write'), createCase);
router.get('/case/:id', subAdminPermission(["booking_kyc_new", "booking_kyc_all"], 'can_read'), getCase);
router.patch('/case/:id/customer', subAdminPermission("booking_kyc_all", 'can_update'), updateCaseCustomer);
router.delete('/case/:id', subAdminPermission("booking_kyc_all", 'can_delete'), deleteCase);
router.post('/case/:id/extract-preview', subAdminPermission("booking_kyc_all", 'can_update'), extractPreview);
router.post('/case/:id/verify', subAdminPermission("booking_kyc_all", 'can_update'), verifyCase);

export default router;
