import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { JobRecord } from './job-store';
import { getJobAccessTokenEncryptionKey } from './server/env';

const ENCRYPTED_TOKEN_VERSION = 'v1';
const AES_KEY_LENGTH = 32;
const AES_IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getEncryptionKey() {
  const secret = getJobAccessTokenEncryptionKey();
  if (!secret) {
    throw new Error('Falta JOB_ACCESS_TOKEN_ENCRYPTION_KEY en el entorno del servidor.');
  }

  return createHash('sha256').update(secret, 'utf8').digest().subarray(0, AES_KEY_LENGTH);
}

export function generateJobAccessToken() {
  return randomBytes(32).toString('base64url');
}

export function hashJobAccessToken(token: string) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function encryptJobAccessToken(token: string) {
  const iv = randomBytes(AES_IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    ENCRYPTED_TOKEN_VERSION,
    iv.toString('base64url'),
    authTag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function decryptJobAccessToken(encryptedToken: string) {
  const [version, encodedIv, encodedAuthTag, encodedCiphertext] = encryptedToken.split('.');
  if (version !== ENCRYPTED_TOKEN_VERSION || !encodedIv || !encodedAuthTag || !encodedCiphertext) {
    throw new Error('Token cifrado inválido.');
  }

  const iv = Buffer.from(encodedIv, 'base64url');
  const authTag = Buffer.from(encodedAuthTag, 'base64url');
  const ciphertext = Buffer.from(encodedCiphertext, 'base64url');
  if (iv.length !== AES_IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH || ciphertext.length === 0) {
    throw new Error('Token cifrado inválido.');
  }

  const decipher = createDecipheriv('aes-256-gcm', getEncryptionKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function verifyJobAccess(job: Pick<JobRecord, 'accessTokenHash'>, suppliedToken: string | null | undefined) {
  if (!suppliedToken || !job.accessTokenHash) {
    return false;
  }

  const expectedHash = Buffer.from(job.accessTokenHash, 'hex');
  const suppliedHash = Buffer.from(hashJobAccessToken(suppliedToken), 'hex');
  return expectedHash.length === suppliedHash.length && timingSafeEqual(expectedHash, suppliedHash);
}
