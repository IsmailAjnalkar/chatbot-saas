/**
 * Secrets helpers — AES-256-GCM encryption for per-business LLM API keys
 * at rest, plus webhook-secret generation/hashing.
 *
 * Encryption key comes from the ENCRYPTION_KEY env var (any long random
 * string; it is SHA-256-hashed to a 32-byte key). If ENCRYPTION_KEY is not
 * set, encryptSecret/decryptSecret return null and the app runs with LLM
 * fallback disabled for encrypted keys (see lib/db.js decorateBusiness).
 *
 * Webhook secrets are stored as SHA-256 hashes only; the plaintext is shown
 * once at provision/regeneration time and never again.
 */
'use strict';

const crypto = require('crypto');

function getKey() {
  const raw = process.env.ENCRYPTION_KEY || '';
  if (!raw) return null;
  return crypto.createHash('sha256').update(raw, 'utf8').digest(); // 32 bytes
}

function encryptionEnabled() {
  return !!getKey();
}

/**
 * Encrypt a plaintext secret. Returns "v1.<iv hex>.<ciphertext hex>.<tag hex>" or null.
 */
function encryptSecret(plaintext) {
  const key = getKey();
  if (!key) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('hex'), ct.toString('hex'), tag.toString('hex')].join('.');
}

/**
 * Decrypt a blob produced by encryptSecret. Returns the plaintext, or null
 * when ENCRYPTION_KEY is missing/wrong or the blob is malformed/tampered.
 */
function decryptSecret(blob) {
  const key = getKey();
  if (!key || !blob) return null;
  try {
    const parts = String(blob).split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') return null;
    const [, ivH, ctH, tagH] = parts;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivH, 'hex'));
    decipher.setAuthTag(Buffer.from(tagH, 'hex'));
    const pt = Buffer.concat([decipher.update(Buffer.from(ctH, 'hex')), decipher.final()]);
    return pt.toString('utf8');
  } catch {
    return null; // wrong key, corrupted or tampered data
  }
}

function newWebhookSecret() {
  return 'wh_' + crypto.randomBytes(24).toString('hex');
}

function webhookSecretHash(secret) {
  return crypto.createHash('sha256').update(String(secret), 'utf8').digest('hex');
}

module.exports = { encryptionEnabled, encryptSecret, decryptSecret, newWebhookSecret, webhookSecretHash };
