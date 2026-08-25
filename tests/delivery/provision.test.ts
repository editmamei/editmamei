import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { provisionModules, compareVersions } from '@editmamei/delivery/provision.ts';
import { sha256Hex } from '@editmamei/delivery/crypto.ts';
import {
  moduleSigMessage,
  moduleSigV2Message,
  digestsRootSha256Hex,
  type ModuleFileDigest,
} from '@editmamei/delivery/signing.ts';
import {
  readInstalledModule,
  moduleHandlersPath,
  moduleArtifactPath,
  installedModuleDir,
  loadVerifiedModule,
} from '@editmamei/delivery/store.ts';
import { packBundle, type BundleFile } from '@editmamei/delivery/bundle.ts';
import type { DeliveryFetch, DeliveryResponse } from '@editmamei/delivery/client.ts';

const cfg = { baseUrl: 'http://localhost:8787' };

/** The plaintext files a realistic module bundle unpacks to (handlers + binary + manifest). */
function moduleFiles(): BundleFile[] {
  return [
    { name: 'pro-handlers.mjs', data: Buffer.from('export default {}') },
    { name: 'bin/editmamei-core-win-x64.exe', data: Buffer.from([0x4d, 0x5a]) },
    { name: 'manifest.json', data: Buffer.from(JSON.stringify({ sku: 'pro' })) },
  ];
}

function jsonRes(status: number, body: unknown): DeliveryResponse {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer,
  };
}
function bytesRes(bytes: Uint8Array): DeliveryResponse {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return { ok: true, status: 200, text: async () => '', arrayBuffer: async () => ab };
}

/**
 * Build a fake delivery service for one Pro module at `version`. Mints an
 * ephemeral Ed25519 signer and signs (sku, version, sha256) into the manifest
 * entry; the matching `pubB64` is passed to provisionModules as `signingKeys` so
 * the real verification path runs. `sign: false` omits the signature (to exercise
 * the fail-closed refusal).
 *
 * `v2` optionally adds the boot-fast-path fields to the manifest entry:
 * `'valid'` signs them with the SAME key as v1 (the real packer's behavior);
 * `'invalid'` signs `sig_v2` with a DIFFERENT (unpinned) key so provisionModules'
 * own v2 verification fails while v1 stays good; `'none'` (default) omits both,
 * matching every pre-v2 manifest.
 */
function fakeDelivery(
  version: string,
  { sign = true, v2 = 'none' }: { sign?: boolean; v2?: 'none' | 'valid' | 'invalid' } = {}
) {
  const key = randomBytes(32);
  const files = moduleFiles();
  const blob = packBundle(files, key.toString('base64'));
  const sha256 = sha256Hex(blob);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const sig = sign
    ? edSign(null, moduleSigMessage('pro', version, sha256), privateKey).toString('base64')
    : undefined;

  let filesDigest: ModuleFileDigest[] | undefined;
  let sigV2: string | undefined;
  if (v2 !== 'none') {
    filesDigest = files.map((f) => ({ path: f.name, sha256: sha256Hex(f.data) }));
    const root = digestsRootSha256Hex(filesDigest);
    const v2Priv = v2 === 'valid' ? privateKey : generateKeyPairSync('ed25519').privateKey;
    sigV2 = edSign(null, moduleSigV2Message('pro', version, sha256, root), v2Priv).toString(
      'base64'
    );
  }

  const manifest = {
    generated_at: '2026-06-16T00:00:00Z',
    modules: {
      pro: {
        latest: version,
        abi: 1,
        versions: {
          [version]: {
            object: `modules/pro/${version}.enc`,
            sha256,
            size: blob.length,
            sig,
            ...(filesDigest ? { files: filesDigest } : {}),
            ...(sigV2 ? { sig_v2: sigV2 } : {}),
          },
        },
      },
    },
    license: { status: 'granted', expires_at: null },
  };
  const calls: string[] = [];
  const fetchImpl: DeliveryFetch = async (url) => {
    calls.push(url);
    if (url.endsWith('/v1/modules/manifest')) return jsonRes(200, manifest);
    if (url.endsWith('/v1/modules/pro/key'))
      return jsonRes(200, { alg: 'AES-256-GCM', key: key.toString('base64') });
    if (url.endsWith(`/v1/modules/pro/${version}`)) return bytesRes(blob);
    return jsonRes(404, { error: 'unknown_module' });
  };
  return { fetchImpl, calls, sha256, keyB64: key.toString('base64'), blob, pubB64 };
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'em-prov-'));
}

