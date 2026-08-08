import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  evaluateEntitlement,
  isProEntitled,
  activate,
  refresh,
  deactivate,
  GRACE_MS,
  CLOCK_SKEW_TOLERANCE_MS,
} from '@editmamei/license/entitlement.ts';
import { readLicense, writeLicense, type LicenseRecord } from '@editmamei/license/store.ts';
import type { PolarConfig } from '@editmamei/license/config.ts';
import type { FetchLike } from '@editmamei/license/polar-client.ts';

const CFG: PolarConfig = {
  env: 'sandbox',
  baseUrl: 'https://api.test/v1',
  organizationId: 'org_test',
};
const NOW = Date.parse('2026-06-15T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function rec(over: Partial<LicenseRecord> = {}): LicenseRecord {
  return {
    key: 'ETTA-KEY',
    organization_id: 'org_test',
    status: 'granted',
    expires_at: null,
    activation_id: 'act_1',
    device_hash: 'dh',
    display_key: '****-AAAA',
    last_validated_at: new Date(NOW).toISOString(),
    ...over,
  };
}

interface Route {
  match: string;
  status?: number;
  body?: unknown;
}
function fakeFetch(routes: Route[]): {
  fetchImpl: FetchLike;
  bodies: Array<Record<string, unknown>>;
} {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    const r = routes.find((x) => url.includes(x.match));
    const status = r?.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(r?.body ?? {}),
    };
  };
  return { fetchImpl, bodies };
}

describe('evaluateEntitlement', () => {
  it('no record → not entitled (no-license)', () => {
    expect(evaluateEntitlement(null, NOW)).toEqual({ entitled: false, reason: 'no-license' });
  });
  it('granted + perpetual + recent check → entitled', () => {
    expect(evaluateEntitlement(rec(), NOW)).toEqual({ entitled: true, reason: 'granted' });
  });
  it('revoked / disabled → not entitled', () => {
    expect(evaluateEntitlement(rec({ status: 'revoked' }), NOW).reason).toBe('revoked');
    expect(evaluateEntitlement(rec({ status: 'disabled' }), NOW).reason).toBe('disabled');
  });
  it('past expires_at → expired', () => {
    expect(
      evaluateEntitlement(rec({ expires_at: new Date(NOW - 1000).toISOString() }), NOW).reason
    ).toBe('expired');
  });
  it('within the 30-day grace offline → entitled; past it → grace-expired', () => {
    expect(
      evaluateEntitlement(
        rec({ last_validated_at: new Date(NOW - GRACE_MS + 1000).toISOString() }),
        NOW
      ).entitled
    ).toBe(true);
    expect(
      evaluateEntitlement(
        rec({ last_validated_at: new Date(NOW - GRACE_MS - 1000).toISOString() }),
        NOW
      ).reason
    ).toBe('grace-expired');
  });

  // The persisted monotonic high-water-mark means
  // rolling the system clock back can't manufacture a fresh-looking record.
  describe('backward-clock guard', () => {
    it('(a) normal forward-time record, high_water_mark behind now → still entitled', () => {
      const r = rec({ high_water_mark: new Date(NOW - DAY_MS).toISOString() });
      expect(evaluateEntitlement(r, NOW)).toEqual({ entitled: true, reason: 'granted' });
    });

    it('(b) now set well BEFORE the stored high_water_mark (clock rolled back) → not entitled', () => {
      const r = rec({ high_water_mark: new Date(NOW).toISOString() });
      const rolledBackNow = NOW - 2 * DAY_MS;
      expect(evaluateEntitlement(r, rolledBackNow)).toEqual({
        entitled: false,
        reason: 'grace-expired',
      });
    });

    it('(c) boundary: now behind high_water_mark by exactly CLOCK_SKEW_TOLERANCE_MS → still entitled', () => {
      const r = rec({ high_water_mark: new Date(NOW).toISOString() });
      expect(evaluateEntitlement(r, NOW - CLOCK_SKEW_TOLERANCE_MS).entitled).toBe(true);
    });

    it('(c) boundary: now behind high_water_mark by tolerance + 1ms → grace-expired', () => {
      const r = rec({ high_water_mark: new Date(NOW).toISOString() });
      expect(evaluateEntitlement(r, NOW - CLOCK_SKEW_TOLERANCE_MS - 1)).toEqual({
        entitled: false,
        reason: 'grace-expired',
      });
    });

    it('legacy record (no high_water_mark field) → guard is inert even with a simulated rollback', () => {
      // No persisted floor yet (record predates this field) — deliberately NOT
      // falling back to last_validated_at (see nextHighWaterMark's comment in
      // store.ts): protection begins at this record's next successful write.
      const r = rec({ last_validated_at: new Date(NOW).toISOString() });
      expect(r.high_water_mark).toBeUndefined();
      expect(evaluateEntitlement(r, NOW - 2 * DAY_MS).entitled).toBe(true);
    });
  });
});

