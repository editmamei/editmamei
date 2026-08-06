import { describe, it, expect } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
  chmodSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomBytes, generateKeyPairSync, sign as edSign } from 'node:crypto';
import {
  installModule,
  readInstalledModule,
  installedModuleDir,
  moduleHandlersPath,
  moduleArtifactPath,
  installedPath,
  pruneOldModuleVersions,
  loadVerifiedModule,
} from '@editmamei/delivery/store.ts';
import { packBundle, type BundleFile } from '@editmamei/delivery/bundle.ts';
import { sha256Hex } from '@editmamei/delivery/crypto.ts';
import {
  moduleSigMessage,
  moduleSigV2Message,
  digestsRootSha256Hex,
  type ModuleFileDigest,
} from '@editmamei/delivery/signing.ts';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'em-modules-'));
}

const contentKey = randomBytes(32).toString('base64');

const rec = {
  sku: 'pro',
  version: '0.17.0',
  abi: 1,
  sha256: 'deadbeef',
  alg: 'AES-256-GCM',
  content_key: contentKey,
  sig: 'dGVzdC1zaWduYXR1cmU=',
};

/** The plaintext files a realistic module bundle unpacks to (handlers + a binary + the manifest). */
function moduleFiles(version = '0.17.0'): BundleFile[] {
  return [
    {
      name: 'pro-handlers.mjs',
      data: Buffer.from('export default { manifest: {}, register(){} }'),
    },
    { name: 'bin/editmamei-core-win-x64.exe', data: Buffer.from([0x4d, 0x5a]) },
    { name: 'manifest.json', data: Buffer.from(JSON.stringify({ sku: 'pro', version })) },
  ];
}

/** The encrypted artifact for `moduleFiles(version)`. */
function moduleBlob(version = '0.17.0'): Uint8Array {
  return packBundle(moduleFiles(version), contentKey);
}

/**
 * Install a real, signature-verified module (real sha256 + a fresh ephemeral
 * Ed25519 signature over it) so `loadVerifiedModule` can be exercised directly —
 * unlike `rec` above (dummy sha256/sig, fine for `installModule` alone, which
 * never checks either), the boot-time verifier in `loadVerifiedModule` DOES check
 * both. Returns the signer's pub key (pass as `loadVerifiedModule`'s `pubKeys`).
 */
function installSigned(dir: string, version = '0.17.0') {
  const blob = moduleBlob(version);
  const sha256 = sha256Hex(blob);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const sig = edSign(null, moduleSigMessage('pro', version, sha256), privateKey).toString('base64');
  const signedRec = {
    sku: 'pro',
    version,
    abi: 1,
    sha256,
    alg: 'AES-256-GCM',
    content_key: contentKey,
    sig,
  };
  installModule(signedRec, blob, { dir });
  return { pubB64, version, sha256 };
}

/**
 * Install a real, signature-verified module carrying BOTH v1 and v2 fields:
 * `files` (the per-file digest list of the plaintext tree the bundle unpacks
 * to) + `sig_v2` (a detached Ed25519 signature over (sku, version,
 * artifactSha, digestsRoot), signed with the SAME key as v1 — mirroring the
 * real offline packer). Returns the signer's pub key (the pinned key set for
 * both v1 + v2 in these tests) plus the built digest list so a test can
 * tamper `installed.json`'s stored v2 fields directly.
 */
function installSignedV2(dir: string, version = '0.17.0') {
  const files = moduleFiles(version);
  const blob = packBundle(files, contentKey);
  const sha256 = sha256Hex(blob);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const sig = edSign(null, moduleSigMessage('pro', version, sha256), privateKey).toString('base64');

  const digestList: ModuleFileDigest[] = files.map((f) => ({
    path: f.name,
    sha256: sha256Hex(f.data),
  }));
  const digestsRoot = digestsRootSha256Hex(digestList);
  const sigV2 = edSign(
    null,
    moduleSigV2Message('pro', version, sha256, digestsRoot),
    privateKey
  ).toString('base64');

  const signedRec = {
    sku: 'pro',
    version,
    abi: 1,
    sha256,
    alg: 'AES-256-GCM',
    content_key: contentKey,
    sig,
    files: digestList,
    sig_v2: sigV2,
  };
  installModule(signedRec, blob, { dir });
  return { pubB64, version, sha256, files: digestList };
}

