import { Request, Response } from 'express';

jest.mock('../../services/media-storage.service', () => ({
  mediaStorage: {
    isConfigured: jest.fn(),
    upload: jest.fn(),
  },
}));

import { mediaStorage } from '../../services/media-storage.service';
import { uploadEventCoverImageController } from '../media.controller';

const isConfiguredMock = mediaStorage.isConfigured as jest.Mock;
const uploadMock = mediaStorage.upload as jest.Mock;

const buildRes = () => {
  const res: Partial<Response> = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res as Response;
};

beforeEach(() => {
  isConfiguredMock.mockReset();
  uploadMock.mockReset();
  isConfiguredMock.mockReturnValue(true);
});

describe('uploadEventCoverImageController', () => {
  it('rejects an unauthenticated caller with 401 and never touches R2', async () => {
    const req = { file: undefined } as unknown as Request;
    const next = jest.fn();

    await uploadEventCoverImageController(req, buildRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 401 });
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('fails loudly (503, no silent fallback) when R2 is not configured', async () => {
    isConfiguredMock.mockReturnValue(false);
    const req = {
      user: { id: 'org-1', role: 'organizer' },
      file: { buffer: Buffer.from('x'), mimetype: 'image/png' },
    } as unknown as Request;
    const next = jest.fn();

    await uploadEventCoverImageController(req, buildRes(), next);

    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 503 });
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('rejects when no file is present on the request', async () => {
    const req = {
      user: { id: 'org-1', role: 'organizer' },
      file: undefined,
    } as unknown as Request;
    const next = jest.fn();

    await uploadEventCoverImageController(req, buildRes(), next);

    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 400 });
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('rejects an unsupported mime type with 415 and never uploads', async () => {
    const req = {
      user: { id: 'org-1', role: 'organizer' },
      file: { buffer: Buffer.from('x'), mimetype: 'application/pdf' },
    } as unknown as Request;
    const next = jest.fn();

    await uploadEventCoverImageController(req, buildRes(), next);

    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 415 });
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('uploads a valid image scoped under the caller\'s own organizer id and returns the public URL', async () => {
    uploadMock.mockResolvedValue('https://cdn.yebotickets.com/events/covers/org-1/some-uuid.jpg');
    const res = buildRes();
    const req = {
      user: { id: 'org-1', role: 'organizer' },
      file: { buffer: Buffer.from('fake-image-bytes'), mimetype: 'image/jpeg' },
    } as unknown as Request;

    await uploadEventCoverImageController(req, res, jest.fn());

    expect(uploadMock).toHaveBeenCalledTimes(1);
    const arg = uploadMock.mock.calls[0][0];
    expect(arg.key).toMatch(/^events\/covers\/org-1\//);
    expect(arg.mimeType).toBe('image/jpeg');
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { url: 'https://cdn.yebotickets.com/events/covers/org-1/some-uuid.jpg' },
    });
  });

  it('propagates an R2 upload failure to next() instead of returning a fake success', async () => {
    uploadMock.mockRejectedValue(new Error('R2 PutObject failed'));
    const req = {
      user: { id: 'org-1', role: 'organizer' },
      file: { buffer: Buffer.from('x'), mimetype: 'image/png' },
    } as unknown as Request;
    const next = jest.fn();

    await uploadEventCoverImageController(req, buildRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
    expect((next.mock.calls[0][0] as Error).message).toBe('R2 PutObject failed');
  });
});
