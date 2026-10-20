import test from 'node:test';
import assert from 'node:assert/strict';
import { memberDocumentStorage, signMemberDocumentUrl } from './memberDocumentUrls.js';

test('resolves member documents from the current and earlier configured buckets', () => {
  const env = {
    AWS_S3_BUCKET_NAME: 'mountreality', AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'current-key', AWS_SECRET_ACCESS_KEY: 'current-secret',
    LEGACY_AWS_S3_BUCKET_NAME: 'aierpbytematrix', LEGACY_AWS_REGION: 'ap-south-1',
  };
  const current = memberDocumentStorage('https://mountreality.s3.us-east-1.amazonaws.com/kyc_documents/a%20b.pdf', env);
  assert.equal(current.Key, 'kyc_documents/a b.pdf');
  assert.equal(current.profile, 'current');
  const earlier = memberDocumentStorage('https://aierpbytematrix.s3.ap-south-1.amazonaws.com/kyc_documents/old.jpg', env);
  assert.equal(earlier.profile, 'legacy');
  assert.deepEqual(earlier.credentials, { accessKeyId: 'current-key', secretAccessKey: 'current-secret' });
  assert.equal(memberDocumentStorage('https://unconfigured.s3.us-east-1.amazonaws.com/x.pdf', env), null);
  assert.equal(memberDocumentStorage('https://mountreality.s3.ap-south-1.amazonaws.com/x.pdf', env), null);
  assert.equal(memberDocumentStorage('https://mountreality.s3.us-east-1.amazonaws.com.evil.test/x.pdf', env), null);
});

test('returns a temporary signed link only for configured S3 document URLs', async () => {
  const previous = {
    AWS_S3_BUCKET_NAME: process.env.AWS_S3_BUCKET_NAME,
    AWS_REGION: process.env.AWS_REGION,
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  };
  Object.assign(process.env, {
    AWS_S3_BUCKET_NAME: 'mountreality', AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'test-key', AWS_SECRET_ACCESS_KEY: 'test-secret',
  });
  try {
    const url = await signMemberDocumentUrl('https://mountreality.s3.us-east-1.amazonaws.com/kyc_documents/card.pdf');
    assert.match(url, /X-Amz-Signature=/);
    assert.match(url, /X-Amz-Expires=3600/);
    assert.equal(await signMemberDocumentUrl('https://cloudinary.example/image.jpg'), 'https://cloudinary.example/image.jpg');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
