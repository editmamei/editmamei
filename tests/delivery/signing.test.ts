import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import {
  moduleSigMessage,
  verifyModuleSignature,
  moduleSigV2Message,
  verifyModuleSignatureV2,
  canonicalDigestListString,
  digestsRootSha256Hex,
  isModuleFileDigestArray,
  MODULE_SIGNING_PUBLIC_KEYS,
  DEV_MODULE_SIGNING_PUBLIC_KEY,
  type ModuleFileDigest,
} from '@editmamei/delivery/signing.ts';

/** A throwaway Ed25519 keypair as base64 SPKI (public) + a detached signer. */
function makeSigner() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const sign = (sku: string, version: string, sha256: string): string =>
    edSign(null, moduleSigMessage(sku, version, sha256), privateKey).toString('base64');
  return { pubB64, sign };
}

const SKU = 'pro';
const VERSION = '0.17.0';
const SHA = 'a'.repeat(64);

describe('verifyModuleSignature', () => {
  it('accepts a valid signature against the matching pinned key', () => {
    const { pubB64, sign } = makeSigner();
    const sig = sign(SKU, VERSION, SHA);
    expect(verifyModuleSignature(SKU, VERSION, SHA, sig, [pubB64])).toBe(true);
  });

  it('rejects a missing or empty signature (fail-closed)', () => {
    const { pubB64 } = makeSigner();
    expect(verifyModuleSignature(SKU, VERSION, SHA, undefined, [pubB64])).toBe(false);
    expect(verifyModuleSignature(SKU, VERSION, SHA, '', [pubB64])).toBe(false);
  });

  it('rejects a signature from a different (unpinned) key', () => {
    const signer = makeSigner();
    const attacker = makeSigner();
    const sig = attacker.sign(SKU, VERSION, SHA);
    expect(verifyModuleSignature(SKU, VERSION, SHA, sig, [signer.pubB64])).toBe(false);
  });

  it('rejects when any signed field is tampered (sku / version / sha256)', () => {
    const { pubB64, sign } = makeSigner();
    const sig = sign(SKU, VERSION, SHA);
    expect(verifyModuleSignature('evil', VERSION, SHA, sig, [pubB64])).toBe(false);
    expect(verifyModuleSignature(SKU, '9.9.9', SHA, sig, [pubB64])).toBe(false);
    expect(verifyModuleSignature(SKU, VERSION, 'b'.repeat(64), sig, [pubB64])).toBe(false);
  });

  it('rejects when no keys are pinned, and survives a garbage key in the set', () => {
    const { pubB64, sign } = makeSigner();
    const sig = sign(SKU, VERSION, SHA);
    expect(verifyModuleSignature(SKU, VERSION, SHA, sig, [])).toBe(false);
    // A malformed pinned key must not throw — it's skipped, and a later valid key still works.
    expect(verifyModuleSignature(SKU, VERSION, SHA, sig, ['not-a-key', pubB64])).toBe(true);
  });

  it('pins at least one non-empty signing key', () => {
    expect(MODULE_SIGNING_PUBLIC_KEYS.length).toBeGreaterThan(0);
    expect(MODULE_SIGNING_PUBLIC_KEYS.every((k) => k.length > 0)).toBe(true);
  });

  // Pro launch-blocker guard. The dev/sandbox
  // key is legitimately pinned during development, so this is a no-op in normal
  // dev/CI runs (the suite stays green). The launch pipeline sets
  // EDITMAMEI_RELEASE_GATE=1 to enforce that a fresh production key was generated
  // OFFLINE and swapped in before Pro ships — a release that still pins the dev
  // key fails here instead of shipping a known signer whose private half isn't a
  // protected root of trust.
  it('does not ship the dev signing key under the release gate', () => {
    if (!process.env.EDITMAMEI_RELEASE_GATE) return;
    expect(MODULE_SIGNING_PUBLIC_KEYS).not.toContain(DEV_MODULE_SIGNING_PUBLIC_KEY);
  });
});

