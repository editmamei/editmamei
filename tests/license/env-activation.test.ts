import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { maybeActivateFromEnv } from '@editmamei/license/env-activation.ts';
import { writeLicense, readLicense, type LicenseRecord } from '@editmamei/license/store.ts';
import type { PolarConfig } from '@editmamei/license/config.ts';
import type { FetchLike } from '@editmamei/license/polar-client.ts';
import { sha256Hex } from '@editmamei/delivery/crypto.ts';
import { moduleSigMessage } from '@editmamei/delivery/signing.ts';
import { readInstalledModule, PRO_SKU } from '@editmamei/delivery/store.ts';
import { packBundle, type BundleFile } from '@editmamei/delivery/bundle.ts';
import type { DeliveryFetch, DeliveryResponse } from '@editmamei/delivery/client.ts';

const CFG: PolarConfig = { env: 'sandbox', baseUrl: 'https://api.test/v1', organizationId: 'org' };

const okFetch: FetchLike = async (url) => {
  const body = url.includes('/activate')
    ? {
        id: 'act',
        license_key: { id: 'lk', display_key: '****-Z', status: 'granted', expires_at: null },
      }
    : {
        id: 'lk',
        status: 'granted',
        limit_activations: 2,
        usage: 0,
        validations: 1,
        expires_at: null,
        last_validated_at: null,
        display_key: '****-Z',
      };
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
};

function rec(over: Partial<LicenseRecord> = {}): LicenseRecord {
  return {
    key: 'EDIT-33333333-3333-4333-8333-333333333333',
    organization_id: 'org',
    status: 'granted',
    expires_at: null,
    activation_id: 'a',
    device_hash: 'd',
    display_key: '****-Z',
    last_validated_at: new Date().toISOString(),
    ...over,
  };
}

// A delivery endpoint that returns nothing usable — DeliveryClient throws
// `not_configured`, so provisionModules is a clean no-op (no network). Used by
// the activation-focused tests that reach the provision gate but don't exercise it.
const NO_DELIVERY = { config: { baseUrl: '' } } as const;

// --- A fake delivery service for one Pro module (mirrors tests/delivery/provision.test.ts) ---

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
 * Build a working fake delivery service for one Pro module at `version`. Mints an
 * ephemeral Ed25519 signer, signs (sku, version, sha256) into the manifest, and
 * returns the matching `pubB64` to pass as `signingKeys` so the real verification
 * path runs. `calls` records every URL hit.
 */
