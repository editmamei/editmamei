import { describe, it, expect } from 'vitest';
import { createCipheriv, randomBytes } from 'node:crypto';
import {
  decryptModule,
  encryptModule,
  sha256Hex,
  ModuleCryptoError,
} from '@editmamei/delivery/crypto.ts';

// Encrypt the way the delivery `pack:module` encryptor (and go-core's gcm.Seal)
// does: IV(12) || ciphertext || tag(16), AES-256-GCM.
function packModule(plaintext: Buffer, key: Buffer): Uint8Array {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return new Uint8Array(Buffer.concat([iv, ct, tag]));
}

describe('decryptModule', () => {
  const key = randomBytes(32);
  const keyB64 = key.toString('base64');
  const plaintext = Buffer.from(JSON.stringify({ s1: 'fragment body', s2: 'another' }));

  it('round-trips a packed module back to plaintext', () => {
    const blob = packModule(plaintext, key);
    const out = decryptModule(blob, keyB64);
    expect(out.equals(plaintext)).toBe(true);
  });

  it('throws on a wrong content key (GCM auth tag failure)', () => {
    const blob = packModule(plaintext, key);
    const wrong = randomBytes(32).toString('base64');
    expect(() => decryptModule(blob, wrong)).toThrow(ModuleCryptoError);
  });

  it('throws on a non-32-byte key', () => {
    const blob = packModule(plaintext, key);
    expect(() => decryptModule(blob, randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
  });

  it('throws on a blob shorter than IV + tag', () => {
    expect(() => decryptModule(new Uint8Array(10), keyB64)).toThrow(/shorter than/);
  });
});

describe('encryptModule', () => {
  const keyB64 = randomBytes(32).toString('base64');
  const plaintext = Buffer.from('the quick brown fox jumps over the lazy dog');

  it('round-trips through decryptModule (its inverse)', () => {
    const blob = encryptModule(plaintext, keyB64);
    expect(decryptModule(blob, keyB64).equals(plaintext)).toBe(true);
  });

  it('emits IV(12) || ciphertext || tag(16)', () => {
    const blob = encryptModule(plaintext, keyB64);
    expect(blob.length).toBe(12 + plaintext.length + 16);
  });

  it('uses a fresh IV per call (ciphertext differs for the same input)', () => {
    const a = Buffer.from(encryptModule(plaintext, keyB64));
    const b = Buffer.from(encryptModule(plaintext, keyB64));
    expect(a.equals(b)).toBe(false);
  });

  it('throws on a non-32-byte key', () => {
    expect(() => encryptModule(plaintext, randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
  });
});

describe('sha256Hex', () => {
  it('matches a known digest', () => {
    expect(sha256Hex(Buffer.from('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });
});
