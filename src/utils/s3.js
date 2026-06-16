import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Upload } from '@aws-sdk/lib-storage';
import fs from 'fs';
import path from 'path';

// Same S3-with-local-fallback approach as the accounting backend, but KYC docs
// live under the `kyc_documents/` prefix. NOTE: for the OCR worker (a separate
// process/service) to read uploads, S3 MUST be configured. The local fallback only
// works when api + worker share a filesystem (local dev).

let s3Client = null;
if (process.env.AWS_ACCESS_KEY_ID) {
  s3Client = new S3Client({
    region: process.env.AWS_REGION || 'ap-south-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });
}

const BUCKET = process.env.AWS_S3_BUCKET_NAME || '';
const LOCAL_DIR = path.join(process.cwd(), 'src', 'uploads');
if (!fs.existsSync(LOCAL_DIR)) fs.mkdirSync(LOCAL_DIR, { recursive: true });

const usingS3 = () => Boolean(s3Client && process.env.AWS_ACCESS_KEY_ID && BUCKET);

/** Upload a KYC document. Returns a storage key: an S3 key, or `local::<name>`. */
export const uploadKycDocument = async (fileBuffer, originalName, mimetype) => {
  const safeName = `${Date.now()}-${Math.round(Math.random() * 1e9)}-${originalName.replace(/[^\w.\-]/g, '_')}`;
  const key = `kyc_documents/${safeName}`;

  if (usingS3()) {
    const upload = new Upload({
      client: s3Client,
      params: { Bucket: BUCKET, Key: key, Body: fileBuffer, ContentType: mimetype },
      queueSize: 4,
      partSize: 5 * 1024 * 1024,
    });
    await upload.done();
    return key;
  }
  fs.writeFileSync(path.join(LOCAL_DIR, safeName), fileBuffer);
  return `local::${safeName}`;
};

/**
 * Read a stored KYC document's raw bytes — from S3 (key) or local disk (`local::name`).
 * Used by the in-process OCR engine, which now runs inside booking-api (no separate worker),
 * so the local-disk fallback works in dev without S3.
 */
export const fetchKycDocumentBytes = async (storageKey) => {
  if (!storageKey) throw new Error('document has no file_path');

  if (storageKey.startsWith('local::')) {
    const p = path.join(LOCAL_DIR, storageKey.replace('local::', ''));
    return fs.promises.readFile(p);
  }

  if (!usingS3()) throw new Error('S3 not configured — cannot read document bytes');
  const out = await s3Client.send(new GetObjectCommand({ Bucket: BUCKET, Key: storageKey }));
  // Body is a Node Readable stream; collect it into a Buffer.
  const chunks = [];
  for await (const chunk of out.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
};

export const deleteKycDocument = async (storageKey) => {
  if (!storageKey) return;
  if (storageKey.startsWith('local::')) {
    const p = path.join(LOCAL_DIR, storageKey.replace('local::', ''));
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } else if (usingS3()) {
    await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: storageKey }));
  }
};

/** A browser-usable URL for a stored document (signed for S3, static for local). */
export const getKycDocumentUrl = async (storageKey) => {
  if (!storageKey) return null;
  if (storageKey.startsWith('local::')) {
    const name = storageKey.replace('local::', '');
    return `http://localhost:${process.env.PORT || 8001}/uploads/${name}`;
  }
  if (usingS3()) {
    const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: storageKey });
    return await getSignedUrl(s3Client, cmd, { expiresIn: 3600 });
  }
  return null;
};

/**
 * Durable, directly-loadable URL for a stored doc — used when writing the document
 * back onto the accounting `members` record (the accounting client page renders it as
 * a raw <img src>, so it must not expire like a signed URL). Requires the bucket to
 * serve objects publicly. Falls back to the booking-api static path for local files.
 */
export const getPublicKycUrl = (storageKey) => {
  if (!storageKey) return null;
  if (storageKey.startsWith('local::')) {
    return `http://localhost:${process.env.PORT || 8001}/uploads/${storageKey.replace('local::', '')}`;
  }
  if (!BUCKET) return null;
  const region = process.env.AWS_REGION || 'ap-south-1';
  return `https://${BUCKET}.s3.${region}.amazonaws.com/${storageKey}`;
};

export const isS3Enabled = usingS3;
