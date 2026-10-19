import multer from 'multer';
import { uploadTypeAllowed, validUploadBytes } from '../security/uploadPolicy.js';
import { documentUploadLimit } from './rateLimit.middleware.js';

const invalid = () => Object.assign(new Error('Invalid file. Upload a matching JPG, PNG, WebP, PDF or DOCX document.'), { status: 400, code: 'INVALID_DOCUMENT_FILE' });
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 40, parts: 41, fieldSize: 256 * 1024 },
  fileFilter: (req, file, cb) => uploadTypeAllowed(file) ? cb(null, true) : cb(invalid()),
});
// Validate the actual bytes before controllers store a file or start OCR.
const single = upload.single.bind(upload);
upload.single = field => {
  const receive = single(field);
  return (req, res, next) => documentUploadLimit(req, res, () => receive(req, res, error => {
    if (error) return next(error);
    if (req.file && !validUploadBytes(req.file)) return next(invalid());
    next();
  }));
};
export default upload;
