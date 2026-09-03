import { describe, it, expect, vi } from 'vitest';
import { waitForLaunchReady } from '@editmamei/platform/launch-readiness.ts';

/**
 * `waitForLaunchReady` replaced a fixed post-launch sleep with a poll. Both
 * properties that matter are timing-shaped, so the fake `sleep` here is what
 * lets the test assert them without waiting in real wall-clock time: it
 * resolves immediately but records how many times — and with what
 * interval — it was asked to wait.
 */
function fakeSleep(): { sleep: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    sleep: (ms: number) => {
      calls.push(ms);
      return Promise.resolve();
    },
  };
}

describe('waitForLaunchReady', () => {
  it('returns true as soon as the probe answers, without polling further', async () => {
    const { sleep, calls } = fakeSleep();
    const isReady = vi.fn<() => Promise<boolean>>();
    isReady.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const ready = await waitForLaunchReady(isReady, {
      intervalMs: 250,
      maxWaitMs: 5000,
      sleep,
    });

    expect(ready).toBe(true);
    // Exactly 3 probes — it must not keep polling past the one that succeeded.
    expect(isReady).toHaveBeenCalledTimes(3);
    // Only 2 waits between the 3 probes, not one after the last.
    expect(calls).toEqual([250, 250]);
  });

  it('stops at the cap when the probe never reports ready', async () => {
    const { sleep, calls } = fakeSleep();
    const isReady = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);

    const ready = await waitForLaunchReady(isReady, {
      intervalMs: 250,
      maxWaitMs: 1000,
      sleep,
    });

    expect(ready).toBe(false);
    // ceil(1000 / 250) = 4 probe attempts, 3 waits between them.
    expect(isReady).toHaveBeenCalledTimes(4);
    expect(calls).toEqual([250, 250, 250]);
  });

  it('never probes at all once aborted', async () => {
    const { sleep } = fakeSleep();
    const isReady = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);

    const ready = await waitForLaunchReady(isReady, {
      intervalMs: 250,
      maxWaitMs: 5000,
      sleep,
      isAborted: () => true,
    });

    expect(ready).toBe(false);
    expect(isReady).not.toHaveBeenCalled();
  });
});
