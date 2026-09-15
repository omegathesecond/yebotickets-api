import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../middleware/error.middleware';
import { uploadEventCoverImage } from '../services/media.service';

/**
 * POST /api/events/cover-image — organizer/admin uploads an event poster
 * image, which is stored in R2 and its public CDN URL handed back. No event
 * id is required: the create wizard needs a URL to set on the event BEFORE
 * the event exists, and the edit form reuses the same endpoint to replace an
 * existing cover. The returned URL is persisted by the normal
 * POST /api/events / PUT /api/events/:id call (both already accept
 * `coverImage` as a plain URL string).
 */
export const uploadEventCoverImageController = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const file = req.file;
    if (!file) {
      throw new ApiError('No image file provided (expected multipart field "coverImage")', 400);
    }

    const url = await uploadEventCoverImage(file.buffer, file.mimetype);

    res.status(201).json({
      success: true,
      data: { url },
    });
  } catch (error) {
    next(error);
  }
};
