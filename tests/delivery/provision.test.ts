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
  installedPath,
  loadVerifiedModule,
} from '@editmamei/delivery/store.ts';
import { KERNEL_ABI } from '@editmamei/kernel/host-api.ts';
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

describe('provisionModules — manifest abi validation', () => {
  /**
   * Serve `fake`'s manifest with the pro entry's `abi` replaced (`undefined`
   * deletes the field). Everything else — artifact bytes, content key, signature
   * — stays honest, so any refusal is attributable to the abi alone.
   */
  function withAbi(fake: ReturnType<typeof fakeDelivery>, abi: unknown): DeliveryFetch {
    return async (url, init) => {
      const res = await fake.fetchImpl(url, init);
      if (!url.endsWith('/v1/modules/manifest')) return res;
      const m = JSON.parse(await res.text()) as { modules: { pro: Record<string, unknown> } };
      if (abi === undefined) delete m.modules.pro.abi;
      else m.modules.pro.abi = abi;
      return jsonRes(200, m);
    };
  }

  /**
   * Same, but splicing a RAW JSON token into the manifest text — the only way to
   * deliver a value `JSON.stringify` cannot round-trip (`1e400` parses to
   * Infinity, whereas stringifying Infinity would quietly write `null` and test
   * the wrong thing). Throws if the token it edits ever moves.
   */
  function withRawAbi(fake: ReturnType<typeof fakeDelivery>, token: string): DeliveryFetch {
    return async (url, init) => {
      const res = await fake.fetchImpl(url, init);
      if (!url.endsWith('/v1/modules/manifest')) return res;
      const original = await res.text();
      const text = original.replace('"abi":1,', `"abi":${token},`);
      if (text === original) throw new Error('fixture drift: no `"abi":1,` in the fake manifest');
      return {
        ok: true,
        status: 200,
        text: async () => text,
        arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer,
      };
    };
  }

  const MANIFEST_URL = `${cfg.baseUrl}/v1/modules/manifest`;

  // Every one of these used to sail past provisioning into installed.json — and
  // through installModule's prune, which deletes the version that was working.
  // They split into two classes once installed: anything that is not a JSON
  // number (missing/string/bool/null) wedges the pointer, because
  // readInstalledModule's `typeof abi === 'number'` check then rejects it on
  // every boot; an out-of-range NUMBER persists readably and merely leaves Pro
  // dark. Both are refused here, before either outcome can happen.
  const badAbis: [string, unknown][] = [
    ['missing', undefined],
    ['a string', '1'],
    ['a boolean', true],
    ['null', null],
    ['zero', 0],
    ['negative', -1],
    ['fractional', 0.5],
    ['above KERNEL_ABI', KERNEL_ABI + 1],
    ['absurdly large', 2 ** 53],
  ];

  for (const [label, abi] of badAbis) {
    it(`refuses an entry whose abi is ${label} (no fetch, no install)`, async () => {
      const dir = tmpDir();
      const fake = fakeDelivery('0.17.0');
      try {
        const res = await provisionModules('K', {
          dir,
          config: cfg,
          fetchImpl: withAbi(fake, abi),
          signingKeys: [fake.pubB64],
        });
        expect(res.installed).toEqual([]);
        expect(res.errors[0]?.sku).toBe('pro');
        expect(res.errors[0]?.message).toMatch(/abi/);
        // installModule was never reached: no pointer file at all, and the
        // artifact + content key were never even requested.
        expect(existsSync(installedPath('pro', { dir }))).toBe(false);
        expect(fake.calls).toEqual([MANIFEST_URL]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('refuses an entry whose abi is a non-finite JSON number (no fetch, no install)', async () => {
    // `1e400` is valid JSON that parses to Infinity — the one bad shape that has
    // to arrive as raw text, and the one JSON.stringify would later write as
    // `null`, wedging the pointer.
    const dir = tmpDir();
    const fake = fakeDelivery('0.17.0');
    try {
      const res = await provisionModules('K', {
        dir,
        config: cfg,
        fetchImpl: withRawAbi(fake, '1e400'),
        signingKeys: [fake.pubB64],
      });
      expect(res.installed).toEqual([]);
      expect(res.errors[0]?.code).toBe('abi_invalid');
      expect(existsSync(installedPath('pro', { dir }))).toBe(false);
      expect(fake.calls).toEqual([MANIFEST_URL]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('separates the two refusals: a malformed entry vs. a host that is simply too old', async () => {
    // `editmamei repair` and the background self-heal both branch on these codes
    // and must point at the actual cure, which differs: a malformed entry is a
    // real failure, while a too-old host is not. A fielded host hits the second
    // one every boot after an ABI bump, and "update Editmamei" is the only thing
    // that helps.
    const dir = tmpDir();
    const fake = fakeDelivery('0.17.0');
    try {
      const malformed = await provisionModules('K', {
        dir,
        config: cfg,
        fetchImpl: withAbi(fake, '1'),
        signingKeys: [fake.pubB64],
      });
      expect(malformed.errors[0]?.code).toBe('abi_invalid');
      expect(malformed.errors[0]?.message).toMatch(/manifest entry .* invalid abi/i);
      expect(malformed.errors[0]?.message).not.toMatch(/update Editmamei/i);

      const tooNew = await provisionModules('K', {
        dir,
        config: cfg,
        fetchImpl: withAbi(fake, KERNEL_ABI + 1),
        signingKeys: [fake.pubB64],
      });
      expect(tooNew.errors[0]?.code).toBe('abi_too_new');
      expect(tooNew.errors[0]?.message).toMatch(/needs a newer Editmamei/i);
      expect(tooNew.errors[0]?.message).toMatch(/update Editmamei/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts abi at the top of the window (KERNEL_ABI) — the gate is inclusive', async () => {
    const dir = tmpDir();
    const fake = fakeDelivery('0.17.0');
    try {
      const res = await provisionModules('K', {
        dir,
        config: cfg,
        fetchImpl: withAbi(fake, KERNEL_ABI),
        signingKeys: [fake.pubB64],
      });
      expect(res.errors).toEqual([]);
      expect(res.installed).toEqual([{ sku: 'pro', version: '0.17.0' }]);
      expect(readInstalledModule('pro', { dir })?.abi).toBe(KERNEL_ABI);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves a WORKING installed module untouched when the manifest goes abi-too-new', async () => {
    // The aggravator the gate exists for: installModule prunes prior versions, so
    // a too-new entry that reached install would delete the module that works and
    // leave one this host can't load (the kernel skips it) in its place.
    const dir = tmpDir();
    const good = fakeDelivery('1.0.0');
    const tooNew = fakeDelivery('2.0.0');
    try {
      await provisionModules('K', {
        dir,
        config: cfg,
        fetchImpl: good.fetchImpl,
        signingKeys: [good.pubB64],
      });
      expect(readInstalledModule('pro', { dir })?.version).toBe('1.0.0');

      const res = await provisionModules('K', {
        dir,
        config: cfg,
        fetchImpl: withAbi(tooNew, KERNEL_ABI + 1),
        signingKeys: [tooNew.pubB64],
      });
      expect(res.installed).toEqual([]);
      expect(res.errors[0]?.message).toMatch(/abi/);

      // Still on the working module — and its directory survived the prune that
      // never ran, so it still loads.
      expect(readInstalledModule('pro', { dir })?.version).toBe('1.0.0');
      expect(existsSync(installedModuleDir('pro', '1.0.0', { dir }))).toBe(true);
      expect(existsSync(installedModuleDir('pro', '2.0.0', { dir }))).toBe(false);
      expect(loadVerifiedModule('pro', { dir }, [good.pubB64])).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a malformed abi never reaches the pointer, so the corrupt self-heal cannot wedge', async () => {
    // A non-numeric abi used to be JSON.stringify'd into installed.json, where
    // readInstalledModule's strict shape check then rejected the pointer on EVERY
    // boot: 'corrupt' -> FORCED re-provision -> the same unreadable pointer
    // rewritten, forever, re-downloading the artifact each time. `force` is the
    // exact flag that path uses, so it must not reopen the door.
    const dir = tmpDir();
    const good = fakeDelivery('1.0.0');
    const broken = fakeDelivery('1.0.0');
    try {
      await provisionModules('K', {
        dir,
        config: cfg,
        fetchImpl: good.fetchImpl,
        signingKeys: [good.pubB64],
      });
      const before = readInstalledModule('pro', { dir });
      expect(before?.abi).toBe(1);

      const res = await provisionModules('K', {
        dir,
        force: true,
        config: cfg,
        fetchImpl: withAbi(broken, '2'),
        signingKeys: [broken.pubB64],
      });
      expect(res.installed).toEqual([]);
      expect(res.errors[0]?.message).toMatch(/abi/);

      // The pointer is unchanged and still READABLE — nothing became corrupt, so
      // there is no force-re-provision to repeat, and no artifact was re-fetched.
      expect(readInstalledModule('pro', { dir })).toEqual(before);
      expect(broken.calls).toEqual([MANIFEST_URL]);
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
