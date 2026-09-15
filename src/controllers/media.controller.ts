import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { ApiError } from '../middleware/error.middleware';
import { AuthenticatedRequest } from '../types/auth';
import { mediaStorage } from '../services/media-storage.service';
import { ALLOWED_IMAGE_MIME_TO_EXT } from '../middleware/upload.middleware';

/**
 * POST /api/events/cover-image — organizer/admin uploads an event poster
 * image, gets back the public CDN URL to save as `Event.coverImage`.
 *
 * Deliberately decoupled from a specific event id: the create wizard has no
 * event id yet when the organizer picks the poster, and the edit form reuses
 * the exact same call. The event itself is only ever created/updated through
 * the existing organizer-owned POST/PUT /api/events(/:id) endpoints, which
 * already enforce ownership — this endpoint just needs the caller to be an
 * authenticated organizer/admin, and stores the file under their own R2
 * prefix so nothing here bypasses that check.
 */
export const uploadEventCoverImageController = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user || !authReq.user.id) {
      throw new ApiError('User not authenticated', 401);
    }

    if (!mediaStorage.isConfigured()) {
      throw new ApiError('Image upload is not configured on this server', 503);
    }

    const file = req.file;
    if (!file) {
      throw new ApiError('No image file uploaded (expected field "file")', 400);
    }

    const ext = ALLOWED_IMAGE_MIME_TO_EXT[file.mimetype];
    if (!ext) {
      throw new ApiError(
        `Unsupported image type: ${file.mimetype || 'unknown'}. Use JPEG, PNG, WEBP, or GIF.`,
        415
      );
    }

    const key = `events/covers/${authReq.user.id}/${crypto.randomUUID()}.${ext}`;
    const url = await mediaStorage.upload({
      buffer: file.buffer,
      mimeType: file.mimetype,
      key,
    });

    res.status(201).json({
      success: true,
      data: { url },
    });
  } catch (error) {
    next(error);
  }
};
