import type { RequestHandler } from "express";
import multer from "multer";

export const MAX_UPLOAD_SIZE_BYTES = 100 * 1024 * 1024;
export const MAX_UPLOAD_SIZE_MB = Math.round(
  MAX_UPLOAD_SIZE_BYTES / (1024 * 1024),
);

const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_SIZE_BYTES,
    files: 1,
  },
});

let activeUploads = 0;

function maxConcurrentUploads(): number {
  const parsed = Number.parseInt(process.env.MAX_CONCURRENT_UPLOADS ?? "3", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3;
}

export const uploadConcurrencyLimit: RequestHandler = (_req, res, next) => {
  const max = maxConcurrentUploads();
  if (activeUploads >= max) {
    return void res.status(429).json({
      detail: "Too many uploads in progress. Please retry shortly.",
    });
  }

  activeUploads++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeUploads = Math.max(0, activeUploads - 1);
  };
  res.on("finish", release);
  res.on("close", release);
  next();
};

export function singleFileUpload(fieldName: string): RequestHandler {
  return (req, res, next) => {
    memoryUpload.single(fieldName)(req, res, (err) => {
      if (!err) return next();

      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return void res.status(413).json({
            detail: `File too large. Maximum size is ${MAX_UPLOAD_SIZE_MB} MB.`,
          });
        }
        return void res.status(400).json({
          detail: `Upload failed: ${err.message}`,
        });
      }

      return next(err);
    });
  };
}
