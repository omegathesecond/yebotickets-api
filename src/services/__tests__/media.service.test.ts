const sendMock = jest.fn();

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: sendMock })),
  PutObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

import { uploadEventCoverImage } from '../media.service';
import { ApiError } from '../../middleware/error.middleware';

const ORIGINAL_ENV = process.env;

describe('uploadEventCoverImage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...ORIGINAL_ENV,
      R2_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
      R2_ACCESS_KEY_ID: 'key',
      R2_SECRET_ACCESS_KEY: 'secret',
      R2_BUCKET_NAME: 'yebotickets-media-dev',
      R2_PUBLIC_URL: 'https://dev-cdn.yebotickets.com',
    };
    sendMock.mockResolvedValue({});
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('uploads the buffer and returns the public CDN URL', async () => {
    const url = await uploadEventCoverImage(Buffer.from('fake-image'), 'image/png');
    expect(url).toMatch(/^https:\/\/dev-cdn\.yebotickets\.com\/event-covers\/[0-9a-f-]+\.png$/);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('strips a trailing slash from the public URL base', async () => {
    process.env.R2_PUBLIC_URL = 'https://dev-cdn.yebotickets.com/';
    const url = await uploadEventCoverImage(Buffer.from('fake-image'), 'image/jpeg');
    expect(url.startsWith('https://dev-cdn.yebotickets.com/event-covers/')).toBe(true);
  });

  it('rejects an unsupported mime type without calling R2', async () => {
    await expect(uploadEventCoverImage(Buffer.from('x'), 'application/pdf')).rejects.toThrow(
      ApiError
    );
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('fails loudly when R2 credentials are missing, never falling back silently', async () => {
    delete process.env.R2_ACCESS_KEY_ID;
    await expect(uploadEventCoverImage(Buffer.from('x'), 'image/png')).rejects.toThrow(ApiError);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('fails loudly when the bucket/public URL are missing', async () => {
    delete process.env.R2_BUCKET_NAME;
    await expect(uploadEventCoverImage(Buffer.from('x'), 'image/png')).rejects.toThrow(ApiError);
    expect(sendMock).not.toHaveBeenCalled();
  });
});
