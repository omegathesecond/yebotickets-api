import multer from 'multer';
import { Request, Response, NextFunction } from 'express';
import { ApiError } from './error.middleware';
import { ALLOWED_IMAGE_MIME_TYPES } from '../services/media.service';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB

/**
 * Memory storage: the file buffer is streamed straight to R2 in the
 * controller, never written to local disk (Cloud Run's filesystem is
 * ephemeral/read-mostly anyway).
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_IMAGE_MIME_TYPES.includes(file.mimetype)) {
      cb(new ApiError(`Unsupported image type: ${file.mimetype}`, 400));
      return;
    }
    cb(null, true);
  },
}).single('coverImage');

/**
 * Wraps multer so its errors (oversized file, wrong field, etc.) reach the
 * shared error handler as a proper 400 ApiError instead of falling through to
 * a bare 500 — multer.MulterError doesn't carry a statusCode of its own.
 */
export const uploadEventCoverImageMiddleware = (req: Request, res: Response, next: NextFunction) => {
  upload(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof ApiError) return next(err);
    if (err instanceof multer.MulterError) {
      return next(new ApiError(`Upload failed: ${err.message}`, 400));
    }
    next(err);
  });
};
