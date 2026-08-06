/**
 * Ed25519 authenticity verification for downloaded Pro module artifacts (audit H1, 2026-06-18).
 *
 * The host fetches an encrypted module, decrypts it with a content key the SAME
 * delivery Worker hands out, then `import()`s the handlers and spawns the bundled
 * go-core binary — i.e. it EXECUTES downloaded code. The pre-existing controls —
 * sha256-against-manifest (provision.ts) + the AES-GCM auth tag (crypto.ts) —
 * only prove the bytes match what THAT server said and decrypt with THAT server's
 * key. Neither is authenticity: a compromised delivery Worker / R2 bucket / TLS
 * path could serve attacker code with a matching hash and key, and the host would
 * import + run it (persistent RCE on every Pro machine).
 *
 * This module closes that gap. The maintainer signs the tuple (sku, version,
 * sha256) OFFLINE with an Ed25519 private key the delivery server never holds;
 * the host verifies the detached signature against a PINNED public key before
 * trusting the artifact. Compromising the delivery infrastructure is then no
 * longer sufficient to ship code to a user — the offline signing key is required
 * too. Signing (sku, version) also makes the manifest's path components
 * tamper-evident (see provision.ts §M1 validation, which fail-closes regardless).
 *
 * Key rotation: MODULE_SIGNING_PUBLIC_KEYS is an array. To rotate: add the new
 * public key, ship a host release, re-sign artifacts with the new private key,
 * then drop the old key in a later release. The private key is maintainer-held —
 * license-server `scripts/pack-module.mjs` reads it from `MODULE_SIGNING_KEY` /
 * `--signing-key`. It is NEVER committed to either repo or stored on the Worker.
 *
 * **v2 addition (boot-time fast path, 2026-07-29).** v1 above proves the
 * ENCRYPTED artifact is ours; it says nothing about the decrypted tree the host
 * re-derives from it on every boot (`store.ts loadVerifiedModule`) — so that path
 * used to decrypt + unzip + atomically swap the whole tree on EVERY load, ~1-3s
 * before the transport connects. v2 lets boot skip that regen when the on-disk
 * tree can be proven, cheaply, to already equal the signed bytes: the offline
 * packer additionally hashes every file in the STAGED (unencrypted) module tree,
 * builds a canonical digest list, and signs a second message —
 * `moduleSigV2Message` — over (sku, version, artifactSha256, digestsRoot). Both
 * messages are signed with the SAME Ed25519 key; v2 is purely ADDITIVE — an
 * older manifest with no `files`/`sig_v2` simply keeps taking the v1-only full
 * regen path (never weakened, never required). The canonical digest-list string
 * (`canonicalDigestListString`) MUST stay byte-for-byte in sync with the mirror
 * builder in `license-server/scripts/pack-module.mjs`.
 */
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';

/**
 * The dev/sandbox signing public key — NO LONGER PINNED (see
 * MODULE_SIGNING_PUBLIC_KEYS below). Kept defined so the release guard in
 * `tests/delivery/signing.test.ts` can fail a build that re-pins it.
 */
export const DEV_MODULE_SIGNING_PUBLIC_KEY =
  'MCowBQYDK2VwAyEA0DfcGMets2SlBofK4iFzLddKZB6mJF/E3beKFpLRN2o=';

/**
 * The production module-signing public key (base64 SPKI DER). Its private half was
 * generated OFFLINE via license-server `gen:signing-key --name prod` and is
 * maintainer-held — it never touches a server. Pinned 2026-06-19.
 */
const PROD_MODULE_SIGNING_PUBLIC_KEY =
  'MCowBQYDK2VwAyEAweoGOWvtf+aukiAD0FpuECSbCdZMeFzF2XYzbFWwfwo=';

/**
 * Pinned Ed25519 public key(s), base64-encoded SPKI DER, that the host trusts for
 * downloaded-module signatures. Rotation: add the new key, ship a host release,
 * re-sign artifacts with it, then drop the old key in a later release.
 */
export const MODULE_SIGNING_PUBLIC_KEYS: readonly string[] = [PROD_MODULE_SIGNING_PUBLIC_KEY];

/**
 * Domain-separated, scheme-versioned canonical message. MUST stay byte-for-byte
 * in sync with the signer in `license-server/scripts/pack-module.mjs`.
 */
export function moduleSigMessage(sku: string, version: string, sha256Hex: string): Buffer {
  return Buffer.from(`editmamei-module-sig-v1\n${sku}\n${version}\n${sha256Hex}`, 'utf8');
}

