const otplib = require('otplib');
const QRCode = require('qrcode');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { encrypt, decrypt } = require('../config/encryption');

function getJwtSecret() {
  const secret = process.env.POCKET_IT_JWT_SECRET;
  if (!secret) throw new Error('POCKET_IT_JWT_SECRET environment variable is required');
  return secret;
}

/**
 * Generate a new TOTP secret for a user.
 * Returns { secret (encrypted), otpauthUri, qrDataUri }
 */
async function generateTOTPSecret(username) {
  const secret = otplib.generateSecret();
  const otpauthUri = otplib.generateURI({ secret, issuer: 'Pocket IT', label: username });
  const qrDataUri = await QRCode.toDataURL(otpauthUri);
  return {
    secret: encrypt(secret),        // encrypted for DB storage
    rawSecret: secret,               // plaintext for verification during setup
    otpauthUri,
    qrDataUri
  };
}

/**
 * Verify a TOTP code against an encrypted secret.
 * epochTolerance: 30 = 1 step (30s) each direction for clock drift.
 */
async function verifyTOTP(encryptedSecret, code) {
  try {
    const secret = decrypt(encryptedSecret);
    const result = await otplib.verify({ token: code, secret, epochTolerance: 30 });
    return result.valid;
  } catch {
    return false;
  }
}

/**
 * Generate a temporary JWT (5-minute expiry) with a purpose field.
 * These tokens are rejected by requireIT/requireAdmin/Socket.IO.
 */
function generateTempToken(user, purpose) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, purpose },
    getJwtSecret(),
    { expiresIn: '5m' }
  );
}

/**
 * Verify a temp token and check its purpose matches.
 */
function verifyTempToken(token, expectedPurpose) {
  try {
    const decoded = jwt.verify(token, getJwtSecret());
    if (decoded.purpose !== expectedPurpose) return null;
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Generate 10 backup codes (8-char hex each).
 */
function generateBackupCodes() {
  const codes = [];
  for (let i = 0; i < 10; i++) {
    codes.push(crypto.randomBytes(4).toString('hex'));
  }
  return codes;
}

/**
 * Hash backup codes with bcrypt, then encrypt the JSON array.
 */
function hashBackupCodes(codes) {
  const hashed = codes.map(c => bcrypt.hashSync(c, 10));
  return encrypt(JSON.stringify(hashed));
}

/**
 * Verify a backup code. Returns { valid, remainingEncrypted } or { valid: false }.
 */
function verifyBackupCode(code, encryptedHashedCodes) {
  const hashed = JSON.parse(decrypt(encryptedHashedCodes));
  for (let i = 0; i < hashed.length; i++) {
    if (bcrypt.compareSync(code, hashed[i])) {
      // Remove used code
      hashed.splice(i, 1);
      return { valid: true, remainingEncrypted: encrypt(JSON.stringify(hashed)) };
    }
  }
  return { valid: false };
}

/**
 * Count remaining backup codes without exposing them.
 */
function getBackupCodeCount(encryptedCodes) {
  if (!encryptedCodes) return 0;
  try {
    const hashed = JSON.parse(decrypt(encryptedCodes));
    return hashed.length;
  } catch {
    return 0;
  }
}

module.exports = {
  generateTOTPSecret,
  verifyTOTP,
  generateTempToken,
  verifyTempToken,
  generateBackupCodes,
  hashBackupCodes,
  verifyBackupCode,
  getBackupCodeCount
};
