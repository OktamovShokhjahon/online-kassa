import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';
import { env } from '../config/env';
import { badRequest } from './errors';

/**
 * File storage behind a small interface. The default driver writes to local disk
 * (`UPLOAD_DIR`, served at `/uploads`); an S3-compatible driver can implement the same
 * `put` signature without touching callers.
 */
export interface StoredFile {
  url: string;
  key: string;
}

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

export const uploadRoot = () => path.resolve(env.UPLOAD_DIR);

export async function putFile(folder: string, buffer: Buffer, ext: string): Promise<StoredFile> {
  const name = `${crypto.randomBytes(12).toString('hex')}.${ext}`;
  const key = `${folder}/${name}`;
  const full = path.join(uploadRoot(), key);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, buffer);
  return { url: `/uploads/${key}`, key };
}

/** Sniff the magic bytes: never trust the client-supplied Content-Type. */
export function detectImageExt(buf: Buffer): string | null {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 12 && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'webp';
  return null;
}

const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2 MB (spec 5.4)

export const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
  fileFilter: (_req, file, cb) =>
    MIME_EXT[file.mimetype] ? cb(null, true) : cb(badRequest('FILE_TYPE_INVALID') as unknown as Error),
}).single('file');

export const spreadsheetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
}).single('file');

export async function storeImage(folder: string, buf: Buffer): Promise<StoredFile> {
  const ext = detectImageExt(buf);
  if (!ext) throw badRequest('FILE_TYPE_INVALID');
  return putFile(folder, buf, ext);
}

/** Wraps a multer middleware so size errors become friendly API errors. */
export function handleUpload(mw: ReturnType<typeof multer>['single'] extends (...a: any) => infer R ? R : never) {
  return (req: any, res: any, next: any) =>
    mw(req, res, (err: any) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') return next(badRequest('FILE_TOO_LARGE'));
      next(err);
    });
}
