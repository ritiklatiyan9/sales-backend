import multer from 'multer';
import path from 'path';

// In-memory storage: we hand the buffer straight to the S3 util (so the OCR worker
// can read it from S3). Validates KYC-friendly file types.
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const allowed = /jpg|jpeg|png|webp|pdf/;
  const okExt = allowed.test(path.extname(file.originalname).toLowerCase());
  // Trust a matching mime, or a generic octet-stream when the extension is valid
  // (some clients don't set an image/* content-type).
  const okMime = allowed.test(file.mimetype) || file.mimetype === 'application/octet-stream';
  if (okExt && okMime) return cb(null, true);
  cb(new Error('Invalid file type (allowed: jpg, jpeg, png, webp, pdf)'));
};

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter,
});

export default upload;