describe('activate', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'em-lic-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('activates, validates, and persists the cache (tokenless bodies)', async () => {
    const { fetchImpl, bodies } = fakeFetch([
      {
        match: '/activate',
        body: {
          id: 'act_99',
          license_key: { id: 'lk', display_key: '****-Z', status: 'granted', expires_at: null },
        },
      },
      {
        match: '/validate',
        body: {
          id: 'lk',
          status: 'granted',
          limit_activations: 2,
          usage: 1,
          validations: 1,
          expires_at: '2027-06-15T00:00:00.000Z',
          last_validated_at: null,
          display_key: '****-Z',
        },
      },
    ]);
    const r = await activate('  etta-key  ', { dir, fetchImpl, config: CFG, now: () => NOW });
    expect(r.key).toBe('etta-key'); // trimmed
    expect(r.status).toBe('granted');
    expect(r.activation_id).toBe('act_99');
    expect(r.expires_at).toBe('2027-06-15T00:00:00.000Z');
    expect(r.display_key).toBe('****-Z');
    expect(r.last_validated_at).toBe(new Date(NOW).toISOString());
    // A fresh activation seeds the monotonic high-water-mark from now.
    expect(r.high_water_mark).toBe(new Date(NOW).toISOString());
    expect(readLicense({ dir })?.activation_id).toBe('act_99');
    expect(readLicense({ dir })?.high_water_mark).toBe(new Date(NOW).toISOString());
    expect(bodies[0]).toMatchObject({ key: 'etta-key', organization_id: 'org_test' });
    expect(typeof bodies[0].label).toBe('string');
    expect(bodies[1]).toEqual({ key: 'etta-key', organization_id: 'org_test' });
  });

  it('maps the seat-cap 403 and writes nothing', async () => {
    const { fetchImpl } = fakeFetch([
      {
        match: '/activate',
        status: 403,
        body: { detail: 'License key activation limit already reached' },
      },
    ]);
    await expect(activate('k', { dir, fetchImpl, config: CFG })).rejects.toMatchObject({
      code: 'seat_limit_reached',
    });
    expect(existsSync(join(dir, 'license.json'))).toBe(false);
  });

  it('throws not_configured when the org id is empty', async () => {
    await expect(
      activate('k', { dir, config: { ...CFG, organizationId: '' } })
    ).rejects.toMatchObject({ code: 'not_configured' });
  });

  it('is idempotent per device — re-activating the same key refreshes, never a 2nd seat', async () => {
    writeLicense(rec({ key: 'SAME' }), { dir });
    const urls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      urls.push(url);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 'lk',
            status: 'granted',
            limit_activations: 2,
            usage: 0,
            validations: 3,
            expires_at: null,
            last_validated_at: null,
            display_key: '****-AAAA',
          }),
      };
    };
    const r = await activate('SAME', { dir, fetchImpl, config: CFG });
    expect(r.status).toBe('granted');
    // Must re-validate but NOT hit /activate (which would burn the 2nd seat).
    expect(urls.some((u) => u.includes('/validate'))).toBe(true);
    expect(urls.some((u) => u.includes('/activate'))).toBe(false);
  });
});

