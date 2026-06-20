import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import upload from '../middlewares/multer.middleware.js';
import {
  listPlotsWithDocs, getPlotDocuments, uploadPlotDocument, deletePlotDocument,
} from '../controllers/plotDocument.controller.js';

const router = express.Router();
router.use(authMiddleware);

router.get('/', listPlotsWithDocs);                                  // ?site_id=X
router.get('/:plotId', getPlotDocuments);
router.post('/:plotId', upload.single('file'), uploadPlotDocument);
router.delete('/doc/:docId', deletePlotDocument);

export default router;
