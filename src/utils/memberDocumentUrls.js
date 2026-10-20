import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
function parseS3ImageUrl(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  const match = url.hostname.match(/^(.+)\.s3[.-]([a-z]{2}-[a-z]+-\d)\.amazonaws\.com$/);
  if (url.protocol !== 'https:' || !match || url.username || url.password || url.port) return null;
  return { Bucket: match[1], Key: decodeURIComponent(url.pathname.slice(1)), region: match[2] };
}

const clients = new Map();
const credentialsFor = (accessKeyId, secretAccessKey) => (
  accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined
);

// Member document URLs are stored in the database and can outlive an S3 bucket
// change. Only sign URLs from the two explicitly configured storage buckets.
export function memberDocumentStorage(value, env = process.env) {
  let source;
  try { source = parseS3ImageUrl(value); } catch { return null; }
  if (!source?.Key) return null;

  const currentBucket = env.AWS_S3_BUCKET_NAME || env.AWS_S3_BUCKET;
  const legacyBucket = env.LEGACY_AWS_S3_BUCKET_NAME || env.LEGACY_AWS_S3_BUCKET;
  if (source.Bucket === currentBucket && source.region === (env.AWS_REGION || 'ap-south-1')) {
    return {
      ...source,
      profile: 'current',
      credentials: credentialsFor(env.AWS_ACCESS_KEY_ID, env.AWS_SECRET_ACCESS_KEY),
    };
  }
  if (source.Bucket === legacyBucket && source.region === (env.LEGACY_AWS_REGION || 'ap-south-1')) {
    return {
      ...source,
      profile: 'legacy',
      // The same IAM key can be granted access to both buckets. Dedicated
      // legacy credentials take priority when they are configured.
      credentials: credentialsFor(env.LEGACY_AWS_ACCESS_KEY_ID, env.LEGACY_AWS_SECRET_ACCESS_KEY)
        || credentialsFor(env.AWS_ACCESS_KEY_ID, env.AWS_SECRET_ACCESS_KEY),
    };
  }
  return null;
}

// Call only after the caller has checked the member's site and read permission.
export async function signMemberDocumentUrl(value) {
  const storage = memberDocumentStorage(value);
  if (!storage) return value;
  const { Bucket, Key, region, profile, credentials } = storage;
  const clientKey = `${profile}:${Bucket}:${region}`;
  if (!clients.has(clientKey)) {
    clients.set(clientKey, new S3Client({ region, ...(credentials ? { credentials } : {}) }));
  }
  try {
    return await getSignedUrl(clients.get(clientKey), new GetObjectCommand({ Bucket, Key }), { expiresIn: 3600 });
  } catch {
    // Keep the member profile available if storage credentials are incomplete.
    return value;
  }
}
