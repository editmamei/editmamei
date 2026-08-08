/**
 * The boot-path staleness refresh.
 *
 * Temporal behavior gets temporal tests: every boundary of the
 * refresh window and the grace window (1 day / 7 days since 2026-07-22; was
 * 7 / 30 at launch) is exercised with an injected clock and injected fetch,
 * including the failure modes AT the boundary (network down, network hung,
 * definitive revocation).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  refreshIfStale,
  evaluateEntitlement,
  REFRESH_AFTER_MS,
  EXPIRED_REFRESH_TIMEOUT_MS,
  GRACE_MS,
  CLOCK_SKEW_TOLERANCE_MS,
} from '@editmamei/license/entitlement.ts';
import { maybeActivateFromEnv } from '@editmamei/license/env-activation.ts';
import { readLicense, writeLicense, type LicenseRecord } from '@editmamei/license/store.ts';
import type { PolarConfig } from '@editmamei/license/config.ts';
import type { FetchLike } from '@editmamei/license/polar-client.ts';

const CFG: PolarConfig = {
  env: 'sandbox',
  baseUrl: 'https://api.test/v1',
  organizationId: 'org_test',
};
const NOW = Date.parse('2026-07-07T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

/** The env every test injects: NOT the test runner's (which gates the fn off). */
const PROD_ENV = {};

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

function agedRec(ageMs: number, over: Partial<LicenseRecord> = {}): LicenseRecord {
  return rec({ last_validated_at: new Date(NOW - ageMs).toISOString(), ...over });
}

/** A validate endpoint with call tracking and a controllable verdict. */
function validateFetch(status: 'granted' | 'revoked' = 'granted') {
  const urls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    urls.push(url);
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          id: 'lk',
          status,
          limit_activations: 2,
          usage: 1,
          validations: 5,
          expires_at: null,
          last_validated_at: null,
          display_key: '****-AAAA',
        }),
    };
  };
  return { fetchImpl, urls };
}