function fakeDelivery(version: string) {
  const key = randomBytes(32);
  const files: BundleFile[] = [
    { name: 'pro-handlers.mjs', data: Buffer.from('export default {}') },
    { name: 'bin/editmamei-core-win-x64.exe', data: Buffer.from([0x4d, 0x5a]) },
    { name: 'manifest.json', data: Buffer.from(JSON.stringify({ sku: 'pro' })) },
  ];
  const blob = packBundle(files, key.toString('base64'));
  const sha256 = sha256Hex(blob);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const sig = edSign(null, moduleSigMessage('pro', version, sha256), privateKey).toString('base64');
  const manifest = {
    generated_at: '2026-06-20T00:00:00Z',
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
  const calls: string[] = [];
  const fetchImpl: DeliveryFetch = async (url) => {
    calls.push(url);
    if (url.endsWith('/v1/modules/manifest')) return jsonRes(200, manifest);
    if (url.endsWith('/v1/modules/pro/key'))
      return jsonRes(200, { alg: 'AES-256-GCM', key: key.toString('base64') });
    if (url.endsWith(`/v1/modules/pro/${version}`)) return bytesRes(blob);
    return jsonRes(404, { error: 'unknown_module' });
  };
  return { fetchImpl, calls, pubB64 };
}

/** Delivery options that drive the fake without real waiting. */
function deliveryOpts(d: ReturnType<typeof fakeDelivery>) {
  return {
    config: { baseUrl: 'http://localhost:8787' },
    fetchImpl: d.fetchImpl,
    signingKeys: [d.pubB64],
    sleep: async () => {},
  };
}

describe('maybeActivateFromEnv', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'em-env-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('no env key → no-op (no license written)', async () => {
    await maybeActivateFromEnv({}, { dir, config: CFG, fetchImpl: okFetch });
    expect(readLicense({ dir })).toBeNull();
  });

  it('blank/whitespace env key → no-op', async () => {
    await maybeActivateFromEnv(
      { EDITMAMEI_LICENSE_KEY: '   ' },
      { dir, config: CFG, fetchImpl: okFetch }
    );
    expect(readLicense({ dir })).toBeNull();
  });

  it('unfilled ${user_config.license_key} placeholder → no request, no warning', async () => {
    let calls = 0;
    const counting: FetchLike = async (...a) => {
      calls++;
      return okFetch(...a);
    };
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await maybeActivateFromEnv(
        { EDITMAMEI_LICENSE_KEY: '${user_config.license_key}' },
        { dir, config: CFG, fetchImpl: counting },
        NO_DELIVERY
      );
      expect(calls).toBe(0);
      expect(readLicense({ dir })).toBeNull();
      expect(stderr.mock.calls.join('')).not.toMatch(/EDITMAMEI_LICENSE_KEY/);
    } finally {
      stderr.mockRestore();
    }
  });

  it('malformed env key → no request, warns, stays Community', async () => {
    let calls = 0;
    const counting: FetchLike = async (...a) => {
      calls++;
      return okFetch(...a);
    };
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await maybeActivateFromEnv(
        { EDITMAMEI_LICENSE_KEY: 'not-a-license-key' },
        { dir, config: CFG, fetchImpl: counting },
        NO_DELIVERY
      );
      expect(calls).toBe(0);
      expect(readLicense({ dir })).toBeNull();
      expect(stderr.mock.calls.join('')).toMatch(/isn't an Editmamei license key/);
    } finally {
      stderr.mockRestore();
    }
  });

  it('env key + no cache → activates and writes the license', async () => {
    await maybeActivateFromEnv(
      { EDITMAMEI_LICENSE_KEY: 'EDIT-44444444-4444-4444-8444-444444444444' },
      { dir, config: CFG, fetchImpl: okFetch },
      NO_DELIVERY
    );
    expect(readLicense({ dir })?.key).toBe('EDIT-44444444-4444-4444-8444-444444444444');
  });

  it('env key === cached key → does NOT re-activate (no Polar seat burn)', async () => {
    writeLicense(rec({ key: 'EDIT-22222222-2222-4222-8222-222222222222' }), { dir });
    let polarCalled = false;
    const spy: FetchLike = async (url, init) => {
      polarCalled = true;
      return okFetch(url, init);
    };
    await maybeActivateFromEnv(
      { EDITMAMEI_LICENSE_KEY: 'EDIT-22222222-2222-4222-8222-222222222222' },
      { dir, config: CFG, fetchImpl: spy },
      NO_DELIVERY
    );
    expect(polarCalled).toBe(false);
  });

  describe('a record marked activation_removed', () => {
    const urlsFor = (activateStatus = 200) => {
      const urls: string[] = [];
      const fetchImpl: FetchLike = async (url, init) => {
        urls.push(url);
        const withId = (JSON.parse(init.body) as { activation_id?: string }).activation_id;
        if (url.includes('/validate') && withId) {
          return { ok: false, status: 404, text: async () => '' };
        }
        if (url.includes('/activate') && activateStatus !== 200) {
          return { ok: false, status: activateStatus, text: async () => 'activation limit' };
        }
        return okFetch(url, init);
      };
      return { urls, fetchImpl };
    };
    const boot = (fetchImpl: FetchLike, extra: Record<string, unknown> = {}) =>
      maybeActivateFromEnv(
        { EDITMAMEI_LICENSE_KEY: 'EDIT-22222222-2222-4222-8222-222222222222' },
        { dir, config: CFG, fetchImpl, ...extra },
        NO_DELIVERY
      );

    it('takes a new seat, and the next boot takes none', async () => {
      writeLicense(
        rec({ key: 'EDIT-22222222-2222-4222-8222-222222222222', activation_removed: true }),
        { dir }
      );
      const { urls, fetchImpl } = urlsFor();
      await boot(fetchImpl);
      expect(readLicense({ dir })).toMatchObject({ activation_id: 'act' });
      expect(readLicense({ dir })?.activation_removed).toBeUndefined();
      expect(urls.filter((u) => u.includes('/activate'))).toHaveLength(1);

      urls.length = 0;
      await boot(fetchImpl);
      expect(urls).toEqual([]);
    });

    it('backs off after a refusal, so the next boot makes no request', async () => {
      writeLicense(
        rec({ key: 'EDIT-22222222-2222-4222-8222-222222222222', activation_removed: true }),
        { dir }
      );
      const { urls, fetchImpl } = urlsFor(403);
      await boot(fetchImpl);
      expect(urls.some((u) => u.includes('/activate'))).toBe(true);
      expect(readLicense({ dir })?.activation_removed).toBe(true);

      urls.length = 0;
      await boot(fetchImpl);
      expect(urls).toEqual([]);
    });

    it('makes no request for a license the last check found inactive or ended', async () => {
      const { urls, fetchImpl } = urlsFor();
      writeLicense(
        rec({
          key: 'EDIT-22222222-2222-4222-8222-222222222222',
          activation_removed: true,
          status: 'revoked',
        }),
        { dir }
      );
      await boot(fetchImpl);
      const ended = new Date(Date.now() - 1000).toISOString();
      writeLicense(
        rec({
          key: 'EDIT-22222222-2222-4222-8222-222222222222',
          activation_removed: true,
          expires_at: ended,
        }),
        { dir }
      );
      await boot(fetchImpl);
      expect(urls).toEqual([]);
    });

    it('does not hold boot when the request hangs', async () => {
      writeLicense(
        rec({ key: 'EDIT-22222222-2222-4222-8222-222222222222', activation_removed: true }),
        { dir }
      );
      const hang: FetchLike = () => new Promise(() => {});
      await boot(hang, { expiredRefreshTimeoutMs: 20 });
      expect(readLicense({ dir })?.activation_removed).toBe(true);
    });
  });

  it('env key differs from cache → re-activates', async () => {
    writeLicense(rec({ key: 'EDIT-55555555-5555-4555-8555-555555555555' }), { dir });
    await maybeActivateFromEnv(
      { EDITMAMEI_LICENSE_KEY: 'EDIT-66666666-6666-4666-8666-666666666666' },
      { dir, config: CFG, fetchImpl: okFetch },
      NO_DELIVERY
    );
    expect(readLicense({ dir })?.key).toBe('EDIT-66666666-6666-4666-8666-666666666666');
  });

  it('activation failure never throws (boots as Community)', async () => {
    let calls = 0;
    const boom: FetchLike = async () => {
      calls++;
      throw new Error('network down');
    };
    await expect(
      // No-op backoff: the thrown fetch is retried, and this test is about
      // booting as Community regardless, not the retry schedule.
      maybeActivateFromEnv(
        { EDITMAMEI_LICENSE_KEY: 'EDIT-ABCDEF01-2345-4678-89AB-CDEF01234567' },
        { dir, config: CFG, fetchImpl: boom, client: { sleep: async () => {} } }
      )
    ).resolves.toBeUndefined();
    expect(calls).toBeGreaterThan(0);
    expect(existsSync(join(dir, 'license.json'))).toBe(false);
  });

  it('unconfigured production org never throws', async () => {
    await expect(
      maybeActivateFromEnv(
        { EDITMAMEI_LICENSE_KEY: 'X' },
        { dir, config: { ...CFG, organizationId: '' } }
      )
    ).resolves.toBeUndefined();
  });

  // --- Provisioning (the .mcpb unlock path — regression for the 2026-06-20 gap) ---

  it('cached + entitled + module NOT installed → provisions and installs the Pro module', async () => {
    // The exact Desktop scenario: a prior boot validated the key (cache present)
    // but the module never downloaded. This boot must provision it. On the old
    // code (no provision call) readInstalledModule stays null and this fails.
    writeLicense(rec({ key: 'EDIT-22222222-2222-4222-8222-222222222222' }), { dir });
    const d = fakeDelivery('0.17.4');
    await maybeActivateFromEnv(
      { EDITMAMEI_LICENSE_KEY: 'EDIT-22222222-2222-4222-8222-222222222222' },
      { dir, config: CFG, fetchImpl: okFetch },
      deliveryOpts(d)
    );
    expect(readInstalledModule(PRO_SKU, { dir })?.version).toBe('0.17.4');
    expect(d.calls.some((u) => u.endsWith('/v1/modules/manifest'))).toBe(true);
  });

  it('module already installed → does NOT re-fetch (no per-boot network)', async () => {
    writeLicense(rec({ key: 'EDIT-22222222-2222-4222-8222-222222222222' }), { dir });
    const first = fakeDelivery('0.17.4');
    await maybeActivateFromEnv(
      { EDITMAMEI_LICENSE_KEY: 'EDIT-22222222-2222-4222-8222-222222222222' },
      { dir, config: CFG, fetchImpl: okFetch },
      deliveryOpts(first)
    );
    expect(readInstalledModule(PRO_SKU, { dir })?.version).toBe('0.17.4');

    const second = fakeDelivery('0.17.4');
    await maybeActivateFromEnv(
      { EDITMAMEI_LICENSE_KEY: 'EDIT-22222222-2222-4222-8222-222222222222' },
      { dir, config: CFG, fetchImpl: okFetch },
      deliveryOpts(second)
    );
    expect(second.calls).toEqual([]); // gate short-circuits — no delivery hit
  });

  it('provision failure is non-fatal — license stays valid, Pro stays dark', async () => {
    writeLicense(rec({ key: 'EDIT-22222222-2222-4222-8222-222222222222' }), { dir });
    const boomDelivery: DeliveryFetch = async () => {
      throw new Error('delivery down');
    };
    await expect(
      maybeActivateFromEnv(
        { EDITMAMEI_LICENSE_KEY: 'EDIT-22222222-2222-4222-8222-222222222222' },
        { dir, config: CFG, fetchImpl: okFetch },
        {
          config: { baseUrl: 'http://localhost:8787' },
          fetchImpl: boomDelivery,
          sleep: async () => {},
        }
      )
    ).resolves.toBeUndefined();
    expect(readLicense({ dir })?.key).toBe('EDIT-22222222-2222-4222-8222-222222222222');
    expect(readInstalledModule(PRO_SKU, { dir })).toBeNull();
  });

  it('not entitled (grace-expired) → never provisions', async () => {
    // A stale cache past the grace window must not trigger a download.
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    writeLicense(
      rec({ key: 'EDIT-22222222-2222-4222-8222-222222222222', last_validated_at: old }),
      { dir }
    );
    const d = fakeDelivery('0.17.4');
    await maybeActivateFromEnv(
      { EDITMAMEI_LICENSE_KEY: 'EDIT-22222222-2222-4222-8222-222222222222' },
      { dir, config: CFG, fetchImpl: okFetch },
      deliveryOpts(d)
    );
    expect(d.calls).toEqual([]);
    expect(readInstalledModule(PRO_SKU, { dir })).toBeNull();
  });

  it('provisioning that stalls does not hang boot (bounded by bootTimeoutMs)', async () => {
    writeLicense(rec({ key: 'EDIT-22222222-2222-4222-8222-222222222222' }), { dir });
    const hangingFetch: DeliveryFetch = () => new Promise(() => {}); // never resolves
    await expect(
      maybeActivateFromEnv(
        { EDITMAMEI_LICENSE_KEY: 'EDIT-22222222-2222-4222-8222-222222222222' },
        { dir, config: CFG, fetchImpl: okFetch },
        {
          config: { baseUrl: 'http://localhost:8787' },
          fetchImpl: hangingFetch,
          sleep: async () => {},
          bootTimeoutMs: 30,
        }
      )
    ).resolves.toBeUndefined();
    expect(readInstalledModule(PRO_SKU, { dir })).toBeNull();
  });
});
