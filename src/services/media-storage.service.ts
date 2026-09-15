/**
 * Cloudflare R2 storage for organizer-uploaded media (event cover images).
 *
 * R2 is S3-compatible — driven via @aws-sdk/client-s3 with `region: 'auto'`
 * and the R2 endpoint. Bucket + credentials come from the R2_* env vars
 * already bound to yebotickets-api-prod/-dev (see cloudbuild.yaml); this is
 * the first code in this repo to actually use them (previously only
 * provisioned, never wired to a real upload path).
 *
 * Mirrors the pattern in yebojobs/api/src/services/r2-storage.service.ts,
 * trimmed to just what a single-image upload needs (no presigning/multipart —
 * this repo only needs a small, synchronous multer-buffer upload).
 */
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
// Public URL prefix objects are served at (cdn.yebotickets.com / dev-cdn.yebotickets.com).
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;

interface UploadInput {
  buffer: Buffer;
  mimeType: string;
  /** Object key (path inside the bucket), e.g. `events/covers/<organizerId>/<uuid>.jpg`. */
  key: string;
}

class MediaStorageService {
  private client: S3Client | null = null;

  isConfigured(): boolean {
    return Boolean(R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_ENDPOINT && R2_BUCKET_NAME);
  }

  /** Lazy init so boot never fails in an environment without R2 configured. */
  private getClient(): S3Client {
    if (this.client) return this.client;
    if (!R2_ACCESS_KEY_ID) throw new Error('R2_ACCESS_KEY_ID env var not set');
    if (!R2_SECRET_ACCESS_KEY) throw new Error('R2_SECRET_ACCESS_KEY env var not set');
    if (!R2_ENDPOINT) throw new Error('R2_ENDPOINT env var not set');
    if (!R2_BUCKET_NAME) throw new Error('R2_BUCKET_NAME env var not set');

    this.client = new S3Client({
      region: 'auto',
      endpoint: R2_ENDPOINT,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
    });
    return this.client;
  }

  /**
   * Upload a buffer to R2. Returns the public HTTPS URL it's served at.
   * Throws on any S3 error so the caller returns a real 5xx instead of a
   * half-broken response (no silent fallback).
   */
  async upload({ buffer, mimeType, key }: UploadInput): Promise<string> {
    const client = this.getClient();
    await client.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET_NAME!,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
      })
    );

    if (R2_PUBLIC_URL) {
      return `${R2_PUBLIC_URL.replace(/\/$/, '')}/${key}`;
    }
    return `${R2_ENDPOINT!.replace(/\/$/, '')}/${R2_BUCKET_NAME}/${key}`;
  }
}

export const mediaStorage = new MediaStorageService();
