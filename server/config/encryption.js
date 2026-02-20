const crypto = require('node:crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * Derive a 256-bit key from a passphrase.
 * Uses the ADMIN_TOKEN or a dedicated ENCRYPTION_KEY env var.
 */
function getEncryptionKey() {
  const passphrase = process.env.POCKET_IT_ENCRYPTION_KEY || process.env.POCKET_IT_JWT_SECRET;
  if (!passphrase) {
    throw new Error('No encryption key available (set POCKET_IT_ENCRYPTION_KEY or POCKET_IT_JWT_SECRET)');
  }
  return crypto.scryptSync(passphrase, 'pocket-it-settings', 32);
}

/**
 * Encrypt a plaintext string. Returns base64-encoded "iv:ciphertext:tag".
 */
function encrypt(plaintext) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString('base64')}:${encrypted.toString('base64')}:${tag.toString('base64')}`;
}

/**
 * Decrypt an encrypted string. Expects "enc:iv:ciphertext:tag" format.
 * Returns plaintext. If input doesn't start with "enc:", returns as-is (legacy plaintext).
 */
function decrypt(encryptedStr) {
  if (!encryptedStr || !encryptedStr.startsWith('enc:')) {
    return encryptedStr; // legacy plaintext, return as-is
  }
  const parts = encryptedStr.split(':');
  if (parts.length !== 4) return encryptedStr;

  const key = getEncryptionKey();
  const iv = Buffer.from(parts[1], 'base64');
  const encrypted = Buffer.from(parts[2], 'base64');
  const tag = Buffer.from(parts[3], 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted, undefined, 'utf8') + decipher.final('utf8');
}

module.exports = { encrypt, decrypt };
