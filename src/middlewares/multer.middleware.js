import multer from 'multer';
import path from 'path';

// In-memory storage: we hand the buffer straight to the S3 util (so the OCR worker
// can read it from S3). Validates KYC-friendly file types.
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  // docx accepted for typed/scanned KYC forms (text extracted via mammoth).
  const allowed = /jpg|jpeg|png|webp|pdf|docx/;
  const okExt = allowed.test(path.extname(file.originalname).toLowerCase());
  // Trust a matching mime, or a generic octet-stream when the extension is valid
  // (some clients don't set an image/* content-type). docx's real mime is the long
  // openxml one, which the regex won't match — the extension check covers it.
  const okMime = allowed.test(file.mimetype)
    || file.mimetype === 'application/octet-stream'
    || file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (okExt && okMime) return cb(null, true);
  cb(new Error('Invalid file type (allowed: jpg, jpeg, png, webp, pdf, docx)'));
};

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter,
});

export default upload;
