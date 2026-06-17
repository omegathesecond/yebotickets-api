/**
 * Cloudflare R2 storage for YeboTickets.
 *
 * R2 is S3-compatible — we drive it via @aws-sdk/client-s3 with
 * `region: 'auto'` and the R2 endpoint URL. Each environment (dev / prod) has
 * its own bucket, configured via the R2_* env vars below and bound from
 * hiyebo Secret Manager (R2_ACCESS_KEY_ID[_DEV], R2_SECRET_ACCESS_KEY[_DEV], …).
 *
 * Currently used to host the ticket QR PNG at a PUBLIC URL so it can be attached
 * to the WhatsApp ticket message via YeboLink's `media_urls` (which accepts
 * public URLs, not buffers — see comms.service / ticket.service deliverTicketToBuyer).
 *
 * Mirrors the pattern in yebojobs/api/src/services/r2-storage.service.ts and
 * eneza/api/src/integrations/r2StorageService.ts. Fails loud (per CLAUDE.md):
 * a missing env var or an S3 error throws, so callers surface the failure
 * rather than pretending the upload worked.
 */
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
// Public URL prefix where R2 objects are served (custom domain, e.g.
// https://cdn.yebotickets.com, or the pub-XXX.r2.dev dev domain). Used to build
// the public URL we hand back after upload.
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;

export interface R2UploadInput {
  buffer: Buffer;
  mimeType: string;
  /** Object key (path inside the bucket). e.g. `ticket-qr/<eventId>/<code>.png` */
  key: string;
}

class R2StorageService {
  private client: S3Client | null = null;

  /**
   * Lazy init so boot doesn't fail where R2 isn't configured (local dev, CI).
   * The first upload from a request path throws a clear error if env vars are
   * missing — never a silent no-op.
   */
  private getClient(): S3Client {
    if (this.client) return this.client;
    if (!R2_ACCESS_KEY_ID) throw new Error('R2_ACCESS_KEY_ID env var is not set');
    if (!R2_SECRET_ACCESS_KEY) throw new Error('R2_SECRET_ACCESS_KEY env var is not set');
    if (!R2_ENDPOINT) throw new Error('R2_ENDPOINT env var is not set');
    if (!R2_BUCKET_NAME) throw new Error('R2_BUCKET_NAME env var is not set');
    if (!R2_PUBLIC_URL) throw new Error('R2_PUBLIC_URL env var is not set');

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

  /** Whether all R2 env vars are present (used to decide if an upload can be attempted). */
  isConfigured(): boolean {
    return Boolean(
      R2_ACCESS_KEY_ID &&
        R2_SECRET_ACCESS_KEY &&
        R2_ENDPOINT &&
        R2_BUCKET_NAME &&
        R2_PUBLIC_URL
    );
  }

  /**
   * Upload a buffer to R2 and return the PUBLIC HTTPS URL it is served at.
   * Throws on a missing env var or any S3 error so the caller can surface the
   * failure loudly (e.g. fall back to email delivery) instead of returning a
   * dead URL.
   */
  async upload({ buffer, mimeType, key }: R2UploadInput): Promise<string> {
    const client = this.getClient();
    await client.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET_NAME!,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
      })
    );
    return `${R2_PUBLIC_URL!.replace(/\/$/, '')}/${key}`;
  }
}

export const r2Storage = new R2StorageService();
