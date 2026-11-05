import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;

/** scrypt 密码哈希，格式 scrypt$N$r$p$salt$hash */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64url');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64url'), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const aesKey = createHash('sha256')
  .update('tv2-aes:' + config.secret)
  .digest();

/** AES-256-GCM 加密（用于存储第三方模型 API Key） */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), data.toString('base64url')].join('.');
}

export function decrypt(payload: string | null | undefined): string {
  if (!payload) return '';
  const [v, ivB64, tagB64, dataB64] = payload.split('.');
  if (v !== 'v1') return '';
  try {
    const decipher = createDecipheriv('aes-256-gcm', aesKey, Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

/** 密钥只显示首尾：sk-abc…wxyz */
export function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 10) return key.slice(0, 2) + '••••';
  return key.slice(0, 5) + '••••••' + key.slice(-4);
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** 生成邀请码 / 课堂码，不用 I、O、0、1 这类容易看错的字符 */
export function readableCode(len = 6, digitsOnly = false): string {
  const alphabet = digitsOnly ? '0123456789' : 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}