describe('refreshIfStale', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'em-stale-'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const ops = (extra: Record<string, unknown> = {}) => ({
    dir,
    config: CFG,
    now: () => NOW,
    env: PROD_ENV,
    ...extra,
  });

  // Scenario 7 (do it first — cheapest): no record → immediate no-op.
  it('no license record → no fetch, immediate return', async () => {
    const { fetchImpl, urls } = validateFetch();
    await refreshIfStale(ops({ fetchImpl }));
    expect(urls).toEqual([]);
  });

  // Scenario 1: fresh cache → zero network.
  it('day 0 (fresh) → no fetch call occurs', async () => {
    writeLicense(rec(), { dir });
    const { fetchImpl, urls } = validateFetch();
    await refreshIfStale(ops({ fetchImpl }));
    expect(urls).toEqual([]);
  });

  it('just inside the refresh window (age == REFRESH_AFTER_MS) → still no fetch', async () => {
    writeLicense(agedRec(REFRESH_AFTER_MS), { dir });
    const { fetchImpl, urls } = validateFetch();
    await refreshIfStale(ops({ fetchImpl }));
    expect(urls).toEqual([]);
  });

  // Scenario 2: stale → fire-and-forget; boot promise never waits on it.
  it('day 2 (stale) → fetch fires, boot resolves without awaiting, timestamp lands after the fetch settles', async () => {
    writeLicense(agedRec(2 * DAY_MS), { dir });
    const staleIso = new Date(NOW - 2 * DAY_MS).toISOString();

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const urls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      urls.push(url);
      await gate; // hold the validate open until the test releases it
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 'lk',
            status: 'granted',
            limit_activations: 2,
            usage: 1,
            validations: 5,
            expires_at: null,
            last_validated_at: null,
            display_key: '****-AAAA',
          }),
      };
    };

    await refreshIfStale(ops({ fetchImpl }));
    // Resolved while the network call is still in flight → it was not awaited.
    expect(urls.length).toBe(1);
    expect(urls[0]).toContain('/validate');
    expect(readLicense({ dir })?.last_validated_at).toBe(staleIso);

    release();
    await vi.waitFor(() => {
      expect(readLicense({ dir })?.last_validated_at).toBe(new Date(NOW).toISOString());
    });
  });

  // Scenario 3: stale + network down → cache untouched, no throw, WARN logged.
  it('day 2 + fetch rejects → cache unchanged, no throw, WARN logged', async () => {
    writeLicense(agedRec(2 * DAY_MS), { dir });
    const staleIso = new Date(NOW - 2 * DAY_MS).toISOString();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const fetchImpl: FetchLike = async () => {
      throw new Error('network down');
    };

    await expect(refreshIfStale(ops({ fetchImpl }))).resolves.toBeUndefined();
    await vi.waitFor(() => {
      const logged = stderr.mock.calls.map((c) => String(c[0])).join('');
      expect(logged).toContain('Background license refresh failed');
    });
    expect(readLicense({ dir })?.last_validated_at).toBe(staleIso);
    expect(readLicense({ dir })?.status).toBe('granted');
  });

  // Scenario 4: past grace + Polar grants → awaited; Pro is back THIS boot.
  it('day 31 + Polar grants → awaited within the bound; entitlement flips before return', async () => {
    writeLicense(agedRec(31 * DAY_MS), { dir });
    expect(evaluateEntitlement(readLicense({ dir }), NOW).reason).toBe('grace-expired');

    const { fetchImpl, urls } = validateFetch('granted');
    await refreshIfStale(ops({ fetchImpl }));

    expect(urls.length).toBe(1);
    const updated = readLicense({ dir });
    expect(updated?.last_validated_at).toBe(new Date(NOW).toISOString());
    expect(evaluateEntitlement(updated, NOW)).toEqual({ entitled: true, reason: 'granted' });
  });

  // Value pin for the 2026-07-22 shortening: day 10 was comfortably inside the
  // launch 30-day grace but is PAST the 7-day grace. The relational boundary
  // tests below pass under ANY GRACE_MS value, so without this fixture a silent
  // revert to 30 days would pass the whole suite (QA finding, 2026-07-22).
  it('day 10 is past the (7-day) grace: grace-expired, and the awaited recovery path runs', async () => {
    writeLicense(agedRec(10 * DAY_MS), { dir });
    expect(evaluateEntitlement(readLicense({ dir }), NOW).reason).toBe('grace-expired');

    const { fetchImpl, urls } = validateFetch('granted');
    await refreshIfStale(ops({ fetchImpl }));

    // Awaited path: the timestamp is already written when refreshIfStale returns.
    expect(urls.length).toBe(1);
    const updated = readLicense({ dir });
    expect(updated?.last_validated_at).toBe(new Date(NOW).toISOString());
    expect(evaluateEntitlement(updated, NOW)).toEqual({ entitled: true, reason: 'granted' });
  });

  // Scenario 5: past grace + network hangs → return at the cap, still dark.
  it('day 31 + fetch hangs → returns at the timeout bound, entitlement still grace-expired', async () => {
    vi.useFakeTimers();
    writeLicense(agedRec(31 * DAY_MS), { dir });
    const fetchImpl: FetchLike = () => new Promise(() => {}); // never settles

    const pending = refreshIfStale(ops({ fetchImpl }));
    let resolved = false;
    void pending.then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(EXPIRED_REFRESH_TIMEOUT_MS - 1);
    expect(resolved).toBe(false); // still inside the bound — genuinely waiting
    await vi.advanceTimersByTimeAsync(2);
    await pending;

    expect(evaluateEntitlement(readLicense({ dir }), NOW).reason).toBe('grace-expired');
  });

  // Scenario 6: past grace + definitive revocation → enforced, not healed.
  it('day 31 + Polar says revoked → cache updated to revoked; Pro stays dark', async () => {
    writeLicense(agedRec(31 * DAY_MS), { dir });
    const { fetchImpl } = validateFetch('revoked');
    await refreshIfStale(ops({ fetchImpl }));

    const updated = readLicense({ dir });
    expect(updated?.status).toBe('revoked');
    expect(evaluateEntitlement(updated, NOW)).toEqual({ entitled: false, reason: 'revoked' });
  });

  it('day 31 + fetch rejects → cached record preserved verbatim (grace state intact)', async () => {
    const before = agedRec(31 * DAY_MS);
    writeLicense(before, { dir });
    const fetchImpl: FetchLike = async () => {
      throw new Error('offline');
    };
    await expect(refreshIfStale(ops({ fetchImpl }))).resolves.toBeUndefined();
    expect(readLicense({ dir })).toEqual(before);
  });

  // Pitfall (a): definitive dead states never generate Polar traffic.
  it('revoked / disabled / expired records → no fetch at any age', async () => {
    const { fetchImpl, urls } = validateFetch();
    for (const over of [
      { status: 'revoked' as const },
      { status: 'disabled' as const },
      { expires_at: new Date(NOW - 1000).toISOString() },
    ]) {
      writeLicense(agedRec(31 * DAY_MS, over), { dir });
      await refreshIfStale(ops({ fetchImpl }));
    }
    expect(urls).toEqual([]);
  });

  // The test-runner gate: without an injected env, VITEST is set → no-op.
  it('under the test runner (no injected env) → hard no-op even past grace', async () => {
    writeLicense(agedRec(31 * DAY_MS), { dir });
    const { fetchImpl, urls } = validateFetch();
    await refreshIfStale({ dir, config: CFG, now: () => NOW, fetchImpl });
    expect(urls).toEqual([]);
  });

  // The two GRACE_MS boundary tests discriminate the paths by RESOLUTION
  // ORDER against a gated fetch: fire-and-forget resolves while the network
  // call is still held open; the awaited path cannot resolve until the fetch
  // settles. (QA finding: an instantly-resolving fetch can't tell them apart.)

  it('boundary: age exactly GRACE_MS is still entitled → fire-and-forget, not awaited', async () => {
    writeLicense(agedRec(GRACE_MS), { dir });
    const atIso = new Date(NOW - GRACE_MS).toISOString();
    expect(evaluateEntitlement(readLicense({ dir }), NOW).entitled).toBe(true);

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const inner = validateFetch('granted');
    const fetchImpl: FetchLike = async (url, init) => {
      await gate;
      return inner.fetchImpl(url, init);
    };

    await refreshIfStale(ops({ fetchImpl }));
    // Resolved with the fetch still held open → the background path.
    expect(readLicense({ dir })?.last_validated_at).toBe(atIso);

    release();
    await vi.waitFor(() => {
      expect(readLicense({ dir })?.last_validated_at).toBe(new Date(NOW).toISOString());
    });
  });

  it('boundary: age just past GRACE_MS takes the awaited path, not fire-and-forget', async () => {
    writeLicense(agedRec(GRACE_MS + 1000), { dir });

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const inner = validateFetch('granted');
    const fetchImpl: FetchLike = async (url, init) => {
      await gate;
      return inner.fetchImpl(url, init);
    };

    let resolved = false;
    const pending = refreshIfStale(ops({ fetchImpl })).then(() => {
      resolved = true;
    });
    await new Promise((r) => setImmediate(r));
    // Fetch held open and refreshIfStale has NOT resolved → genuinely awaited.
    expect(resolved).toBe(false);

    release();
    await pending;
    expect(readLicense({ dir })?.last_validated_at).toBe(new Date(NOW).toISOString());
  });

  it('corrupt (non-finite) last_validated_at → awaited recovery path heals the record', async () => {
    writeLicense(rec({ last_validated_at: 'not-a-date' }), { dir });
    expect(evaluateEntitlement(readLicense({ dir }), NOW).reason).toBe('grace-expired');

    const { fetchImpl, urls } = validateFetch('granted');
    await refreshIfStale(ops({ fetchImpl }));

    expect(urls.length).toBe(1);
    const healed = readLicense({ dir });
    expect(healed?.last_validated_at).toBe(new Date(NOW).toISOString());
    expect(evaluateEntitlement(healed, NOW)).toEqual({ entitled: true, reason: 'granted' });
  });

  // Scenario 8: the .mcpb path — env key matches cache, day 2 (stale, still
  // entitled) → the shared boot refresh still fires (integration of
  // maybeActivateFromEnv + refreshIfStale, in the exact order index.ts runs
  // them) and never touches /activate.
  it('.mcpb path: matching env key at day 2 → shared boot refresh fires, no /activate', async () => {
    // isProEntitled inside maybeActivateFromEnv reads the real clock, so age
    // this record against real time rather than the fixed NOW.
    const realNow = Date.now();
    writeLicense(
      rec({ key: 'SAME', last_validated_at: new Date(realNow - 2 * DAY_MS).toISOString() }),
      { dir }
    );
    const { fetchImpl, urls } = validateFetch('granted');

    // Delivery endpoint that makes provisioning a clean no-op (not_configured).
    await maybeActivateFromEnv(
      { EDITMAMEI_LICENSE_KEY: 'SAME' },
      { dir, config: CFG, fetchImpl },
      { config: { baseUrl: '' } }
    );
    expect(urls).toEqual([]); // matching key: no Polar traffic from activation

    await refreshIfStale({
      dir,
      config: CFG,
      fetchImpl,
      now: () => realNow,
      env: PROD_ENV,
    });
    await vi.waitFor(() => {
      expect(readLicense({ dir })?.last_validated_at).toBe(new Date(realNow).toISOString());
    });
    expect(urls.length).toBe(1);
    expect(urls[0]).toContain('/validate');
    expect(urls.some((u) => u.includes('/activate'))).toBe(false);
  });

  // Clock-skew guard: a last_validated_at implausibly far in the FUTURE
  // (the clock was set ahead at write time, then corrected) would otherwise read
  // as a negative — perpetually "fresh" — age and never re-validate. It must
  // force a refresh, via the BACKGROUND path (still entitled → no boot latency).
  it('future timestamp beyond the skew tolerance → background refresh fires, not awaited', async () => {
    // 2 days in the future (> the 1-day tolerance).
    writeLicense(agedRec(-2 * DAY_MS), { dir });
    const futureIso = new Date(NOW + 2 * DAY_MS).toISOString();
    // Still entitled today — a future timestamp can't be grace-expired.
    expect(evaluateEntitlement(readLicense({ dir }), NOW).entitled).toBe(true);

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const inner = validateFetch('granted');
    const fetchImpl: FetchLike = async (url, init) => {
      await gate;
      return inner.fetchImpl(url, init);
    };

    await refreshIfStale(ops({ fetchImpl }));
    // Resolved with the fetch still held open → the background (not awaited) path.
    expect(readLicense({ dir })?.last_validated_at).toBe(futureIso);

    release();
    await vi.waitFor(() => {
      expect(readLicense({ dir })?.last_validated_at).toBe(new Date(NOW).toISOString());
    });
    expect(inner.urls[0]).toContain('/validate');
  });

  it('future timestamp within the skew tolerance → treated as fresh, no fetch', async () => {
    // 1 hour ahead — benign drift, inside the tolerance.
    writeLicense(agedRec(-60 * 60 * 1000), { dir });
    const { fetchImpl, urls } = validateFetch();
    await refreshIfStale(ops({ fetchImpl }));
    expect(urls).toEqual([]);
  });

  it('boundary: future by exactly CLOCK_SKEW_TOLERANCE_MS is still fresh; one ms past forces a refresh', async () => {
    // Exactly at the tolerance (age === -TOLERANCE): NOT skewed → fresh, no fetch.
    writeLicense(agedRec(-CLOCK_SKEW_TOLERANCE_MS), { dir });
    const atBoundary = validateFetch();
    await refreshIfStale(ops({ fetchImpl: atBoundary.fetchImpl }));
    expect(atBoundary.urls).toEqual([]);

    // One ms further into the future → skewed → refresh fires.
    writeLicense(agedRec(-(CLOCK_SKEW_TOLERANCE_MS + 1)), { dir });
    const pastBoundary = validateFetch();
    await refreshIfStale(ops({ fetchImpl: pastBoundary.fetchImpl }));
    await vi.waitFor(() => {
      expect(pastBoundary.urls.length).toBe(1);
    });
    expect(pastBoundary.urls[0]).toContain('/validate');
  });
});