describe('refresh + deactivate', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'em-lic-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('refresh propagates a revocation into the cache', async () => {
    writeLicense(rec(), { dir });
    const { fetchImpl } = fakeFetch([
      {
        match: '/validate',
        body: {
          id: 'lk',
          status: 'revoked',
          limit_activations: 2,
          usage: 0,
          validations: 2,
          expires_at: null,
          last_validated_at: null,
          display_key: '****-AAAA',
        },
      },
    ]);
    const updated = await refresh({ dir, fetchImpl, config: CFG, now: () => NOW });
    expect(updated?.status).toBe('revoked');
    expect(readLicense({ dir })?.status).toBe('revoked');
  });

  it('refresh returns null when there is no license', async () => {
    const { fetchImpl } = fakeFetch([]);
    expect(await refresh({ dir, fetchImpl, config: CFG })).toBeNull();
  });

  it('refresh advances high_water_mark forward with the clock', async () => {
    writeLicense(rec({ high_water_mark: new Date(NOW).toISOString() }), { dir });
    const { fetchImpl } = fakeFetch([
      {
        match: '/validate',
        body: {
          id: 'lk',
          status: 'granted',
          limit_activations: 2,
          usage: 0,
          validations: 2,
          expires_at: null,
          last_validated_at: null,
          display_key: '****-AAAA',
        },
      },
    ]);
    const later = NOW + 3 * DAY_MS;
    const updated = await refresh({ dir, fetchImpl, config: CFG, now: () => later });
    expect(updated?.high_water_mark).toBe(new Date(later).toISOString());
    expect(readLicense({ dir })?.high_water_mark).toBe(new Date(later).toISOString());
  });

  it('refresh never moves high_water_mark backward, even when the clock rolls back', async () => {
    const pinnedHwm = new Date(NOW).toISOString();
    writeLicense(rec({ high_water_mark: pinnedHwm }), { dir });
    const { fetchImpl } = fakeFetch([
      {
        match: '/validate',
        body: {
          id: 'lk',
          status: 'granted',
          limit_activations: 2,
          usage: 0,
          validations: 2,
          expires_at: null,
          last_validated_at: null,
          display_key: '****-AAAA',
        },
      },
    ]);
    const rolledBack = NOW - 2 * DAY_MS;
    const updated = await refresh({ dir, fetchImpl, config: CFG, now: () => rolledBack });
    // high_water_mark stays pinned at the prior (later) value...
    expect(updated?.high_water_mark).toBe(pinnedHwm);
    // ...even though last_validated_at reflects the (untrustworthy) rolled-back clock...
    expect(updated?.last_validated_at).toBe(new Date(rolledBack).toISOString());
    // ...so the gate reads this "successful" refresh as not entitled, not fresh.
    expect(evaluateEntitlement(updated, rolledBack)).toEqual({
      entitled: false,
      reason: 'grace-expired',
    });
  });

  it('deactivate frees the seat and clears the cache', async () => {
    writeLicense(rec(), { dir });
    const { fetchImpl, bodies } = fakeFetch([{ match: '/deactivate', body: {} }]);
    expect(await deactivate({ dir, fetchImpl, config: CFG })).toBe(true);
    expect(existsSync(join(dir, 'license.json'))).toBe(false);
    expect(bodies[0]).toEqual({
      key: 'ETTA-KEY',
      organization_id: 'org_test',
      activation_id: 'act_1',
    });
  });

  it('deactivate clears locally even when the network call fails', async () => {
    writeLicense(rec(), { dir });
    const fetchImpl: FetchLike = async () => {
      throw new Error('offline');
    };
    await expect(deactivate({ dir, fetchImpl, config: CFG })).rejects.toBeInstanceOf(Error);
    expect(existsSync(join(dir, 'license.json'))).toBe(false);
  });
});

describe('isProEntitled', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'em-lic-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('false with no license, true for a fresh granted perpetual one', () => {
    expect(isProEntitled({ dir })).toBe(false);
    writeLicense(rec({ last_validated_at: new Date().toISOString() }), { dir });
    expect(isProEntitled({ dir })).toBe(true);
  });
});
