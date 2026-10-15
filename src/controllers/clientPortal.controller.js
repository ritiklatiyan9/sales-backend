import pool from '../config/db.js';
import asyncHandler from '../utils/asyncHandler.js';
import { fetchKycDocumentBytes } from '../utils/s3.js';
import { clientPortalSession, createClientPortalService, verifyClientToken } from '../services/clientPortal.service.js';

export const clientPortal = createClientPortalService(pool);
export const clientAuthMiddleware = asyncHandler(async (req, res, next) => {
  const token = req.header('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ message: 'No token provided' });
  req.client = await clientPortal.getSession(verifyClientToken(token));
  next();
});
export const clientMe = asyncHandler(async (req, res) => res.json(clientPortalSession(req.client)));
export const clientRecords = asyncHandler(async (req, res) => res.json(await clientPortal.records(req.client, req.query)));
export const clientRefresh = asyncHandler(async (req, res) => res.json(await clientPortal.refresh(req.body.refreshToken)));
export const clientUpdateProfile = asyncHandler(async (req, res) => res.json(await clientPortal.updateProfile(req.client, req.body)));
export const clientLogout = asyncHandler(async (req, res) => { await clientPortal.logout(req.client); res.json({ logged_out: true }); });
export const clientDocument = asyncHandler(async (req, res) => {
  const document = await clientPortal.document(req.client, req.params.id);
  // Storage keys never leave this endpoint, including local development uploads.
  if (document.file_path?.startsWith('local::') && !/^local::[\w.-]+$/.test(document.file_path)) {
    return res.status(404).json({ message: 'Document not found' });
  }
  let bytes;
  try { bytes = await fetchKycDocumentBytes(document.file_path); }
  catch { return res.status(404).json({ message: 'Document unavailable' }); }
  const safeTypes = new Set(['application/pdf','image/jpeg','image/png','image/webp']);
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Disposition', `attachment; filename="document-${document.id}"`);
  res.type(safeTypes.has(document.mime_type) ? document.mime_type : 'application/octet-stream').send(bytes);
});
