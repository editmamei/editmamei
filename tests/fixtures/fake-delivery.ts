/**
 * A fake `editmamei-delivery` service for tests that need `provisionModules` to
 * run its full fetch → verify → decrypt → install path WITHOUT real network.
 *
 * `fakeDelivery(version)` mints an ephemeral Ed25519 signer, packs a minimal
 * encrypted Pro-module artifact, signs (sku, version, sha256), and returns a
 * `DeliveryFetch` serving the manifest/artifact/key endpoints plus the matching
 * `pubB64` — pass that as `provisionModules({ signingKeys: [pubB64] })` so the real
 * signature-verification runs. The packed handlers are a trivial `export default
 * {}`: callers here only assert the install landed on disk (the module loads on the
 * NEXT restart), never import it in-process.
 *
 * A richer variant (request-call tracking, an embedded binary, a `sign:false`
 * refusal path) lives inline in tests/delivery/provision.test.ts — that file
 * predates this fixture and exercises delivery internals; this shared helper
 * covers the "just make provisioning succeed" cases.
 */

import { randomBytes, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { packBundle, type BundleFile } from '@editmamei/delivery/bundle.ts';
import { sha256Hex } from '@editmamei/delivery/crypto.ts';
import { moduleSigMessage } from '@editmamei/delivery/signing.ts';
import type { DeliveryFetch, DeliveryResponse } from '@editmamei/delivery/client.ts';

/** A localhost delivery config for the fake fetch (any non-empty baseUrl works). */
export const fakeDeliveryConfig = { baseUrl: 'http://localhost:8787' };

export function jsonRes(status: number, body: unknown): DeliveryResponse {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer,
  };
}

export function bytesRes(bytes: Uint8Array): DeliveryResponse {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return { ok: true, status: 200, text: async () => '', arrayBuffer: async () => ab };
}

export interface FakeDelivery {
  /** Inject as `provisionModules({ fetchImpl })`. */
  fetchImpl: DeliveryFetch;
  /** The public half of the ephemeral signer — pass as `{ signingKeys: [pubB64] }`. */
  pubB64: string;
}

/** Build a fake delivery service that serves ONE entitled Pro module at `version`. */
export function fakeDelivery(version: string): FakeDelivery {
  const key = randomBytes(32);
  const files: BundleFile[] = [
    { name: 'pro-handlers.mjs', data: Buffer.from('export default {}') },
    { name: 'manifest.json', data: Buffer.from(JSON.stringify({ sku: 'pro', version })) },
  ];
  const blob = packBundle(files, key.toString('base64'));
  const sha256 = sha256Hex(blob);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const sig = edSign(null, moduleSigMessage('pro', version, sha256), privateKey).toString('base64');
  const manifest = {
    generated_at: '2026-07-10T00:00:00Z',
    modules: {
      pro: {
        latest: version,
        abi: 1,
        versions: {
          [version]: { object: `modules/pro/${version}.enc`, sha256, size: blob.length, sig },
        },
      },
    },
    license: { status: 'granted', expires_at: null },
  };
  const fetchImpl: DeliveryFetch = async (url) => {
    if (url.endsWith('/v1/modules/manifest')) return jsonRes(200, manifest);
    if (url.endsWith('/v1/modules/pro/key'))
      return jsonRes(200, { alg: 'AES-256-GCM', key: key.toString('base64') });
    if (url.endsWith(`/v1/modules/pro/${version}`)) return bytesRes(blob);
    return jsonRes(404, { error: 'unknown_module' });
  };
  return { fetchImpl, pubB64 };
}
