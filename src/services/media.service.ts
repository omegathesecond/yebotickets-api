import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { ApiError } from '../middleware/error.middleware';

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export const ALLOWED_IMAGE_MIME_TYPES = Object.keys(EXTENSION_BY_MIME);

let cachedClient: S3Client | null = null;

/**
 * R2 is S3-compatible, so the AWS SDK's S3Client talks to it directly via the
 * account-scoped endpoint. Built lazily (not at import time) so a missing env
 * var fails loudly on the first upload attempt rather than crashing server
 * boot for an unrelated request.
 */
const getR2Client = (): S3Client => {
  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new ApiError('Image storage is not configured (missing R2 credentials)', 503);
  }

  if (!cachedClient) {
    cachedClient = new S3Client({
      region: 'auto',
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
    });
  }
  return cachedClient;
};

/**
 * Upload an event cover image buffer to the yebotickets R2 bucket and return
 * its public CDN URL. Throws (never swallows) on any storage misconfiguration
 * or upload failure — callers must surface this to the organizer, not fall
 * back to a placeholder.
 */
export const uploadEventCoverImage = async (
  buffer: Buffer,
  mimeType: string
): Promise<string> => {
  const bucket = process.env.R2_BUCKET_NAME;
  const publicUrl = process.env.R2_PUBLIC_URL;
  if (!bucket || !publicUrl) {
    throw new ApiError('Image storage is not configured (missing R2 bucket/public URL)', 503);
  }

  const extension = EXTENSION_BY_MIME[mimeType];
  if (!extension) {
    throw new ApiError(`Unsupported image type: ${mimeType}`, 400);
  }

  const key = `event-covers/${randomUUID()}.${extension}`;
  const client = getR2Client();

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
    })
  );

  return `${publicUrl.replace(/\/+$/, '')}/${key}`;
};
