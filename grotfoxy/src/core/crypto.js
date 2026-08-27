import crypto from 'node:crypto';
import config from '../config.js';

const ALGORITHM = 'aes-256-gcm';

/** Encrypt a secret for storage. Returns `v1:<iv>:<tag>:<ciphertext>` (base64url parts). */
export function encryptSecret(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, config.masterKey, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${enc.toString('base64url')}`;
}

export function decryptSecret(payload) {
  if (!payload) return '';
  const parts = String(payload).split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') return '';
  try {
    const [, iv, tag, data] = parts;
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      config.masterKey,
      Buffer.from(iv, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(data, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // A failed decrypt means the master key rotated or the row was tampered
    // with. Treat it as "no secret" rather than crashing the whole server.
    return '';
  }
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, expected] = parts;
  const expectedBuf = Buffer.from(expected, 'base64url');
  let derived;
  try {
    derived = crypto.scryptSync(String(password), Buffer.from(salt, 'base64url'), expectedBuf.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
    });
  } catch {
    return false;
  }
  return derived.length === expectedBuf.length && crypto.timingSafeEqual(derived, expectedBuf);
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Sessions and webhook tokens are looked up by digest so the DB never holds the raw value. */
export function tokenDigest(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
}

export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
