import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  /** Public web origin; used for CORS and links. Any domain works, nothing is hardcoded. */
  WEB_ORIGIN: z.string().default('http://localhost:3000'),
  /** Public URL of the API (used in OpenAPI docs and agent downloads). Render provides RENDER_EXTERNAL_URL. */
  PUBLIC_API_URL: z.string().default(process.env.RENDER_EXTERNAL_URL ?? 'http://localhost:4000'),
  MONGO_URI: z.string().default('mongodb://127.0.0.1:27017/onlinekass?replicaSet=rs0'),
  /** Database used when MONGO_URI names none (e.g. an Atlas URI ending in ".net/"). */
  MONGO_DB_NAME: z.string().default('onlinekass'),
  REDIS_URL: z.string().optional(),
  JWT_ACCESS_SECRET: z.string().min(16).default('dev-access-secret-change-me-please'),
  JWT_REFRESH_SECRET: z.string().min(16).default('dev-refresh-secret-change-me-please'),
  /**
   * Encrypts fiscal credentials and agent tokens at rest: 64 hex characters (32 bytes), or any random
   * string of 32+ characters (hashed to 32 bytes) such as the value a host like Render generates.
   */
  ENCRYPTION_KEY: z
    .string()
    .min(32)
    .default('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().default(15 * 60),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().default(30),
  BCRYPT_COST: z.coerce.number().int().min(4).max(15).default(12),
  COOKIE_SECURE: bool.optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_BOT_USERNAME: z.string().optional(),
  SUPERADMIN_TELEGRAM_CHAT_ID: z.string().optional(),
  SUPERADMIN_LOGIN: z.string().optional(),
  SUPERADMIN_PASSWORD: z.string().optional(),
  SUPERADMIN_FULL_NAME: z.string().default('Platform Owner'),
  UPLOAD_DIR: z.string().default('./uploads'),
  S3_ENDPOINT: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  RUN_WORKERS: bool.default('true'),
  SENTRY_DSN: z.string().optional(),
});

const parsed = schema.parse(process.env);

if (parsed.NODE_ENV === 'production') {
  const insecure = [
    parsed.JWT_ACCESS_SECRET.startsWith('dev-'),
    parsed.JWT_REFRESH_SECRET.startsWith('dev-'),
    parsed.ENCRYPTION_KEY === '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
  ];
  if (insecure.some(Boolean)) {
    throw new Error('Refusing to start in production with default secrets. Set JWT_*_SECRET and ENCRYPTION_KEY.');
  }
}

export const env = {
  ...parsed,
  isProd: parsed.NODE_ENV === 'production',
  isTest: parsed.NODE_ENV === 'test',
  cookieSecure: parsed.COOKIE_SECURE ?? parsed.NODE_ENV === 'production',
};
export type Env = typeof env;
