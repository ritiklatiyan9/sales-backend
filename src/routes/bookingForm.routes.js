import express from 'express';
import multer from 'multer';
import authMiddleware from '../middlewares/auth.middleware.js';
import { getPublishedForm, getFormStudio, saveFormDraft, publishForm, uploadFormImage } from '../controllers/bookingForm.controller.js';
const router = express.Router();
const images = multer({ storage:multer.memoryStorage(), limits:{fileSize:5*1024*1024}, fileFilter:(_req,file,cb) => {
  if (!['image/jpeg','image/png','image/webp'].includes(file.mimetype)) return cb(Object.assign(new Error('Choose a JPG, PNG or WebP image'),{status:400}));
  cb(null,true);
} });
router.use(authMiddleware);
router.get('/:siteId/published', getPublishedForm);
router.get('/:siteId', getFormStudio);
router.put('/:siteId/draft', saveFormDraft);
router.post('/:siteId/publish', publishForm);
router.post('/:siteId/images', (req,res,next) => images.single('image')(req,res,error => {
  if (error?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({message:'Choose an image smaller than 5 MB'});
  if (error) return next(error);
  next();
}), uploadFormImage);
export default router;
