import { Request, Response, NextFunction } from 'express';
import { MulterError } from 'multer';

export class ApiError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
    Error.captureStackTrace(this, this.constructor);
  }
}

/** Multer's own error class has no statusCode — map its codes to real HTTP statuses. */
const multerStatusCode = (err: MulterError): number =>
  err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;

export const errorHandler = (
  err: Error | ApiError,
  _req: Request,
  res: Response,
  _next: NextFunction
) => {
  console.error(err);

  const statusCode =
    (err as ApiError).statusCode || (err instanceof MulterError ? multerStatusCode(err) : 500);
  const message = err.message || 'Internal Server Error';

  res.status(statusCode).json({
    success: false,
    error: message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
  });
};

export const notFound = (req: Request, res: Response, next: NextFunction) => {
  const error = new ApiError(`Not found - ${req.originalUrl}`, 404);
  next(error);
}; 