function importSpki(b64: string): KeyObject | null {
  try {
    return createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
  } catch {
    return null;
  }
}

/**
 * Verify a detached base64 Ed25519 signature over (sku, version, sha256) against
 * any pinned key. FAIL-CLOSED: a missing/empty/unparseable signature, an
 * unparseable pinned key, or an empty key set all return false — an unsigned or
 * mis-signed artifact is never trusted. Pure; `pubKeys` is injectable for tests.
 */
export function verifyModuleSignature(
  sku: string,
  version: string,
  sha256Hex: string,
  sigB64: string | undefined,
  pubKeys: readonly string[] = MODULE_SIGNING_PUBLIC_KEYS
): boolean {
  if (!sigB64) return false;
  const sig = Buffer.from(sigB64, 'base64');
  if (sig.length === 0) return false;
  const msg = moduleSigMessage(sku, version, sha256Hex);
  for (const b64 of pubKeys) {
    const key = importSpki(b64);
    if (!key) continue;
    try {
      if (verify(null, msg, key, sig)) return true;
    } catch {
      /* malformed signature for this key — try the next */
    }
  }
  return false;
}

/** One file's digest inside the v2 canonical digest list (see below). */
export interface ModuleFileDigest {
  /** Forward-slash path relative to the extracted module tree root. */
  path: string;
  /** Lowercase hex SHA-256 of the file's bytes. */
  sha256: string;
}

/** Structural type guard for an untrusted (wire/manifest-sourced) value. */
export function isModuleFileDigestArray(v: unknown): v is ModuleFileDigest[] {
  return (
    Array.isArray(v) &&
    v.every(
      (e) =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as Record<string, unknown>).path === 'string' &&
        typeof (e as Record<string, unknown>).sha256 === 'string'
    )
  );
}

/**
 * Canonical digest-list string the v2 `digestsRoot` is hashed over. Sorted by
 * `path` via a plain `<` string compare, then `JSON.stringify`d as `{path,
 * sha256}` objects in exactly that key order — a pure function of `files` so
 * both signer (license-server/scripts/pack-module.mjs) and verifier (here)
 * produce byte-identical output given the same digest list. Exported so the
 * packer's mirror and this file can each be pinned by their own unit test
 * without duplicating the sort/serialize logic.
 */
export function canonicalDigestListString(files: readonly ModuleFileDigest[]): string {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return JSON.stringify(sorted.map((f) => ({ path: f.path, sha256: f.sha256 })));
}

/** sha256 hex of the canonical digest-list string (UTF-8 bytes). */
export function digestsRootSha256Hex(files: readonly ModuleFileDigest[]): string {
  return createHash('sha256').update(canonicalDigestListString(files), 'utf8').digest('hex');
}

/**
 * v2 canonical message. ADDS to (never replaces) `moduleSigMessage` above — MUST
 * stay byte-for-byte in sync with the signer in
 * `license-server/scripts/pack-module.mjs`.
 */
export function moduleSigV2Message(
  sku: string,
  version: string,
  artifactSha256Hex: string,
  digestsRootHex: string
): Buffer {
  return Buffer.from(
    `editmamei-module-sig-v2\n${sku}\n${version}\n${artifactSha256Hex}\n${digestsRootHex}`,
    'utf8'
  );
}

/**
 * Verify a detached base64 Ed25519 signature over (sku, version, artifactSha256,
 * digestsRoot) against any pinned key. Same fail-closed posture as
 * `verifyModuleSignature`: a missing/empty/unparseable signature, an unparseable
 * pinned key, or an empty key set all return false.
 */
export function verifyModuleSignatureV2(
  sku: string,
  version: string,
  artifactSha256Hex: string,
  digestsRootHex: string,
  sigB64: string | undefined,
  pubKeys: readonly string[] = MODULE_SIGNING_PUBLIC_KEYS
): boolean {
  if (!sigB64) return false;
  const sig = Buffer.from(sigB64, 'base64');
  if (sig.length === 0) return false;
  const msg = moduleSigV2Message(sku, version, artifactSha256Hex, digestsRootHex);
  for (const b64 of pubKeys) {
    const key = importSpki(b64);
    if (!key) continue;
    try {
      if (verify(null, msg, key, sig)) return true;
    } catch {
      /* malformed signature for this key — try the next */
    }
  }
  return false;
}