/**
 * Like {@link installSignedV2}, but lets the caller supply a CUSTOM digest list
 * (`filesOverride`, given the real per-file digests of the actual unpacked tree
 * as a starting point) instead of the exact list that matches it — for the
 * adversarial path battery (T2). `sig_v2` is signed over the CUSTOM list's own
 * digestsRoot with a fresh ephemeral key, so it verifies cleanly against the
 * returned `pubB64` — the anomaly under test lives entirely in the set/content
 * checks `verifyFastPath` runs AFTER the signature has already passed, never
 * in the signature check itself.
 */
function installSignedV2Custom(
  dir: string,
  filesOverride: (base: ModuleFileDigest[]) => ModuleFileDigest[],
  version = '0.17.0'
) {
  const files = moduleFiles(version);
  const blob = packBundle(files, contentKey);
  const sha256 = sha256Hex(blob);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const sig = edSign(null, moduleSigMessage('pro', version, sha256), privateKey).toString('base64');

  const baseDigestList: ModuleFileDigest[] = files.map((f) => ({
    path: f.name,
    sha256: sha256Hex(f.data),
  }));
  const digestList = filesOverride(baseDigestList);
  const digestsRoot = digestsRootSha256Hex(digestList);
  const sigV2 = edSign(
    null,
    moduleSigV2Message('pro', version, sha256, digestsRoot),
    privateKey
  ).toString('base64');

  const signedRec = {
    sku: 'pro',
    version,
    abi: 1,
    sha256,
    alg: 'AES-256-GCM',
    content_key: contentKey,
    sig,
    files: digestList,
    sig_v2: sigV2,
  };
  installModule(signedRec, blob, { dir });
  return { pubB64, version, sha256, files: digestList };
}

