import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync } from 'node:crypto';
import { runRepair } from '@editmamei/cli/repair.ts';
import { writeLicense } from '@editmamei/license/store.ts';
import { readInstalledModule } from '@editmamei/delivery/store.ts';
import { fakeDelivery, fakeDeliveryConfig as cfg, jsonRes } from '../fixtures/fake-delivery.ts';
import { KERNEL_ABI } from '@editmamei/kernel/host-api.ts';

/**
 * `editmamei repair` — re-provision a wedged/outdated Pro module using the cached
 * license, without deleting ~/.editmamei. A thin wrapper over provisionModules;
 * these tests pin the CLI-specific behaviour (the no-license guard, the
 * notConfigured pass-through, and the install-success messaging + on-disk effect).
 */

function seedLicense(dir: string): void {
  writeLicense(
    {
      key: 'LICENSE-KEY',
      organization_id: 'org_test',
      status: 'granted',
      expires_at: null,
      activation_id: 'act',
      device_hash: 'dev',
      display_key: '****-T',
      last_validated_at: new Date().toISOString(),
    },
    { dir }
  );
}

describe('runRepair', () => {
  let dir: string;
  let out: string;
  let err: string;
  const o = (s: string) => {
    out += s;
  };
  const e = (s: string) => {
    err += s;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'em-repair-'));
    out = '';
    err = '';
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('errors (exit 1) with activation guidance when no license is cached', async () => {
    await expect(runRepair({ stdout: o, stderr: e, dir })).rejects.toThrow('no license');
    expect(err).toContain('editmamei activate');
  });

  it('re-provisions the Pro module and reports the install', async () => {
    seedLicense(dir);
    const fake = fakeDelivery('0.18.0');
    await runRepair({
      stdout: o,
      stderr: e,
      dir,
      delivery: {
        config: cfg,
        fetchImpl: fake.fetchImpl,
        signingKeys: [fake.pubB64],
        sleep: async () => {},
      },
    });
    expect(out).toContain('Installed pro module v0.18.0');
    expect(out).toContain('Restart your MCP client');
    expect(readInstalledModule('pro', { dir })?.version).toBe('0.18.0');
  });

  it('reports a clean no-op when module delivery is not configured', async () => {
    seedLicense(dir);
    await runRepair({ stdout: o, stderr: e, dir, delivery: { config: { baseUrl: '' } } });
    expect(out).toContain('not configured');
    expect(readInstalledModule('pro', { dir })).toBeNull();
  });

  it('exits non-zero (throws) when provisioning reports errors', async () => {
    seedLicense(dir);
    // Verify the delivered artifact against a MISMATCHED signing key so provision
    // fails the signature check → prov.errors non-empty → repair must throw so a
    // support script sees a real failure signal (not a silent exit 0).
    const fake = fakeDelivery('0.18.0');
    const wrong = generateKeyPairSync('ed25519')
      .publicKey.export({ format: 'der', type: 'spki' })
      .toString('base64');
    await expect(
      runRepair({
        stdout: o,
        stderr: e,
        dir,
        delivery: {
          config: cfg,
          fetchImpl: fake.fetchImpl,
          signingKeys: [wrong],
          sleep: async () => {},
        },
      })
    ).rejects.toThrow('module re-provisioning failed');
    expect(err).toContain('could not provision');
    expect(readInstalledModule('pro', { dir })).toBeNull(); // nothing installed
  });

  it('succeeds (exit 0) when the published module simply needs a newer host', async () => {
    // An entitled user on an older host hits this the moment the publisher bumps
    // the module ABI. Nothing is broken and no lever repair has can help, so it
    // must not look like a failure: stdout, not stderr, and no throw.
    seedLicense(dir);
    const fake = fakeDelivery('0.18.0');
    await runRepair({
      stdout: o,
      stderr: e,
      dir,
      delivery: {
        config: cfg,
        fetchImpl: async (url, init) => {
          const res = await fake.fetchImpl(url, init);
          if (!url.endsWith('/v1/modules/manifest')) return res;
          const m = JSON.parse(await res.text()) as { modules: { pro: { abi: number } } };
          m.modules.pro.abi = KERNEL_ABI + 1;
          return jsonRes(200, m);
        },
        signingKeys: [fake.pubB64],
        sleep: async () => {},
      },
    });
    expect(out).toMatch(/needs a newer Editmamei/i);
    expect(out).toContain('update Editmamei');
    expect(err).toBe(''); // never an Error: line
    expect(readInstalledModule('pro', { dir })).toBeNull(); // and nothing was installed
  });
});
