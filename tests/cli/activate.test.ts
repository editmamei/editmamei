import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runActivate } from '@editmamei/cli/activate.ts';
import { readLicense } from '@editmamei/license/store.ts';
import type { PolarConfig } from '@editmamei/license/config.ts';
import type { FetchLike } from '@editmamei/license/polar-client.ts';

const cfg: PolarConfig = { env: 'sandbox', baseUrl: 'https://api.test/v1', organizationId: 'org' };

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
        usage: 1,
        validations: 1,
        expires_at: null,
        last_validated_at: null,
        display_key: '****-Z',
      };
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
};

describe('runActivate', () => {
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
    dir = mkdtempSync(join(tmpdir(), 'em-cli-'));
    out = '';
    err = '';
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('activates and prints the unlock confirmation', async () => {
    await runActivate({
      key: 'ETTA-K',
      stdout: o,
      stderr: e,
      dir,
      fetchImpl: okFetch,
      config: cfg,
    });
    expect(out).toContain('Pro is unlocked');
    expect(out).toContain('****-Z');
    expect(readLicense({ dir })?.status).toBe('granted');
  });

  it('errors (exit 1) with a usage message when the key is missing', async () => {
    await expect(runActivate({ stdout: o, stderr: e, dir })).rejects.toThrow();
    expect(err).toContain('Usage: editmamei activate');
  });

  it('surfaces a seat-limit error to the user', async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: false,
      status: 403,
      text: async () => '{"detail":"License key activation limit already reached"}',
    });
    await expect(
      runActivate({ key: 'K', stdout: o, stderr: e, dir, fetchImpl, config: cfg })
    ).rejects.toThrow('seat_limit_reached');
    expect(err).toContain('maximum of 2 devices');
  });
});
