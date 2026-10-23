import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import asyncHandler from '../utils/asyncHandler.js';
import upload from '../middlewares/multer.middleware.js';
import { DOCUMENTS } from '../services/whatsappDocuments.js';
import { deleteTemplate, saveStage, sendTestMessage, studioState, submitTemplate, updateTemplate } from '../services/whatsapp.service.js';
import {
  addOptOut, cancelCampaign, deleteMarketingTemplate, updateMarketingTemplate, marketingCustomers, marketingState, removeOptOut, sendMarketingTest, startCampaign, submitMarketingTemplate,
} from '../services/whatsappMarketing.js';

// WhatsApp Studio: admin and super_admin only, like Draw Settings (the sidebar hides it for others).
const router = express.Router();
router.use(authMiddleware);
router.use((req, res, next) => (['admin', 'super_admin'].includes(req.user?.role)
  ? next() : res.status(403).json({ message: 'Only admins manage WhatsApp messages' })));

router.get('/studio', asyncHandler(async (req, res) => res.json(await studioState())));
router.put('/stages/:event', asyncHandler(async (req, res) => res.json(await saveStage(req.params.event, req.body || {}, req.user.id))));
router.post('/templates', asyncHandler(async (req, res) => res.status(201).json(await submitTemplate({
  event: req.body?.event, title: req.body?.title, body: req.body?.body, hasDocument: req.body?.has_document === true, userId: req.user.id,
}))));
router.patch('/templates/:name', asyncHandler(async (req, res) => res.json(await updateTemplate(req.params.name, req.body || {}))));
router.delete('/templates/:name', asyncHandler(async (req, res) => {
  await deleteTemplate(req.params.name);
  res.json({ deleted: req.params.name });
}));
router.post('/test', asyncHandler(async (req, res) => res.json(await sendTestMessage(req.body?.event, req.body?.phone))));
// Sample PDF (made-up data) so admins can see the attachment before it goes to customers.
router.get('/documents/:key/sample', asyncHandler(async (req, res) => {
  const doc = DOCUMENTS[req.params.key];
  if (!doc) return res.status(404).json({ message: 'Unknown document' });
  res.type('application/pdf').set('Content-Disposition', `inline; filename="${doc.filename(doc.sample)}"`).send(await doc.render(doc.sample));
}));

// WhatsApp Marketing: template changes and campaigns are scoped to an accessible site.
router.get('/marketing', asyncHandler(async (req, res) => res.json(await marketingState(req.user, req.query.site_id))));
router.get('/marketing/customers', asyncHandler(async (req, res) => res.json(await marketingCustomers(req.user, req.query.site_id))));
router.post('/marketing/templates', upload.single('image'), asyncHandler(async (req, res) => res.status(201).json(await submitMarketingTemplate({
  user: req.user, siteId: req.body.site_id, title: req.body.title, body: req.body.body, image: req.file || null, sourceTemplateName: req.body.source_template, reuseImage: req.body.reuse_image === 'true',
  website: { text: req.body.website_text, url: req.body.website_url }, call: { text: req.body.call_text, phone: req.body.call_phone },
}))));
router.patch('/marketing/templates/:name', asyncHandler(async (req, res) => res.json(await updateMarketingTemplate({
  user: req.user, siteId: req.body?.site_id, name: req.params.name, input: { title: req.body?.title, archived: req.body?.archived },
}))));
router.delete('/marketing/templates/:name', asyncHandler(async (req, res) => {
  await deleteMarketingTemplate({ user: req.user, siteId: req.query.site_id, name: req.params.name });
  res.json({ deleted: req.params.name });
}));
router.post('/marketing/test', asyncHandler(async (req, res) => res.json(await sendMarketingTest({
  user: req.user, siteId: req.body?.site_id, templateName: req.body?.template, phone: req.body?.phone,
}))));
router.post('/marketing/campaigns', asyncHandler(async (req, res) => {
  const memberIds = req.body?.member_ids;
  if (memberIds !== undefined && (!Array.isArray(memberIds) || memberIds.length > 20000 || !memberIds.every(Number.isInteger))) {
    return res.status(400).json({ message: 'member_ids must be a list of customer ids' });
  }
  res.status(201).json(await startCampaign({ user: req.user, siteId: req.body?.site_id, templateName: req.body?.template, memberIds: memberIds ?? null }));
}));
router.post('/marketing/campaigns/:id/cancel', asyncHandler(async (req, res) => res.json(await cancelCampaign({ user: req.user, id: req.params.id }))));
router.post('/marketing/opt-outs', asyncHandler(async (req, res) => res.status(201).json(await addOptOut({
  user: req.user, phone: req.body?.phone, reason: req.body?.reason,
}))));
router.delete('/marketing/opt-outs/:phone', asyncHandler(async (req, res) => res.json(await removeOptOut(req.params.phone))));

export default router;