describe('canonicalDigestListString / digestsRootSha256Hex', () => {
  const files: ModuleFileDigest[] = [
    { path: 'pro-handlers.mjs', sha256: 'b'.repeat(64) },
    { path: 'bin/editmamei-core-win-x64.exe', sha256: 'a'.repeat(64) },
    { path: 'manifest.json', sha256: 'c'.repeat(64) },
  ];

  it('sorts entries by path via a plain < compare, regardless of input order', () => {
    const shuffled = [files[2], files[0], files[1]];
    expect(canonicalDigestListString(shuffled)).toBe(canonicalDigestListString(files));
  });

  it('serializes the exact {"path":...,"sha256":...} shape, in that key order', () => {
    const single: ModuleFileDigest[] = [{ path: 'a.txt', sha256: 'd'.repeat(64) }];
    expect(canonicalDigestListString(single)).toBe(
      `[{"path":"a.txt","sha256":"${'d'.repeat(64)}"}]`
    );
  });

  it('is forward-slash-relative (paths pass through unchanged, no OS separator translation)', () => {
    const withSlash: ModuleFileDigest[] = [{ path: 'bin/sub/x.bin', sha256: 'e'.repeat(64) }];
    expect(canonicalDigestListString(withSlash)).toContain('"bin/sub/x.bin"');
  });

  it('drops any extra keys on the input entries — only path/sha256 survive, in that order', () => {
    const withExtra = [
      { path: 'z', sha256: 'f'.repeat(64), mode: 0o755 },
    ] as unknown as ModuleFileDigest[];
    expect(canonicalDigestListString(withExtra)).toBe(
      `[{"path":"z","sha256":"${'f'.repeat(64)}"}]`
    );
  });

  it('digestsRootSha256Hex is a pure sha256 of the canonical string (order-independent)', () => {
    const shuffled = [files[1], files[2], files[0]];
    const root = digestsRootSha256Hex(files);
    expect(root).toMatch(/^[0-9a-f]{64}$/);
    expect(digestsRootSha256Hex(shuffled)).toBe(root);
    // A changed digest changes the root.
    const tampered = [{ ...files[0], sha256: '9'.repeat(64) }, files[1], files[2]];
    expect(digestsRootSha256Hex(tampered)).not.toBe(root);
  });
});

describe('isModuleFileDigestArray', () => {
  it('accepts a well-formed array (including empty)', () => {
    expect(isModuleFileDigestArray([])).toBe(true);
    expect(isModuleFileDigestArray([{ path: 'a', sha256: 'a'.repeat(64) }])).toBe(true);
  });

  it('rejects non-arrays and malformed entries', () => {
    expect(isModuleFileDigestArray(undefined)).toBe(false);
    expect(isModuleFileDigestArray(null)).toBe(false);
    expect(isModuleFileDigestArray('nope')).toBe(false);
    expect(isModuleFileDigestArray([{ path: 'a' }])).toBe(false);
    expect(isModuleFileDigestArray([{ sha256: 'a'.repeat(64) }])).toBe(false);
    expect(isModuleFileDigestArray([{ path: 1, sha256: 'a'.repeat(64) }])).toBe(false);
  });
});

