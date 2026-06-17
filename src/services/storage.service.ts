/**
 * Cloudflare R2 object storage for YeboTickets (`r2Storage`).
 *
 * R2 speaks the S3 API, so we sign requests with SigV4 via `aws4fetch` (a
 * zero-dependency wrapper over the native `fetch` this codebase already uses in
 * yebolink.client.ts) rather than pulling in the full AWS SDK for one PUT.
 *
 * Primary use: upload the ticket QR PNG to a PUBLIC R2 URL so it can be attached
 * to the WhatsApp ticket message via YeboLink `media_urls` (which takes public
 * URLs, not buffers — see comms.service / yebolink.client).
 *
 * Fails loud per CLAUDE.md — `upload*` throws if R2 is not configured rather
 * than returning a fake/placeholder URL or silently no-opping. Callers that can
 * proceed without R2 (e.g. ticket delivery, where the QR is also returned inline
 * in the API response) feature-detect with `isConfigured()` first.
 */

import { AwsClient } from 'aws4fetch';

/** The five env vars required for R2 uploads to work. */
interface R2Config {
  accessKeyId: string;
  secretAccessKey: string;
  /** S3 API endpoint, e.g. https://<account>.r2.cloudflarestorage.com */
  endpoint: string;
  bucketName: string;
  /** Public CDN base URL the object is reachable at, e.g. https://cdn.yebotickets.com */
  publicUrl: string;
}

/** True only for a present, non-whitespace string. */
const nonEmpty = (value: string | undefined): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/**
 * Read R2 config from the environment. Returns null (not a partial object) when
 * ANY required var is missing/empty, so callers get an all-or-nothing answer.
 * Read fresh on every call so /health reflects the live runtime binding.
 */
const readConfig = (): R2Config | null => {
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const endpoint = process.env.R2_ENDPOINT;
  const bucketName = process.env.R2_BUCKET_NAME;
  const publicUrl = process.env.R2_PUBLIC_URL;

  if (
    !nonEmpty(accessKeyId) ||
    !nonEmpty(secretAccessKey) ||
    !nonEmpty(endpoint) ||
    !nonEmpty(bucketName) ||
    !nonEmpty(publicUrl)
  ) {
    return null;
  }

  return {
    accessKeyId: accessKeyId.trim(),
    secretAccessKey: secretAccessKey.trim(),
    endpoint: endpoint.trim().replace(/\/$/, ''),
    bucketName: bucketName.trim(),
    publicUrl: publicUrl.trim().replace(/\/$/, ''),
  };
};

class R2Storage {
  /** Lazily-built SigV4 signer, rebuilt if credentials change between calls. */
  private client: AwsClient | null = null;
  private clientKey: string | null = null;

  /**
   * Whether every required R2 env var is present and non-empty. Surfaced on
   * GET /health as `r2.configured` so a deployed revision can be verified to
   * have the R2 secrets actually bound.
   */
  isConfigured(): boolean {
    return readConfig() !== null;
  }

  /** Resolve config or throw loudly — never proceed with a partial/fake config. */
  private requireConfig(): R2Config {
    const config = readConfig();
    if (!config) {
      throw new Error(
        'R2 storage is not configured: one or more of R2_ACCESS_KEY_ID, ' +
          'R2_SECRET_ACCESS_KEY, R2_ENDPOINT, R2_BUCKET_NAME, R2_PUBLIC_URL is missing'
      );
    }
    return config;
  }

  private getClient(config: R2Config): AwsClient {
    const key = `${config.accessKeyId}:${config.secretAccessKey}`;
    if (!this.client || this.clientKey !== key) {
      this.client = new AwsClient({
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        service: 's3',
        region: 'auto', // R2 ignores region but SigV4 requires a value
      });
      this.clientKey = key;
    }
    return this.client;
  }

  /**
   * Upload an object to R2 and return its public URL.
   * @param key Object key (path within the bucket), e.g. `tickets/qr/ABC123.png`
   * @param body Raw bytes to store
   * @param contentType MIME type to set on the object
   * @returns Public URL the object is reachable at (`${R2_PUBLIC_URL}/${key}`)
   * @throws if R2 is not configured, or if R2 rejects the upload
   */
  async upload(key: string, body: Buffer, contentType: string): Promise<string> {
    const config = this.requireConfig();
    const client = this.getClient(config);
    const objectUrl = `${config.endpoint}/${config.bucketName}/${key}`;

    const res = await client.fetch(objectUrl, {
      method: 'PUT',
      // Re-wrap as a plain ArrayBuffer-backed view so it satisfies the DOM
      // BodyInit type (a Node Buffer's backing buffer is ArrayBufferLike).
      body: new Uint8Array(body),
      headers: { 'Content-Type': contentType },
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`R2 upload failed for ${key}: ${res.status} ${res.statusText} ${detail}`.trim());
    }

    return `${config.publicUrl}/${key}`;
  }

  /**
   * Upload a ticket QR PNG keyed by its unique code and return the public URL
   * (used as a WhatsApp `media_urls` attachment). Throws if R2 is unconfigured.
   */
  async uploadTicketQr(uniqueCode: string, png: Buffer): Promise<string> {
    return this.upload(`tickets/qr/${uniqueCode}.png`, png, 'image/png');
  }
}

/** Shared singleton — import `{ r2Storage }`. */
export const r2Storage = new R2Storage();
