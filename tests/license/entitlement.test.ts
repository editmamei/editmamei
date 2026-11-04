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

/**
 * The validate endpoint as it behaves with an activation id: 404 when that activation
 * is gone, 200 for the key alone. `keyStatus` 404 stands for a dead key, which 404s both.
 */
function activationGoneFetch(
  keyStatus = 200,
  activateStatus = 200
): {
  fetchImpl: FetchLike;
  calls: Array<{ url: string; body: Record<string, unknown> }>;
} {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ url, body });
    if (url.includes('/validate') && (body.activation_id || keyStatus !== 200)) {
      return { ok: false, status: 404, text: async () => '{"error":"ResourceNotFound"}' };
    }
    if (url.includes('/activate') && activateStatus !== 200) {
      return { ok: false, status: activateStatus, text: async () => 'activation limit reached' };
    }
    const payload = url.includes('/activate')
      ? {
          id: 'act_new',
          license_key: { id: 'lk', display_key: '****-AAAA', status: 'granted', expires_at: null },
        }
      : { id: 'lk', status: 'granted', expires_at: null, display_key: '****-AAAA' };
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
  return { fetchImpl, calls };
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
  it('a removed activation → not entitled (activation-removed)', () => {
    expect(evaluateEntitlement(rec({ activation_removed: true }), NOW)).toEqual({
      entitled: false,
      reason: 'activation-removed',
    });
  });
  it('an expired license says expired even when its activation was removed', () => {
    const over = { activation_removed: true, expires_at: new Date(NOW - 1000).toISOString() };
    expect(evaluateEntitlement(rec(over), NOW).reason).toBe('expired');
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

  it('activates and persists the cache from that one response (tokenless body)', async () => {
    const { fetchImpl, bodies } = fakeFetch([
      {
        match: '/activate',
        body: {
          id: 'act_99',
          license_key: {
            id: 'lk',
            display_key: '****-Z',
            status: 'granted',
            expires_at: '2027-06-15T00:00:00.000Z',
          },
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
    // Nothing can fail between taking the seat and recording its id.
    expect(bodies).toHaveLength(1);
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

  it('takes a new seat when the check finds the activation removed, in three requests', async () => {
    writeLicense(rec({ key: 'SAME' }), { dir });
    const { fetchImpl, calls } = activationGoneFetch();
    const r = await activate('SAME', { dir, fetchImpl, config: CFG, now: () => NOW });
    expect(r.activation_id).toBe('act_new');
    expect(r.activation_removed).toBeUndefined();
    expect(readLicense({ dir })?.activation_id).toBe('act_new');
    expect(calls.map((c) => c.url.split('/').pop())).toEqual(['validate', 'validate', 'activate']);
  });

  it('a record marked removed whose activation validates again takes no new seat', async () => {
    writeLicense(rec({ key: 'SAME', activation_removed: true }), { dir });
    const { fetchImpl, bodies } = fakeFetch([
      { match: '/validate', body: { status: 'granted', expires_at: null, display_key: 'k' } },
    ]);
    const r = await activate('SAME', { dir, fetchImpl, config: CFG, now: () => NOW });
    expect(r.activation_id).toBe('act_1');
    expect(r.activation_removed).toBeUndefined();
    expect(bodies).toHaveLength(1);
  });

  it('takes no seat for a dead key', async () => {
    writeLicense(rec({ key: 'SAME', activation_removed: true }), { dir });
    const { fetchImpl, calls } = activationGoneFetch(404);
    await expect(activate('SAME', { dir, fetchImpl, config: CFG })).rejects.toMatchObject({
      code: 'invalid_license',
    });
    expect(calls.some((c) => c.url.includes('/activate'))).toBe(false);
  });

  it('keeps the removed mark and the key when the new activation is refused', async () => {
    writeLicense(rec({ key: 'SAME', activation_removed: true }), { dir });
    const { fetchImpl } = activationGoneFetch(200, 403);
    await expect(activate('SAME', { dir, fetchImpl, config: CFG })).rejects.toMatchObject({
      code: 'seat_limit_reached',
    });
    expect(readLicense({ dir })).toMatchObject({ key: 'SAME', activation_removed: true });
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

  it('refresh validates with the activation id', async () => {
    writeLicense(rec(), { dir });
    const { fetchImpl, bodies } = fakeFetch([
      { match: '/validate', body: { status: 'granted', expires_at: null, display_key: 'k' } },
    ]);
    await refresh({ dir, fetchImpl, config: CFG, now: () => NOW });
    expect(bodies).toEqual([
      { key: 'ETTA-KEY', organization_id: 'org_test', activation_id: 'act_1' },
    ]);
  });

  it('refresh marks a removed activation only after the key alone validates', async () => {
    writeLicense(rec(), { dir });
    const { fetchImpl, calls } = activationGoneFetch();
    const updated = await refresh({ dir, fetchImpl, config: CFG, now: () => NOW + 1000 });
    expect(updated?.activation_removed).toBe(true);
    expect(calls.map((c) => c.body.activation_id)).toEqual(['act_1', undefined]);
    // The key stays on disk, and the check still counts as a check.
    expect(readLicense({ dir })).toMatchObject({
      key: 'ETTA-KEY',
      activation_removed: true,
      last_validated_at: new Date(NOW + 1000).toISOString(),
    });
    expect(evaluateEntitlement(readLicense({ dir }), NOW + 1000).reason).toBe('activation-removed');
  });

  it('refresh leaves the record alone when the key itself is dead', async () => {
    const before = rec();
    writeLicense(before, { dir });
    const { fetchImpl, calls } = activationGoneFetch(404);
    await expect(refresh({ dir, fetchImpl, config: CFG })).rejects.toMatchObject({
      code: 'invalid_license',
      httpStatus: 404,
    });
    expect(calls).toHaveLength(2);
    expect(readLicense({ dir })).toEqual(before);
  });

  it('refresh does not mark anything when the confirming check does not get through', async () => {
    const before = rec();
    writeLicense(before, { dir });
    const fetchImpl: FetchLike = async (_url, init) => ({
      ok: false,
      status: (JSON.parse(init.body) as { activation_id?: string }).activation_id ? 404 : 503,
      text: async () => '',
    });
    await expect(
      refresh({ dir, fetchImpl, config: CFG, client: { sleep: async () => {} } })
    ).rejects.toMatchObject({ code: 'transient' });
    expect(readLicense({ dir })).toEqual(before);
  });

  it('refresh clears the mark when the activation validates again', async () => {
    writeLicense(rec({ activation_removed: true }), { dir });
    const { fetchImpl } = fakeFetch([
      { match: '/validate', body: { status: 'granted', expires_at: null, display_key: 'k' } },
    ]);
    const updated = await refresh({ dir, fetchImpl, config: CFG, now: () => NOW });
    expect(updated?.activation_removed).toBeUndefined();
    expect(evaluateEntitlement(readLicense({ dir }), NOW).entitled).toBe(true);
  });

  it('refresh does not overwrite an activation that landed during its requests', async () => {
    writeLicense(rec(), { dir });
    const replaced = rec({ activation_id: 'act_2' });
    const fetchImpl: FetchLike = async () => {
      writeLicense(replaced, { dir });
      return {
        ok: true,
        status: 200,
        text: async () => '{"status":"granted","expires_at":null,"display_key":"k"}',
      };
    };
    const r = await refresh({ dir, fetchImpl, config: CFG, now: () => NOW });
    expect(r?.activation_id).toBe('act_2');
    expect(readLicense({ dir })).toEqual(replaced);
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

  it('deactivate of a removed activation clears locally without asking the server', async () => {
    writeLicense(rec({ activation_removed: true }), { dir });
    const { fetchImpl, bodies } = fakeFetch([]);
    expect(await deactivate({ dir, fetchImpl, config: CFG })).toBe(true);
    expect(bodies).toEqual([]);
    expect(existsSync(join(dir, 'license.json'))).toBe(false);
  });

  it('deactivate clears locally even when the network call fails', async () => {
    writeLicense(rec(), { dir });
    const fetchImpl: FetchLike = async () => {
      throw new Error('offline');
    };
    // No-op backoff: the thrown fetch is retried, and this test is about the
    // local clear happening regardless, not the retry schedule.
    await expect(
      deactivate({ dir, fetchImpl, config: CFG, client: { sleep: async () => {} } })
    ).rejects.toBeInstanceOf(Error);
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
