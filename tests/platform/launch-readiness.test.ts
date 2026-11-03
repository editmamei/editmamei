import { describe, it, expect, vi } from 'vitest';
import { waitForLaunchReady } from '@editmamei/platform/launch-readiness.ts';

/**
 * `waitForLaunchReady` replaced a fixed post-launch sleep with a poll bounded
 * by REAL elapsed time, not an iteration count — the probe is now a script
 * round trip that can itself be slow, so a naive `ceil(maxWaitMs/intervalMs)`
 * attempt budget would let repeatedly-slow attempts blow past the intended
 * cap. The fake clock here — `now` plus a `sleep` that advances it — lets a
 * test simulate exactly that without any real wall-clock waiting: `sleep`
 * models time spent between attempts, and a probe mock that itself calls
 * `advance()` models a slow attempt.
 */
function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let time = start;
  return {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe('waitForLaunchReady', () => {
  it('returns true as soon as the probe answers, without polling further', async () => {
    const clock = fakeClock();
    const calls: number[] = [];
    const sleep = (ms: number): Promise<void> => {
      calls.push(ms);
      clock.advance(ms);
      return Promise.resolve();
    };
    const isReady = vi.fn<() => Promise<boolean>>();
    isReady.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const ready = await waitForLaunchReady(isReady, {
      intervalMs: 250,
      maxWaitMs: 5000,
      sleep,
      now: clock.now,
    });

    expect(ready).toBe(true);
    // Exactly 3 probes — it must not keep polling past the one that succeeded.
    expect(isReady).toHaveBeenCalledTimes(3);
    // Only 2 waits between the 3 probes, not one after the last.
    expect(calls).toEqual([250, 250]);
  });

  it('stops once the cap is reached when the probe never reports ready', async () => {
    const clock = fakeClock();
    const sleep = (ms: number): Promise<void> => {
      clock.advance(ms);
      return Promise.resolve();
    };
    const isReady = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);

    const ready = await waitForLaunchReady(isReady, {
      intervalMs: 250,
      maxWaitMs: 1000,
      sleep,
      now: clock.now,
    });

    expect(ready).toBe(false);
    // Real elapsed time (per the fake clock), not a fixed count, is what
    // stops the loop: 4 instant probes fit inside 1000ms at 250ms apart.
    expect(isReady).toHaveBeenCalledTimes(4);
  });

  it('caps real elapsed time even when each attempt is itself slow, not just intervalMs apart', async () => {
    // This is the bug the time-based rewrite fixes: a probe that is a real
    // script round trip can take far longer than the polling interval. A
    // count-based cap (ceil(maxWaitMs / intervalMs) = 20 here) would let 20
    // slow attempts run; tracking real elapsed time correctly stops after
    // the second one blows through the 5s cap.
    const clock = fakeClock();
    const sleep = (ms: number): Promise<void> => {
      clock.advance(ms);
      return Promise.resolve();
    };
    const isReady = vi.fn<() => Promise<boolean>>().mockImplementation(async () => {
      clock.advance(3_000); // each attempt itself costs 3s
      return false;
    });

    const ready = await waitForLaunchReady(isReady, {
      intervalMs: 250,
      maxWaitMs: 5_000,
      sleep,
      now: clock.now,
    });

    expect(ready).toBe(false);
    expect(isReady).toHaveBeenCalledTimes(2);
  });

  it('returns true immediately even when reaching readiness itself took most of the budget', async () => {
    const clock = fakeClock();
    const sleep = (ms: number): Promise<void> => {
      clock.advance(ms);
      return Promise.resolve();
    };
    const isReady = vi.fn<() => Promise<boolean>>().mockImplementation(async () => {
      clock.advance(4_500); // a slow but ultimately successful attempt
      return true;
    });

    const ready = await waitForLaunchReady(isReady, {
      intervalMs: 250,
      maxWaitMs: 5_000,
      sleep,
      now: clock.now,
    });

    expect(ready).toBe(true);
    expect(isReady).toHaveBeenCalledTimes(1);
  });

  it('never probes at all once aborted', async () => {
    const clock = fakeClock();
    const sleep = (ms: number): Promise<void> => {
      clock.advance(ms);
      return Promise.resolve();
    };
    const isReady = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);

    const ready = await waitForLaunchReady(isReady, {
      intervalMs: 250,
      maxWaitMs: 5000,
      sleep,
      now: clock.now,
      isAborted: () => true,
    });

    expect(ready).toBe(false);
    expect(isReady).not.toHaveBeenCalled();
  });
});
