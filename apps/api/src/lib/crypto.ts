import crypto from 'node:crypto';
import { env } from '../config/env';

export const sha256 = (value: string): string =>
  crypto.createHash('sha256').update(value).digest('hex');

export const randomToken = (bytes = 32): string => crypto.randomBytes(bytes).toString('base64url');

/** Cryptographically random numeric code, zero padded (pairing codes, one-time links). */
export function randomDigits(length: number): string {
  let out = '';
  while (out.length < length) out += crypto.randomInt(0, 10).toString();
  return out;
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

const key = () =>
  /^[0-9a-fA-F]{64}$/.test(env.ENCRYPTION_KEY) ? Buffer.from(env.ENCRYPTION_KEY, 'hex') : crypto.createHash('sha256').update(env.ENCRYPTION_KEY).digest();

/** AES-256-GCM. Output: base64(iv | tag | ciphertext). */
export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

export function decrypt(payload: string): string {
  const buf = Buffer.from(payload, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

export function hmacSha256(secret: string, payload: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/** Generates a random password that satisfies the 8+ character policy. */
export function generatePassword(length = 12): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[crypto.randomInt(0, alphabet.length)];
  return out;
}
