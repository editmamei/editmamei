import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runLicenseStatus } from '@editmamei/cli/license.ts';
import { writeLicense, type LicenseRecord } from '@editmamei/license/store.ts';
import type { PolarConfig } from '@editmamei/license/config.ts';
import type { FetchLike } from '@editmamei/license/polar-client.ts';

const cfg: PolarConfig = { env: 'sandbox', baseUrl: 'https://api.test/v1', organizationId: 'org' };

function rec(over: Partial<LicenseRecord> = {}): LicenseRecord {
  return {
    key: 'K',
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

const grantedFetch: FetchLike = async () => ({
  ok: true,
  status: 200,
  text: async () =>
    JSON.stringify({
      id: 'lk',
      status: 'granted',
      limit_activations: 2,
      usage: 0,
      validations: 2,
      expires_at: null,
      last_validated_at: null,
      display_key: '****-Z',
    }),
});

describe('runLicenseStatus', () => {
  let dir: string;
  let out: string;
  const o = (s: string) => {
    out += s;
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'em-cli-'));
    out = '';
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('prompts to activate when there is no license', async () => {
    await runLicenseStatus({ stdout: o, dir });
    expect(out).toContain('No license activated');
  });

  it('shows Pro unlocked after an online re-check returns granted', async () => {
    writeLicense(rec(), { dir });
    await runLicenseStatus({ stdout: o, dir, fetchImpl: grantedFetch, config: cfg });
    expect(out).toMatch(/Pro:\s+unlocked/);
  });

  it('degrades to the cached verdict + offline note when the re-check fails', async () => {
    // Old check → grace-expired once we can't refresh.
    writeLicense(rec({ last_validated_at: new Date(0).toISOString() }), { dir });
    const fetchImpl: FetchLike = async () => {
      throw new Error('offline');
    };
    await runLicenseStatus({ stdout: o, dir, fetchImpl, config: cfg });
    expect(out).toContain('offline');
    expect(out).toMatch(/Pro:\s+locked \(grace-expired\)/);
  });
});