describe('provisionModules', () => {
  it('reports notConfigured (no-op) when the delivery endpoint is unset', async () => {
    const res = await provisionModules('K', { config: { baseUrl: '' } });
    expect(res.notConfigured).toBe(true);
    expect(res.installed).toEqual([]);
  });

  it('fetches, verifies, decrypts, and installs the entitled module', async () => {
    const dir = tmpDir();
    const fake = fakeDelivery('0.17.0');
    try {
      const res = await provisionModules('LICENSE-KEY', {
        dir,
        config: cfg,
        fetchImpl: fake.fetchImpl,
        signingKeys: [fake.pubB64],
      });
      expect(res.notConfigured).toBe(false);
      expect(res.errors).toEqual([]);
      expect(res.installed).toEqual([{ sku: 'pro', version: '0.17.0' }]);

      const installed = readInstalledModule('pro', { dir });
      expect(installed?.version).toBe('0.17.0');
      expect(installed?.sha256).toBe(fake.sha256);
      expect(installed?.content_key).toBe(fake.keyB64);
      expect(installed?.abi).toBe(1);
      // The bundle was decrypted + unpacked — the handler entry is on disk.
      expect(existsSync(moduleHandlersPath('pro', '0.17.0', { dir }))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent — skips a module already at the latest version', async () => {
    const dir = tmpDir();
    const first = fakeDelivery('0.17.0');
    const second = fakeDelivery('0.17.0');
    try {
      await provisionModules('K', {
        dir,
        config: cfg,
        fetchImpl: first.fetchImpl,
        signingKeys: [first.pubB64],
      });
      const again = await provisionModules('K', {
        dir,
        config: cfg,
        fetchImpl: second.fetchImpl,
        signingKeys: [second.pubB64],
      });
      expect(again.installed).toEqual([]);
      expect(again.skipped).toEqual([{ sku: 'pro', version: '0.17.0', reason: 'up-to-date' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to install a module with a missing/invalid signature (fail-closed)', async () => {
    const dir = tmpDir();
    const fake = fakeDelivery('0.17.0', { sign: false });
    try {
      const res = await provisionModules('K', {
        dir,
        config: cfg,
        fetchImpl: fake.fetchImpl,
        signingKeys: [fake.pubB64],
      });
      expect(res.installed).toEqual([]);
      expect(res.errors[0].sku).toBe('pro');
      expect(res.errors[0].message).toMatch(/signature verification failed/);
      expect(readInstalledModule('pro', { dir })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a manifest version that is not valid semver (no fetch, no install)', async () => {
    const dir = tmpDir();
    const fetchImpl: DeliveryFetch = async (url) => {
      if (url.endsWith('/v1/modules/manifest'))
        return jsonRes(200, {
          generated_at: 'x',
          modules: { pro: { latest: 'not-semver', abi: 1, versions: {} } },
          license: { status: 'granted', expires_at: null },
        });
      return jsonRes(404, {});
    };
    try {
      const res = await provisionModules('K', { dir, config: cfg, fetchImpl });
      expect(res.installed).toEqual([]);
      expect(res.errors[0].message).toMatch(/not valid semver/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a manifest sku with an invalid format (no fetch, no install)', async () => {
    const dir = tmpDir();
    const fetchImpl: DeliveryFetch = async (url) => {
      if (url.endsWith('/v1/modules/manifest'))
        return jsonRes(200, {
          generated_at: 'x',
          modules: { 'bad sku!': { latest: '0.17.0', abi: 1, versions: {} } },
          license: { status: 'granted', expires_at: null },
        });
      return jsonRes(404, {});
    };
    try {
      const res = await provisionModules('K', { dir, config: cfg, fetchImpl });
      expect(res.installed).toEqual([]);
      expect(res.errors[0].message).toMatch(/invalid format/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an artifact whose declared size exceeds the cap (no install)', async () => {
    const dir = tmpDir();
    const fake = fakeDelivery('0.17.0');
    const fetchImpl: DeliveryFetch = async (url, init) => {
      const res = await fake.fetchImpl(url, init);
      if (url.endsWith('/v1/modules/manifest')) {
        const m = JSON.parse(await res.text());
        m.modules.pro.versions['0.17.0'].size = 1024 * 1024 * 1024; // 1 GB ≫ 64 MB cap
        return jsonRes(200, m);
      }
      return res;
    };
    try {
      const res = await provisionModules('K', {
        dir,
        config: cfg,
        fetchImpl,
        signingKeys: [fake.pubB64],
      });
      expect(res.installed).toEqual([]);
      expect(res.errors[0].message).toMatch(/exceeds the.*cap/);
      expect(readInstalledModule('pro', { dir })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records an error (no install) on a sha256 mismatch', async () => {
    const dir = tmpDir();
    const fake = fakeDelivery('0.17.0');
    // Corrupt the manifest hash so the downloaded bytes fail verification.
    const fetchImpl: DeliveryFetch = async (url, init) => {
      const res = await fake.fetchImpl(url, init);
      if (url.endsWith('/v1/modules/manifest')) {
        const m = JSON.parse(await res.text());
        m.modules.pro.versions['0.17.0'].sha256 = 'tampered';
        return jsonRes(200, m);
      }
      return res;
    };
    try {
      const res = await provisionModules('K', { dir, config: cfg, fetchImpl });
      expect(res.installed).toEqual([]);
      expect(res.errors[0].sku).toBe('pro');
      expect(res.errors[0].message).toMatch(/sha256 mismatch/);
      expect(readInstalledModule('pro', { dir })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('collects a manifest fetch failure as an error without throwing (after retries)', async () => {
    const dir = tmpDir();
    // A persistent 503 is transient-classified, so the client retries it; a no-op sleep keeps
    // the test instant. After retries are exhausted the failure is collected, never thrown.
    const fetchImpl: DeliveryFetch = async () => jsonRes(503, { error: 'upstream_unavailable' });
    try {
      const res = await provisionModules('K', {
        dir,
        config: cfg,
        fetchImpl,
        sleep: async () => {},
      });
      expect(res.installed).toEqual([]);
      expect(res.errors[0].sku).toBe('*');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('blocks a signed downgrade — refuses a manifest latest older than installed', async () => {
    const dir = tmpDir();
    const newer = fakeDelivery('2.0.0');
    const older = fakeDelivery('1.0.0');
    try {
      await provisionModules('K', {
        dir,
        config: cfg,
        fetchImpl: newer.fetchImpl,
        signingKeys: [newer.pubB64],
      });
      const res = await provisionModules('K', {
        dir,
        config: cfg,
        fetchImpl: older.fetchImpl,
        signingKeys: [older.pubB64],
      });
      expect(res.installed).toEqual([]);
      expect(res.skipped[0].reason).toMatch(/downgrade-blocked/);
      // Still on the newer version — the downgrade did not take…
      expect(readInstalledModule('pro', { dir })?.version).toBe('2.0.0');
      // …and BOTH dirs are untouched: the newer install survives, the older was
      // never created (blocked before install AND before any prune could run).
      expect(existsSync(installedModuleDir('pro', '2.0.0', { dir }))).toBe(true);
      expect(existsSync(installedModuleDir('pro', '1.0.0', { dir }))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('force reinstalls the SAME version but never bypasses signature verification', async () => {
    const dir = tmpDir();
    const good = fakeDelivery('0.18.0');
    try {
      await provisionModules('K', {
        dir,
        config: cfg,
        fetchImpl: good.fetchImpl,
        signingKeys: [good.pubB64],
      });
      expect(readInstalledModule('pro', { dir })?.version).toBe('0.18.0');

      // force + a GOOD signature at the SAME version → reinstalls (bypasses only the
      // up-to-date equality skip).
      const res1 = await provisionModules('K', {
        dir,
        force: true,
        config: cfg,
        fetchImpl: good.fetchImpl,
        signingKeys: [good.pubB64],
      });
      expect(res1.installed).toEqual([{ sku: 'pro', version: '0.18.0' }]);

      // force + an UNSIGNED artifact at the same version → still REFUSED. force only
      // reached the equality skip, never the fail-closed signature verification.
      const unsigned = fakeDelivery('0.18.0', { sign: false });
      const res2 = await provisionModules('K', {
        dir,
        force: true,
        config: cfg,
        fetchImpl: unsigned.fetchImpl,
        signingKeys: [unsigned.pubB64],
      });
      expect(res2.installed).toEqual([]);
      expect(res2.errors[0]?.message).toMatch(/signature/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('loadVerifiedModule (boot integrity gate)', () => {
  /** Provision a real signed module into `dir`, returning the signer pub key. */
  async function installSigned(dir: string, version = '0.17.0') {
    const fake = fakeDelivery(version);
    const res = await provisionModules('K', {
      dir,
      config: cfg,
      fetchImpl: fake.fetchImpl,
      signingKeys: [fake.pubB64],
    });
    expect(res.installed).toEqual([{ sku: 'pro', version }]);
    return { ...fake, version };
  }

  it('loads a freshly provisioned, signature-verified module', async () => {
    const dir = tmpDir();
    try {
      const { pubB64, version } = await installSigned(dir);
      const loc = loadVerifiedModule('pro', { dir }, [pubB64]);
      expect(loc?.version).toBe(version);
      expect(existsSync(loc!.handlersPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to load when the retained artifact is tampered (hash mismatch)', async () => {
    const dir = tmpDir();
    try {
      const { pubB64, version } = await installSigned(dir);
      writeFileSync(moduleArtifactPath('pro', version, { dir }), randomBytes(64));
      expect(loadVerifiedModule('pro', { dir }, [pubB64])).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to load when the signature does not verify against the pinned key', async () => {
    const dir = tmpDir();
    try {
      await installSigned(dir);
      // A different (un-pinned) key must not validate the stored signature.
      const other = generateKeyPairSync('ed25519')
        .publicKey.export({ format: 'der', type: 'spki' })
        .toString('base64');
      expect(loadVerifiedModule('pro', { dir }, [other])).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('heals a swapped pro-handlers.mjs by regenerating from the verified artifact', async () => {
    const dir = tmpDir();
    try {
      const { pubB64, version } = await installSigned(dir);
      const handlers = moduleHandlersPath('pro', version, { dir });
      writeFileSync(handlers, Buffer.from('export default { EVIL: true }'));
      const loc = loadVerifiedModule('pro', { dir }, [pubB64]);
      expect(loc?.version).toBe(version);
      // The tampered handler was overwritten with the signed bytes before import.
      expect(readFileSync(handlers, 'utf8')).toBe('export default {}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('provisionModules — v2 fast-boot fields (2026-07-29)', () => {
  it('(i) persists files + sig_v2 when the manifest supplies a validly-signed v2 pair', async () => {
    const dir = tmpDir();
    const fake = fakeDelivery('0.19.0', { v2: 'valid' });
    try {
      const res = await provisionModules('K', {
        dir,
        config: cfg,
        fetchImpl: fake.fetchImpl,
        signingKeys: [fake.pubB64],
      });
      expect(res.installed).toEqual([{ sku: 'pro', version: '0.19.0' }]);
      expect(res.errors).toEqual([]);

      const installed = readInstalledModule('pro', { dir });
      expect(installed?.files).toBeDefined();
      expect(installed?.sig_v2).toBeDefined();
      expect(installed?.files?.length).toBeGreaterThan(0);

      // A downstream boot can then take the v2 fast path.
      const loc = loadVerifiedModule('pro', { dir }, [fake.pubB64]);
      expect(loc).not.toBeNull();
      expect(loc!.regenerated).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(i) a bad sig_v2 is not persisted, but the install still succeeds on v1 trust alone', async () => {
    const dir = tmpDir();
    const fake = fakeDelivery('0.19.0', { v2: 'invalid' });
    try {
      const res = await provisionModules('K', {
        dir,
        config: cfg,
        fetchImpl: fake.fetchImpl,
        signingKeys: [fake.pubB64],
      });
      // The install succeeds — v2 is a pure optimization layered on v1, never a
      // gate on the install itself.
      expect(res.installed).toEqual([{ sku: 'pro', version: '0.19.0' }]);
      expect(res.errors).toEqual([]);

      const installed = readInstalledModule('pro', { dir });
      expect(installed?.files).toBeUndefined();
      expect(installed?.sig_v2).toBeUndefined();

      // Boot still works — just via the (slower) full regen, never a silent
      // downgrade of trust.
      const loc = loadVerifiedModule('pro', { dir }, [fake.pubB64]);
      expect(loc).not.toBeNull();
      expect(loc!.regenerated).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(T6) manifest carries `files` without `sig_v2` (half-present pair) -> neither v2 field persisted, install still succeeds', async () => {
    const dir = tmpDir();
    const fake = fakeDelivery('0.20.0', { v2: 'valid' });
    const fetchImpl: DeliveryFetch = async (url, init) => {
      const res = await fake.fetchImpl(url, init);
      if (url.endsWith('/v1/modules/manifest')) {
        const m = JSON.parse(await res.text());
        delete m.modules.pro.versions['0.20.0'].sig_v2; // files present, sig_v2 stripped
        return jsonRes(200, m);
      }
      return res;
    };
    try {
      const res = await provisionModules('K', {
        dir,
        config: cfg,
        fetchImpl,
        signingKeys: [fake.pubB64],
      });
      expect(res.installed).toEqual([{ sku: 'pro', version: '0.20.0' }]);
      expect(res.errors).toEqual([]);
      const installed = readInstalledModule('pro', { dir });
      expect(installed?.files).toBeUndefined();
      expect(installed?.sig_v2).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(T6) manifest carries `sig_v2` without `files` (the other half-present pair) -> neither v2 field persisted, install still succeeds', async () => {
    const dir = tmpDir();
    const fake = fakeDelivery('0.20.1', { v2: 'valid' });
    const fetchImpl: DeliveryFetch = async (url, init) => {
      const res = await fake.fetchImpl(url, init);
      if (url.endsWith('/v1/modules/manifest')) {
        const m = JSON.parse(await res.text());
        delete m.modules.pro.versions['0.20.1'].files; // sig_v2 present, files stripped
        return jsonRes(200, m);
      }
      return res;
    };
    try {
      const res = await provisionModules('K', {
        dir,
        config: cfg,
        fetchImpl,
        signingKeys: [fake.pubB64],
      });
      expect(res.installed).toEqual([{ sku: 'pro', version: '0.20.1' }]);
      expect(res.errors).toEqual([]);
      const installed = readInstalledModule('pro', { dir });
      expect(installed?.files).toBeUndefined();
      expect(installed?.sig_v2).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('compareVersions', () => {
  it('a release outranks a prerelease of the same core', () => {
    // module-lifecycle.ts's forward-compat degrade compares an installed module's
    // version against the host's own VERSION — if the HOST build is itself a
    // release-candidate prerelease (e.g. '1.3.0-rc.1') and a fully-released module
    // ships at the same core version, the release module correctly reads as newer.
    // Firing the degrade for an RC host against the released module it's a
    // release-candidate FOR is intentional, not a bug: the RC is the stale side.
    expect(compareVersions('1.3.0', '1.3.0-rc.1')).toBeGreaterThan(0);
    expect(compareVersions('1.3.0-rc.1', '1.3.0')).toBeLessThan(0);
  });
});
