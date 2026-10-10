import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import crypto from 'crypto';

// =============================================================================
// Cloudflare R2 Storage Adapter (via AWS S3 SDK)
// =============================================================================

function getR2Client(): S3Client {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error('R2 credentials (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY) are not configured');
  }

  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });
}

function getBucketName(): string {
  const bucket = process.env.R2_BUCKET_NAME;
  if (!bucket) {
    throw new Error('R2_BUCKET_NAME is not configured');
  }
  return bucket;
}

/**
 * Generates an opaque, randomized object key: uploads/<userId>/<random id>.<ext>
 * Never includes user-supplied or raw file names.
 */
export function generateStorageKey(userId: string, mimeType: string): string {
  const ext = mimeType === 'image/png' ? 'png' : 'jpg';
  const randomId = crypto.randomUUID();
  return `uploads/${userId}/${randomId}.${ext}`;
}

/**
 * Uploads an object buffer to Cloudflare R2.
 */
export async function putObject(
  key: string,
  body: Buffer | Uint8Array,
  contentType: string
): Promise<void> {
  const client = getR2Client();
  const bucket = getBucketName();

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
}

/**
 * Downloads raw object bytes from Cloudflare R2 as a Buffer.
 */
export async function getObjectBytes(key: string): Promise<Buffer> {
  const client = getR2Client();
  const bucket = getBucketName();

  const response = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  );

  if (!response.Body) {
    throw new Error(`Failed to retrieve body for R2 object: ${key}`);
  }

  const byteArray = await response.Body.transformToByteArray();
  return Buffer.from(byteArray);
}

/**
 * Deletes an object from Cloudflare R2.
 */
export async function deleteObject(key: string): Promise<void> {
  const client = getR2Client();
  const bucket = getBucketName();

  await client.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  );
}