describe('module store', () => {
  it('decrypts + unpacks the bundle, writes the pointer, and reads it back', () => {
    const dir = tmpDir();
    try {
      const installed = installModule(rec, moduleBlob(), { dir, now: () => 1700000000000 });
      expect(installed.installed_at).toBe(new Date(1700000000000).toISOString());

      // The bundle's files are unpacked under <sku>/<version>/.
      const moduleDir = installedModuleDir('pro', '0.17.0', { dir });
      expect(existsSync(moduleHandlersPath('pro', '0.17.0', { dir }))).toBe(true);
      expect(existsSync(join(moduleDir, 'bin', 'editmamei-core-win-x64.exe'))).toBe(true);
      expect(existsSync(join(moduleDir, 'manifest.json'))).toBe(true);

      const read = readInstalledModule('pro', { dir });
      expect(read).toEqual(installed);
      expect(read?.content_key).toBe(rec.content_key);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when no pointer exists', () => {
    const dir = tmpDir();
    try {
      expect(readInstalledModule('pro', { dir })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores a pointer whose unpacked bundle is missing (incomplete install)', () => {
    const dir = tmpDir();
    try {
      mkdirSync(join(dir, 'modules', 'pro'), { recursive: true });
      writeFileSync(
        installedPath('pro', { dir }),
        JSON.stringify({ ...rec, installed_at: new Date().toISOString() })
      );
      // Pointer present but no unpacked manifest on disk → treat as absent.
      expect(readInstalledModule('pro', { dir })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores a malformed pointer', () => {
    const dir = tmpDir();
    try {
      mkdirSync(join(dir, 'modules', 'pro'), { recursive: true });
      writeFileSync(installedPath('pro', { dir }), '{ not valid json');
      expect(readInstalledModule('pro', { dir })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws on a wrong content key (the bundle decrypt fails before any write)', () => {
    const dir = tmpDir();
    try {
      const wrongKeyRec = { ...rec, content_key: randomBytes(32).toString('base64') };
      expect(() => installModule(wrongKeyRec, moduleBlob(), { dir })).toThrow();
      // Nothing was written — no pointer.
      expect(readInstalledModule('pro', { dir })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prunes the prior version dir after a newer install, keeping only the current', () => {
    const dir = tmpDir();
    try {
      installModule({ ...rec, version: '0.17.0' }, moduleBlob('0.17.0'), { dir });
      installModule({ ...rec, version: '0.18.0' }, moduleBlob('0.18.0'), { dir });

      // The pointer now names the new version, its dir is present…
      expect(readInstalledModule('pro', { dir })?.version).toBe('0.18.0');
      expect(existsSync(installedModuleDir('pro', '0.18.0', { dir }))).toBe(true);
      // …and the superseded version dir was reclaimed.
      expect(existsSync(installedModuleDir('pro', '0.17.0', { dir }))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('pruneOldModuleVersions', () => {
  it('removes only stale version dirs — never the pointer file or a stray file', () => {
    const dir = tmpDir();
    try {
      mkdirSync(installedModuleDir('pro', '1.0.0', { dir }), { recursive: true });
      mkdirSync(installedModuleDir('pro', '2.0.0', { dir }), { recursive: true });
      const skuDir = dirname(installedPath('pro', { dir })); // modules/pro
      writeFileSync(installedPath('pro', { dir }), '{}');
      writeFileSync(join(skuDir, 'notes.txt'), 'keep me');

      pruneOldModuleVersions('pro', '2.0.0', { dir });

      expect(existsSync(installedModuleDir('pro', '2.0.0', { dir }))).toBe(true);
      expect(existsSync(installedModuleDir('pro', '1.0.0', { dir }))).toBe(false);
      expect(existsSync(installedPath('pro', { dir }))).toBe(true);
      expect(existsSync(join(skuDir, 'notes.txt'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is a no-op when the sku dir does not exist', () => {
    const dir = tmpDir();
    try {
      expect(() => pruneOldModuleVersions('pro', '1.0.0', { dir })).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves a FRESH .tmp-* staging dir alone but reaps a stale one', () => {
    const dir = tmpDir();
    try {
      const skuDir = join(dir, 'modules', 'pro');
      mkdirSync(join(skuDir, '.tmp-9.9.9-111'), { recursive: true }); // fresh (mtime ~ now)
      mkdirSync(join(skuDir, '.tmp-9.9.9-222'), { recursive: true }); // treated as stale below

      // now = far future → the .tmp dirs' age exceeds TMP_STALE_MS. But a fresh one
      // (mtime ~ real now) is only "stale" relative to a future clock, so test both
      // ends with two clocks: a real-now clock keeps them, a far-future clock reaps.
      pruneOldModuleVersions('pro', '9.9.9', { dir, now: () => Date.now() });
      expect(existsSync(join(skuDir, '.tmp-9.9.9-111'))).toBe(true); // fresh → kept

      pruneOldModuleVersions('pro', '9.9.9', { dir, now: () => Date.now() + 60 * 60 * 1000 });
      expect(existsSync(join(skuDir, '.tmp-9.9.9-111'))).toBe(false); // now stale → reaped
      expect(existsSync(join(skuDir, '.tmp-9.9.9-222'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('installModule — concurrency-safe staging (B3)', () => {
  it('leaves no .tmp-* staging dir behind after a successful install', () => {
    const dir = tmpDir();
    try {
      installModule(rec, moduleBlob(), { dir });
      const residue = readdirSync(join(dir, 'modules', 'pro')).filter((e) => e.startsWith('.tmp-'));
      expect(residue).toEqual([]);
      expect(existsSync(installedModuleDir('pro', '0.17.0', { dir }))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adopts a sibling-won version dir on a rename collision — no throw, no residue', () => {
    const dir = tmpDir();
    try {
      // A concurrent sibling already materialized a complete version dir.
      const finalDir = installedModuleDir('pro', '0.17.0', { dir });
      mkdirSync(finalDir, { recursive: true });
      writeFileSync(
        join(finalDir, 'manifest.json'),
        JSON.stringify({ sku: 'pro', version: '0.17.0' })
      );

      // Our install extracts to tmp, loses the rename race, adopts the sibling dir.
      expect(() => installModule(rec, moduleBlob(), { dir })).not.toThrow();

      expect(readInstalledModule('pro', { dir })?.version).toBe('0.17.0');
      const residue = readdirSync(join(dir, 'modules', 'pro')).filter((e) => e.startsWith('.tmp-'));
      expect(residue).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('force replaces an existing same-version dir with fresh bytes', () => {
    const dir = tmpDir();
    try {
      installModule(rec, moduleBlob('0.17.0'), { dir });
      const marker = join(installedModuleDir('pro', '0.17.0', { dir }), 'STALE-MARKER');
      writeFileSync(marker, 'x'); // something only the OLD tree has
      expect(existsSync(marker)).toBe(true);

      // A force reinstall of the same version rebuilds the tree from fresh bytes —
      // the stale marker is gone, proving the dir was replaced (not merged).
      installModule(rec, moduleBlob('0.17.0'), { dir, force: true });
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(installedModuleDir('pro', '0.17.0', { dir }))).toBe(true);
      expect(readInstalledModule('pro', { dir })?.version).toBe('0.17.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('installModule force path — atomic staging swap (ML-2)', () => {
  it('never leaves finalDir absent — swaps the old tree aside instead of rm-then-rename, no aside-dir residue', () => {
    const dir = tmpDir();
    try {
      installModule(rec, moduleBlob('0.17.0'), { dir });
      const finalDir = installedModuleDir('pro', '0.17.0', { dir });
      expect(existsSync(finalDir)).toBe(true);

      installModule(rec, moduleBlob('0.17.0'), { dir, force: true });

      // finalDir is present and complete right after the force repair — the pointer
      // (already naming this sku/version) never had a moment where it named a
      // missing dir, because the old tree was renamed aside (fast, atomic) rather
      // than rmSync'd in place (slow, recursive) before the new tree was renamed in.
      expect(existsSync(finalDir)).toBe(true);
      expect(existsSync(join(finalDir, 'manifest.json'))).toBe(true);
      expect(readInstalledModule('pro', { dir })?.version).toBe('0.17.0');
      // The `.tmp-old-*` aside dir used for the swap was cleaned up, not left behind.
      const residue = readdirSync(join(dir, 'modules', 'pro')).filter((e) => e.startsWith('.tmp-'));
      expect(residue).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('discards a stale .tmp-old-* aside dir left by a crashed prior force attempt', () => {
    const dir = tmpDir();
    try {
      installModule(rec, moduleBlob('0.17.0'), { dir });
      const skuDir = join(dir, 'modules', 'pro');
      // A previous force attempt crashed after renaming the old tree aside but
      // before cleaning it up — simulate that leftover under this same staging name.
      const staleAside = join(skuDir, `.tmp-old-0.17.0-${process.pid}`);
      mkdirSync(staleAside, { recursive: true });
      writeFileSync(join(staleAside, 'STALE'), 'leftover');

      expect(() => installModule(rec, moduleBlob('0.17.0'), { dir, force: true })).not.toThrow();

      const finalDir = installedModuleDir('pro', '0.17.0', { dir });
      expect(existsSync(finalDir)).toBe(true);
      expect(existsSync(join(finalDir, 'manifest.json'))).toBe(true);
      const residue = readdirSync(skuDir).filter((e) => e.startsWith('.tmp-'));
      expect(residue).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('loadVerifiedModule regen — atomic staging swap (DL-3)', () => {
  it('regenerates via a staging dir and leaves the final dir complete, with no staging residue', () => {
    const dir = tmpDir();
    try {
      const { pubB64, version } = installSigned(dir);
      const loc = loadVerifiedModule('pro', { dir }, [pubB64]);
      expect(loc).not.toBeNull();
      expect(loc?.version).toBe(version);
      // The regenerated tree is complete...
      expect(existsSync(loc!.handlersPath)).toBe(true);
      expect(existsSync(join(loc!.dir, 'manifest.json'))).toBe(true);
      expect(existsSync(join(loc!.binDir, 'editmamei-core-win-x64.exe'))).toBe(true);
      // …and no per-process regen staging dir was left behind — the swap completed
      // and cleaned up; the regen never wrote straight into the live dir in place.
      const residue = readdirSync(join(dir, 'modules', 'pro')).filter((e) => e.startsWith('.tmp-'));
      expect(residue).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('discards a stale regen staging dir from a crashed prior attempt instead of adopting it', () => {
    const dir = tmpDir();
    try {
      const { pubB64, version } = installSigned(dir);
      // Simulate a crashed prior regen: a staging dir under this process's staging
      // name holding a garbage file and no manifest — a torn, incomplete unpack.
      const skuDir = join(dir, 'modules', 'pro');
      const staleDir = join(skuDir, `.tmp-regen-${version}-${process.pid}`);
      mkdirSync(staleDir, { recursive: true });
      writeFileSync(join(staleDir, 'GARBAGE'), 'torn-write');

      const loc = loadVerifiedModule('pro', { dir }, [pubB64]);
      expect(loc).not.toBeNull();
      // The stale/garbage content was discarded, not merged into the final tree —
      // regen always starts from a freshly-cleared staging dir, never resumes or
      // adopts a torn one.
      expect(existsSync(join(loc!.dir, 'GARBAGE'))).toBe(false);
      expect(existsSync(join(loc!.dir, 'manifest.json'))).toBe(true);
      const residue = readdirSync(skuDir).filter((e) => e.startsWith('.tmp-'));
      expect(residue).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed and leaves the live dir untouched when the regen genuinely fails', () => {
    const dir = tmpDir();
    try {
      const { pubB64, version } = installSigned(dir);
      const handlersPath = moduleHandlersPath('pro', version, { dir });
      const before = readFileSync(handlersPath, 'utf8');

      // Corrupt ONLY the persisted content_key. sha256 + sig cover the retained
      // artifact's ciphertext bytes and (sku, version, sha256) — not the key — so
      // hash + signature verification still passes, but the regen's decrypt now
      // fails its GCM auth tag. This is the cleanest way to force installBundle to
      // throw mid-regen without touching the trusted artifact or its signature.
      const pointerPath = installedPath('pro', { dir });
      const pointer = JSON.parse(readFileSync(pointerPath, 'utf8'));
      pointer.content_key = randomBytes(32).toString('base64');
      writeFileSync(pointerPath, JSON.stringify(pointer));

      expect(loadVerifiedModule('pro', { dir }, [pubB64])).toBeNull();
      // The failed regen never got past its own staging dir — no swap was
      // attempted, so the live dir from the earlier good install is untouched.
      expect(readFileSync(handlersPath, 'utf8')).toBe(before);
      expect(existsSync(join(installedModuleDir('pro', version, { dir }), 'manifest.json'))).toBe(
        true
      );
      const residue = readdirSync(join(dir, 'modules', 'pro')).filter((e) => e.startsWith('.tmp-'));
      expect(residue).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves artifact.enc in the swapped-in dir so a SECOND boot still re-verifies (regression: the swap must not drop the retained artifact)', () => {
    const dir = tmpDir();
    try {
      const { pubB64, version } = installSigned(dir);
      // First boot: the regen swaps a freshly-decrypted tree into the live dir.
      const first = loadVerifiedModule('pro', { dir }, [pubB64]);
      expect(first).not.toBeNull();
      // The retained, signature-bound artifact MUST survive the swap — the boot
      // verifier re-reads it on EVERY load (audit H1). If the staging swap dropped
      // it, this file is gone and the NEXT load throws ENOENT -> null -> Pro dark /
      // re-download loop. (Before the fix, this assertion — and the second load
      // below — failed.)
      expect(existsSync(join(first!.dir, 'artifact.enc'))).toBe(true);
      // Second boot against the now-regenerated dir: must still verify and return a
      // location, proving the dir the swap produced is itself re-loadable.
      const second = loadVerifiedModule('pro', { dir }, [pubB64]);
      expect(second).not.toBeNull();
      expect(second?.version).toBe(version);
      expect(existsSync(second!.handlersPath)).toBe(true);
      expect(existsSync(join(second!.dir, 'artifact.enc'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('loadVerifiedModule — v2 fast path (2026-07-29)', () => {
  it("(a) no v2 fields on the pointer -> regenerated:true (today's path, unchanged)", () => {
    const dir = tmpDir();
    try {
      const { pubB64 } = installSigned(dir);
      const loc = loadVerifiedModule('pro', { dir }, [pubB64]);
      expect(loc).not.toBeNull();
      expect(loc!.regenerated).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(b) clean tree + valid v2 -> regenerated:false, and the tree files are untouched (mtimes unchanged)', () => {
    const dir = tmpDir();
    try {
      const { pubB64, version } = installSignedV2(dir);
      const handlersPath = moduleHandlersPath('pro', version, { dir });
      const manifestPath = join(installedModuleDir('pro', version, { dir }), 'manifest.json');
      const handlersMtimeBefore = statSync(handlersPath).mtimeMs;
      const manifestMtimeBefore = statSync(manifestPath).mtimeMs;

      const loc = loadVerifiedModule('pro', { dir }, [pubB64]);

      expect(loc).not.toBeNull();
      expect(loc!.version).toBe(version);
      expect(loc!.regenerated).toBe(false);
      // Untouched — the fast path never wrote/renamed the live dir.
      expect(statSync(handlersPath).mtimeMs).toBe(handlersMtimeBefore);
      expect(statSync(manifestPath).mtimeMs).toBe(manifestMtimeBefore);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(c) one file tampered -> regenerated:true, and the tree is restored to the signed bytes', () => {
    const dir = tmpDir();
    try {
      const { pubB64, version } = installSignedV2(dir);
      const handlersPath = moduleHandlersPath('pro', version, { dir });
      const original = readFileSync(handlersPath, 'utf8');
      writeFileSync(handlersPath, 'export default { EVIL: true }');

      const loc = loadVerifiedModule('pro', { dir }, [pubB64]);

      expect(loc).not.toBeNull();
      expect(loc!.regenerated).toBe(true);
      expect(readFileSync(handlersPath, 'utf8')).toBe(original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(d) an extra planted file -> regenerated:true (the extra file does not survive the regen)', () => {
    const dir = tmpDir();
    try {
      const { pubB64, version } = installSignedV2(dir);
      const moduleDir = installedModuleDir('pro', version, { dir });
      writeFileSync(join(moduleDir, 'EXTRA.txt'), 'planted');

      const loc = loadVerifiedModule('pro', { dir }, [pubB64]);

      expect(loc).not.toBeNull();
      expect(loc!.regenerated).toBe(true);
      expect(existsSync(join(loc!.dir, 'EXTRA.txt'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(e) a listed file deleted -> regenerated:true (the tree is restored complete)', () => {
    const dir = tmpDir();
    try {
      const { pubB64, version } = installSignedV2(dir);
      // Delete a listed-but-not-manifest file: `manifest.json` itself is also
      // readInstalledModule's own "is this install complete" gate (checked
      // BEFORE loadVerifiedModule ever runs), so deleting it would trip that
      // earlier, unrelated safety net instead of exercising the v2 fast path.
      const binPath = join(
        installedModuleDir('pro', version, { dir }),
        'bin',
        'editmamei-core-win-x64.exe'
      );
      rmSync(binPath);

      const loc = loadVerifiedModule('pro', { dir }, [pubB64]);

      expect(loc).not.toBeNull();
      expect(loc!.regenerated).toBe(true);
      expect(existsSync(join(loc!.dir, 'bin', 'editmamei-core-win-x64.exe'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(f) the stored digest LIST is tampered (root mismatch) -> regenerated:true', () => {
    const dir = tmpDir();
    try {
      const { pubB64, version } = installSignedV2(dir);
      const pointerPath = installedPath('pro', { dir });
      const pointer = JSON.parse(readFileSync(pointerPath, 'utf8'));
      pointer.files[0].sha256 = '9'.repeat(64); // corrupt one recorded digest
      writeFileSync(pointerPath, JSON.stringify(pointer));

      const loc = loadVerifiedModule('pro', { dir }, [pubB64]);

      expect(loc).not.toBeNull();
      expect(loc!.regenerated).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(g) sig_v2 from a non-pinned key -> regenerated:true (v1 alone still verifies)', () => {
    const dir = tmpDir();
    try {
      const { pubB64, version } = installSignedV2(dir);
      // Re-sign v2 with a DIFFERENT (unpinned) key, leaving v1's sig + the pinned
      // key untouched — isolates a bad v2 signature from a bad v1 one.
      const pointerPath = installedPath('pro', { dir });
      const pointer = JSON.parse(readFileSync(pointerPath, 'utf8'));
      const attacker = generateKeyPairSync('ed25519');
      const root = digestsRootSha256Hex(pointer.files);
      pointer.sig_v2 = edSign(
        null,
        moduleSigV2Message('pro', version, pointer.sha256, root),
        attacker.privateKey
      ).toString('base64');
      writeFileSync(pointerPath, JSON.stringify(pointer));

      const loc = loadVerifiedModule('pro', { dir }, [pubB64]);

      expect(loc).not.toBeNull();
      expect(loc!.regenerated).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(h) artifact hash mismatch -> still returns null (refuse-to-load, unchanged by v2)', () => {
    const dir = tmpDir();
    try {
      const { pubB64, version } = installSignedV2(dir);
      writeFileSync(moduleArtifactPath('pro', version, { dir }), randomBytes(64));
      expect(loadVerifiedModule('pro', { dir }, [pubB64])).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('readInstalledModule — v2 field sanitization on read (S3/T1)', () => {
  it('a malformed `files` (wrong type) is dropped, not fatal — the pointer still loads, both v2 fields absent, and loadVerifiedModule takes the v1 regen path', () => {
    const dir = tmpDir();
    try {
      const { pubB64, version } = installSigned(dir);
      const pointerPath = installedPath('pro', { dir });
      const pointer = JSON.parse(readFileSync(pointerPath, 'utf8'));
      pointer.files = 'nope'; // wrong type — not an array
      pointer.sig_v2 = 'dGVzdA=='; // otherwise well-shaped, so `files` alone is the anomaly
      writeFileSync(pointerPath, JSON.stringify(pointer));

      const read = readInstalledModule('pro', { dir });
      expect(read).not.toBeNull();
      expect(read?.files).toBeUndefined();
      expect(read?.sig_v2).toBeUndefined();

      const loc = loadVerifiedModule('pro', { dir }, [pubB64]);
      expect(loc).not.toBeNull();
      expect(loc?.version).toBe(version);
      expect(loc!.regenerated).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a malformed `sig_v2` (wrong type) is dropped the same way', () => {
    const dir = tmpDir();
    try {
      const { pubB64, version } = installSigned(dir);
      const pointerPath = installedPath('pro', { dir });
      const pointer = JSON.parse(readFileSync(pointerPath, 'utf8'));
      pointer.files = [{ path: 'pro-handlers.mjs', sha256: 'a'.repeat(64) }];
      pointer.sig_v2 = 42; // wrong type — not a string
      writeFileSync(pointerPath, JSON.stringify(pointer));

      const read = readInstalledModule('pro', { dir });
      expect(read).not.toBeNull();
      expect(read?.files).toBeUndefined();
      expect(read?.sig_v2).toBeUndefined();

      const loc = loadVerifiedModule('pro', { dir }, [pubB64]);
      expect(loc).not.toBeNull();
      expect(loc?.version).toBe(version);
      expect(loc!.regenerated).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('`files` present without `sig_v2` (half-present pair) is dropped', () => {
    const dir = tmpDir();
    try {
      const { pubB64, version } = installSigned(dir);
      const pointerPath = installedPath('pro', { dir });
      const pointer = JSON.parse(readFileSync(pointerPath, 'utf8'));
      pointer.files = [{ path: 'pro-handlers.mjs', sha256: 'a'.repeat(64) }];
      // sig_v2 intentionally omitted — files alone is not a valid pair.
      writeFileSync(pointerPath, JSON.stringify(pointer));

      const read = readInstalledModule('pro', { dir });
      expect(read).not.toBeNull();
      expect(read?.files).toBeUndefined();
      expect(read?.sig_v2).toBeUndefined();

      const loc = loadVerifiedModule('pro', { dir }, [pubB64]);
      expect(loc).not.toBeNull();
      expect(loc?.version).toBe(version);
      expect(loc!.regenerated).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('`sig_v2` present without `files` (the other half-present pair) is dropped', () => {
    const dir = tmpDir();
    try {
      const { pubB64, version } = installSigned(dir);
      const pointerPath = installedPath('pro', { dir });
      const pointer = JSON.parse(readFileSync(pointerPath, 'utf8'));
      pointer.sig_v2 = 'dGVzdA==';
      // files intentionally omitted — sig_v2 alone is not a valid pair.
      writeFileSync(pointerPath, JSON.stringify(pointer));

      const read = readInstalledModule('pro', { dir });
      expect(read).not.toBeNull();
      expect(read?.files).toBeUndefined();
      expect(read?.sig_v2).toBeUndefined();

      const loc = loadVerifiedModule('pro', { dir }, [pubB64]);
      expect(loc).not.toBeNull();
      expect(loc?.version).toBe(version);
      expect(loc!.regenerated).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('verifyFastPath — adversarial path battery (T2)', () => {
  it('a signed digest entry with a traversal path (`../../evil.txt`) -> regen, and the set-check rejects it before any read', () => {
    const dir = tmpDir();
    try {
      const evilContent = Buffer.from('planted-outside-the-module-tree');
      const evilSha = sha256Hex(evilContent);
      const { pubB64, version } = installSignedV2Custom(dir, (base) => [
        ...base,
        { path: '../../evil.txt', sha256: evilSha },
      ]);
      // Plant the file where '../../evil.txt' actually resolves to FROM the
      // module dir — genuinely OUTSIDE <sku>/<version>/, at <sku>/evil.txt —
      // with content that hash-matches the listed digest, so a traversal-
      // following implementation would wrongly accept it as a match.
      const outsidePath = join(installedModuleDir('pro', version, { dir }), '..', '..', 'evil.txt');
      mkdirSync(dirname(outsidePath), { recursive: true });
      writeFileSync(outsidePath, evilContent);

      const loc = loadVerifiedModule('pro', { dir }, [pubB64]);
      expect(loc).not.toBeNull();
      expect(loc!.regenerated).toBe(true);
      // The plant is untouched — combined with the load-bearing comment on
      // verifyFastPath (the missing/extra SET check runs to completion, and
      // returns, BEFORE the content-read loop even starts), a real traversal
      // read never happens: this anomaly is caught as "missing file
      // '../../evil.txt'" (it can never appear in the on-disk set, which is
      // built by enumerating FROM the module dir), not a content check.
      expect(readFileSync(outsidePath)).toEqual(evilContent);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a signed digest entry with an absolute-looking path -> regen (path.join never lets it escape the tree)', () => {
    const dir = tmpDir();
    try {
      const { pubB64 } = installSignedV2Custom(dir, (base) => [
        ...base,
        { path: '/etc/passwd', sha256: 'f'.repeat(64) },
      ]);
      const loc = loadVerifiedModule('pro', { dir }, [pubB64]);
      expect(loc).not.toBeNull();
      expect(loc!.regenerated).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a signed digest entry naming a DIRECTORY (not a file) -> regen (directories are never leaves in the on-disk set)', () => {
    const dir = tmpDir();
    try {
      const { pubB64 } = installSignedV2Custom(dir, (base) => [
        ...base,
        { path: 'bin', sha256: 'f'.repeat(64) }, // 'bin' is a real directory in this tree
      ]);
      const loc = loadVerifiedModule('pro', { dir }, [pubB64]);
      expect(loc).not.toBeNull();
      expect(loc!.regenerated).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a symlink planted at a listed path, pointing outside the tree -> regen (content mismatch, never silently trusted)', () => {
    const dir = tmpDir();
    try {
      const { pubB64, version } = installSignedV2(dir); // the REAL digest list, unmodified
      const handlersPath = moduleHandlersPath('pro', version, { dir });
      const outsideTarget = join(dir, 'outside-target.txt');
      writeFileSync(outsideTarget, 'different content than pro-handlers.mjs');
      rmSync(handlersPath, { force: true });
      try {
        symlinkSync(outsideTarget, handlersPath, 'file');
      } catch {
        // Some platforms/accounts refuse symlink creation without elevated
        // privilege (notably non-admin Windows without Developer Mode) — skip
        // this case rather than fail the suite on an environment limitation.
        return;
      }

      const loc = loadVerifiedModule('pro', { dir }, [pubB64]);
      expect(loc).not.toBeNull();
      expect(loc!.regenerated).toBe(true);
      // The regen restored the REAL signed bytes — the symlink is gone,
      // replaced by a plain file holding the original plaintext.
      expect(readFileSync(handlersPath, 'utf8')).toBe(
        'export default { manifest: {}, register(){} }'
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('loadVerifiedModule — regen output re-verifies on the NEXT load (T3)', () => {
  it('tamper -> first load regenerates; second load on the untouched result takes the fast path', () => {
    const dir = tmpDir();
    try {
      const { pubB64, version } = installSignedV2(dir);
      const handlersPath = moduleHandlersPath('pro', version, { dir });
      writeFileSync(handlersPath, 'export default { EVIL: true }');

      const first = loadVerifiedModule('pro', { dir }, [pubB64]);
      expect(first).not.toBeNull();
      expect(first!.regenerated).toBe(true);

      // The regen's OUTPUT must itself satisfy the SAME signed digest list —
      // otherwise the fast path would be permanently dead (every boot pays the
      // full regen cost forever, invisibly, because installBundle's unpack
      // never actually reproduces what pack-module.mjs signed).
      const second = loadVerifiedModule('pro', { dir }, [pubB64]);
      expect(second).not.toBeNull();
      expect(second!.regenerated).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('verifyFastPath — tree-enumeration failure (T9)', () => {
  it.skipIf(process.platform === 'win32')(
    'an unreadable subdirectory makes listFilesRecursive throw -> regen path (POSIX-only: Windows chmod does not restrict directory reads)',
    () => {
      const dir = tmpDir();
      try {
        const { pubB64, version } = installSignedV2(dir);
        const binDir = join(installedModuleDir('pro', version, { dir }), 'bin');
        chmodSync(binDir, 0o000); // unreadable — readdirSync(binDir) throws EACCES
        try {
          const loc = loadVerifiedModule('pro', { dir }, [pubB64]);
          expect(loc).not.toBeNull();
          expect(loc!.regenerated).toBe(true);
        } finally {
          chmodSync(binDir, 0o755); // restore so the outer rmSync cleanup can recurse into it
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});
