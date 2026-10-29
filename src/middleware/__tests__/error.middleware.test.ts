import { Request, Response, NextFunction } from 'express';
import { ApiError, errorHandler, notFound } from '../error.middleware';

describe('HTTP error reporting', () => {
  afterEach(() => jest.restoreAllMocks());

  it('keeps the QA root probe a visible 404 warning instead of a runtime error', () => {
    const log = jest.spyOn(console, 'log').mockImplementation();
    const error = jest.spyOn(console, 'error').mockImplementation();
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    notFound({ originalUrl: '/' } as Request, res as unknown as Response, next);
    errorHandler(next.mock.calls[0][0], {} as Request, res as unknown as Response, next);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, error: 'Not found - /' }));
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({ severity: 'WARNING', statusCode: 404, message: 'Not found - /' });
    expect(error).not.toHaveBeenCalled();
  });

  it.each([new Error('dependency unavailable'), new ApiError('dependency unavailable', 503)])(
    'continues reporting server failures through the error channel: %s',
    (failure) => {
      const log = jest.spyOn(console, 'log').mockImplementation();
      const error = jest.spyOn(console, 'error').mockImplementation();
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      errorHandler(failure, {} as Request, res as unknown as Response, jest.fn() as NextFunction);
      expect(error).toHaveBeenCalledWith(failure);
      expect(log).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(failure instanceof ApiError ? 503 : 500);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, error: failure.message }));
    }
  );
});
