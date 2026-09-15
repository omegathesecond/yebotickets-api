import { Request, Response } from 'express';

jest.mock('../../services/media.service', () => ({
  uploadEventCoverImage: jest.fn(),
}));

import { uploadEventCoverImage } from '../../services/media.service';
import { uploadEventCoverImageController } from '../upload.controller';

const uploadEventCoverImageMock = uploadEventCoverImage as jest.Mock;

const buildRes = () => {
  const res: Partial<Response> = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res as Response;
};

beforeEach(() => {
  uploadEventCoverImageMock.mockReset();
});

describe('uploadEventCoverImageController', () => {
  it('uploads the file and returns its public URL', async () => {
    uploadEventCoverImageMock.mockResolvedValue('https://cdn.yebotickets.com/event-covers/abc.png');
    const req = {
      file: { buffer: Buffer.from('img'), mimetype: 'image/png' },
    } as unknown as Request;
    const res = buildRes();
    const next = jest.fn();

    await uploadEventCoverImageController(req, res, next);

    expect(uploadEventCoverImageMock).toHaveBeenCalledWith(Buffer.from('img'), 'image/png');
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { url: 'https://cdn.yebotickets.com/event-covers/abc.png' },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects with a 400 ApiError when no file is provided, never inventing a fallback URL', async () => {
    const req = {} as Request;
    const res = buildRes();
    const next = jest.fn();

    await uploadEventCoverImageController(req, res, next);

    expect(uploadEventCoverImageMock).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(400);
  });

  it('propagates a storage failure via next() instead of swallowing it', async () => {
    uploadEventCoverImageMock.mockRejectedValue(new Error('R2 unreachable'));
    const req = {
      file: { buffer: Buffer.from('img'), mimetype: 'image/png' },
    } as unknown as Request;
    const res = buildRes();
    const next = jest.fn();

    await uploadEventCoverImageController(req, res, next);

    expect(res.json).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});
