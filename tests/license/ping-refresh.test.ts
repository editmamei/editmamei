/**
 * The ps_ping license-refresh piggyback (every-ping trigger, throttled).
 *
 * The staleness/grace/clock-skew policy itself lives in `refreshIfStale` and is
 * covered by refresh-if-stale.test.ts. Here we only pin the piggyback wrapper
 * (de-latched 2026-07-22 alongside the 1-day freshness window): it fires the
 * injected refresh on every call once `PING_REFRESH_MIN_INTERVAL_MS` has
 * elapsed since the last ATTEMPT (success or failure — the throttle is what
 * bounds outbound traffic when validates persistently fail), detached (never
 * awaited), and never lets a refresh failure escape into the caller (the ping).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createPingLicenseRefresher,
  PING_REFRESH_MIN_INTERVAL_MS,
} from '@editmamei/license/ping-refresh.ts';

const T0 = 1_000_000;

describe('createPingLicenseRefresher', () => {
  it('fires on every call once the min interval has elapsed — a later ping re-checks a host that went stale mid-process', () => {
    const refresh = vi.fn(async () => {});
    let now = T0;
    const trigger = createPingLicenseRefresher(refresh, { now: () => now });

    trigger();
    now += PING_REFRESH_MIN_INTERVAL_MS;
    trigger();
    now += PING_REFRESH_MIN_INTERVAL_MS;
    trigger();

    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it('throttles calls inside the min interval to one attempt — ping-hammering cannot amplify outbound validates', () => {
    const refresh = vi.fn(async () => {});
    let now = T0;
    const trigger = createPingLicenseRefresher(refresh, { now: () => now });

    trigger();
    now += PING_REFRESH_MIN_INTERVAL_MS - 1; // just inside the window
    trigger();
    trigger();

    expect(refresh).toHaveBeenCalledTimes(1);

    now += 1; // exactly at the boundary → allowed again
    trigger();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('returns synchronously without awaiting the refresh (fire-and-forget)', () => {
    let released!: () => void;
    const gate = new Promise<void>((r) => {
      released = r;
    });
    const refresh = vi.fn(() => gate); // stays pending until released

    const trigger = createPingLicenseRefresher(refresh);
    trigger(); // must not block on the pending refresh

    expect(refresh).toHaveBeenCalledTimes(1);
    released();
  });

  it('swallows an async rejection — the trigger never throws or rejects', async () => {
    const refresh = vi.fn(async () => {
      throw new Error('network down');
    });
    const trigger = createPingLicenseRefresher(refresh);

    expect(() => trigger()).not.toThrow();
    // Let the rejected promise settle; an unhandled rejection would fail the run.
    await Promise.resolve();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('a failed attempt still counts against the throttle, and fires again after the interval', () => {
    const refresh = vi.fn(() => {
      throw new Error('boom');
    }) as unknown as () => Promise<void>;
    let now = T0;
    const trigger = createPingLicenseRefresher(refresh, { now: () => now });

    expect(() => trigger()).not.toThrow();
    expect(refresh).toHaveBeenCalledTimes(1);

    // Inside the interval: the failure must NOT reset the throttle into a
    // fire-every-ping loop.
    trigger();
    expect(refresh).toHaveBeenCalledTimes(1);

    // Past the interval: the trigger is not wedged — the next ping retries.
    now += PING_REFRESH_MIN_INTERVAL_MS;
    expect(() => trigger()).not.toThrow();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('defaults to the real refreshIfStale (no-op under the test runner) without throwing', () => {
    // No injected fn → uses refreshIfStale, which hard no-ops under VITEST, so
    // this must complete cleanly and never touch the network.
    const trigger = createPingLicenseRefresher();
    expect(() => trigger()).not.toThrow();
  });
});
