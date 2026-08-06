/**
 * AES-256-GCM decrypt + integrity helpers for fetched Pro modules.
 *
 * The artifact layout is `IV(12) || ciphertext || tag(16)` — exactly what the
 * delivery `pack:module` encryptor emits and what go-core's decryptTemplates
 * consumes (Go's gcm.Seal yields `nonce || ct || tag`). The host verifies the
 * artifact's sha256 against the manifest before trusting it, and can optionally
 * decrypt-verify with the content key so a key/artifact mismatch fails fast at
 * install time rather than silently leaving Pro tools dark after a restart.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const IV_LEN = 12;
const TAG_LEN = 16;

/** Lowercase hex SHA-256 of the raw artifact bytes (the whole IV||ct||tag blob). */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export class ModuleCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModuleCryptoError';
  }
}

/**
 * Encrypt a module artifact with the base64 content key (32 raw bytes), emitting
 * the same `IV(12) || ciphertext || tag(16)` layout `decryptModule` consumes.
 * The inverse of `decryptModule`; mirrors the delivery `pack:module` encryptor
 * so the host can produce local/dev artifacts (build:pro-module, tests) with the
 * identical primitive the server uses. A fresh random IV per call.
 */
export function encryptModule(plaintext: Uint8Array, keyB64: string): Uint8Array {
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) {
    throw new ModuleCryptoError(`content key must be 32 bytes (got ${key.length})`);
  }
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, tag]);
}

/**
 * Decrypt a module artifact with the base64 content key (32 raw bytes). Throws
 * ModuleCryptoError on a malformed blob, bad key length, or a failed GCM auth
 * tag (wrong key / tampered bytes). Returns the plaintext (the JSON fragment
 * catalog go-core expects).
 */
export function decryptModule(blob: Uint8Array, keyB64: string): Buffer {
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) {
    throw new ModuleCryptoError(`content key must be 32 bytes (got ${key.length})`);
  }
  if (blob.length < IV_LEN + TAG_LEN) {
    throw new ModuleCryptoError('artifact shorter than IV + tag');
  }
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const ciphertext = blob.subarray(IV_LEN, blob.length - TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (err) {
    throw new ModuleCryptoError(
      `module decrypt failed (wrong content key or corrupt artifact): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}