describe('verifyModuleSignatureV2', () => {
  const SKU = 'pro';
  const VERSION = '0.17.0';
  const ARTIFACT_SHA = 'a'.repeat(64);
  const files: ModuleFileDigest[] = [
    { path: 'pro-handlers.mjs', sha256: 'b'.repeat(64) },
    { path: 'manifest.json', sha256: 'c'.repeat(64) },
  ];

  function makeV2Signer() {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pubB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const sign = (sku: string, version: string, artifactSha: string, root: string): string =>
      edSign(null, moduleSigV2Message(sku, version, artifactSha, root), privateKey).toString(
        'base64'
      );
    return { pubB64, sign };
  }

  it('accepts a valid v2 signature against the matching pinned key, root re-derived from files', () => {
    const { pubB64, sign } = makeV2Signer();
    const root = digestsRootSha256Hex(files);
    const sig = sign(SKU, VERSION, ARTIFACT_SHA, root);
    expect(verifyModuleSignatureV2(SKU, VERSION, ARTIFACT_SHA, root, sig, [pubB64])).toBe(true);
  });

  it('rejects a missing or empty signature (fail-closed)', () => {
    const { pubB64 } = makeV2Signer();
    const root = digestsRootSha256Hex(files);
    expect(verifyModuleSignatureV2(SKU, VERSION, ARTIFACT_SHA, root, undefined, [pubB64])).toBe(
      false
    );
    expect(verifyModuleSignatureV2(SKU, VERSION, ARTIFACT_SHA, root, '', [pubB64])).toBe(false);
  });

  it('rejects a signature from a different (unpinned) key', () => {
    const signer = makeV2Signer();
    const attacker = makeV2Signer();
    const root = digestsRootSha256Hex(files);
    const sig = attacker.sign(SKU, VERSION, ARTIFACT_SHA, root);
    expect(verifyModuleSignatureV2(SKU, VERSION, ARTIFACT_SHA, root, sig, [signer.pubB64])).toBe(
      false
    );
  });

  it('rejects when any signed field is tampered (sku / version / artifactSha / digestsRoot)', () => {
    const { pubB64, sign } = makeV2Signer();
    const root = digestsRootSha256Hex(files);
    const sig = sign(SKU, VERSION, ARTIFACT_SHA, root);
    expect(verifyModuleSignatureV2('evil', VERSION, ARTIFACT_SHA, root, sig, [pubB64])).toBe(false);
    expect(verifyModuleSignatureV2(SKU, '9.9.9', ARTIFACT_SHA, root, sig, [pubB64])).toBe(false);
    expect(verifyModuleSignatureV2(SKU, VERSION, 'b'.repeat(64), root, sig, [pubB64])).toBe(false);
    expect(verifyModuleSignatureV2(SKU, VERSION, ARTIFACT_SHA, 'd'.repeat(64), sig, [pubB64])).toBe(
      false
    );
  });

  it('rejects when the digest LIST is tampered even though a stale root/sig pair is supplied', () => {
    // Simulates a boot-time re-derivation: the caller always recomputes the root
    // from the CURRENT `files` list, never trusts a caller-supplied root — so
    // signing over the old root and then verifying against the new files' root
    // must fail, exactly like store.ts's loadVerifiedModule does it.
    const { pubB64, sign } = makeV2Signer();
    const root = digestsRootSha256Hex(files);
    const sig = sign(SKU, VERSION, ARTIFACT_SHA, root);
    const tamperedFiles = [...files, { path: 'extra.bin', sha256: 'f'.repeat(64) }];
    const tamperedRoot = digestsRootSha256Hex(tamperedFiles);
    expect(verifyModuleSignatureV2(SKU, VERSION, ARTIFACT_SHA, tamperedRoot, sig, [pubB64])).toBe(
      false
    );
  });

  it('rejects when no keys are pinned, and survives a garbage key in the set', () => {
    const { pubB64, sign } = makeV2Signer();
    const root = digestsRootSha256Hex(files);
    const sig = sign(SKU, VERSION, ARTIFACT_SHA, root);
    expect(verifyModuleSignatureV2(SKU, VERSION, ARTIFACT_SHA, root, sig, [])).toBe(false);
    expect(
      verifyModuleSignatureV2(SKU, VERSION, ARTIFACT_SHA, root, sig, ['not-a-key', pubB64])
    ).toBe(true);
  });
});

/**
 * KNOWN-ANSWER VECTOR (KAT) — pinned IDENTICALLY in THREE places (S1/S2,
 * 2026-07-29): here, `license-server/scripts/pack-module.mjs` (the pack-time
 * self-check, run FIRST, before signing), and `license-server/test/module-
 * signature.spec.ts` (a reconstruction, since pack-module.mjs can't be
 * imported into the workerd test pool). Unlike pack-module.mjs's OTHER
 * self-check (recompute the root from `files` and re-verify its own
 * just-produced `sig_v2` — real, but only catches an internal
 * inconsistency), this compares against a value fixed INDEPENDENTLY of any of
 * the three implementations, so it has real power to catch a canonical-string
 * FORMAT drift (key order, separator, sort comparator) that all three sides
 * could otherwise silently agree on and still be wrong relative to each other
 * if edited in lockstep by mistake.
 *
 * Two entries, chosen to exercise (a) the SORT reorder — natural/input order
 * here is pro-handlers.mjs then bin/…, but the canonical (sorted) output
 * flips them — and (b) a forward-slash NESTED path.
 */
const KAT_FILES: ModuleFileDigest[] = [
  { path: 'pro-handlers.mjs', sha256: 'b'.repeat(64) },
  { path: 'bin/editmamei-core-win-x64.exe', sha256: 'a'.repeat(64) },
];
// Built independently of canonicalDigestListString (plain string concat), NOT
// by calling the function under test — a golden value has to come from
// somewhere other than the code it's pinning.
const KAT_CANONICAL =
  `[{"path":"bin/editmamei-core-win-x64.exe","sha256":"${'a'.repeat(64)}"},` +
  `{"path":"pro-handlers.mjs","sha256":"${'b'.repeat(64)}"}]`;
const KAT_ROOT = '9f6bcf4b029a1b0385d964633fb5c5e2f5755cbcd9e45cecd2f392d37b97f077';

describe('known-answer vector (KAT) — pinned identically in pack-module.mjs + module-signature.spec.ts', () => {
  it('canonicalDigestListString reproduces the golden canonical string', () => {
    expect(canonicalDigestListString(KAT_FILES)).toBe(KAT_CANONICAL);
  });

  it('digestsRootSha256Hex reproduces the golden root hex', () => {
    expect(digestsRootSha256Hex(KAT_FILES)).toBe(KAT_ROOT);
  });
});
