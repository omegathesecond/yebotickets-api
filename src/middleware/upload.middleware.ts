/**
 * Multer config for organizer image uploads (event cover images today). Memory
 * storage — files are small (capped below) and go straight to R2, never to
 * local disk.
 */
import multer from 'multer';

export const MAX_COVER_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB

export const ALLOWED_IMAGE_MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export const coverImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_COVER_IMAGE_BYTES },
});
