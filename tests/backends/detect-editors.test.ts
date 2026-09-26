import { describe, it, expect, vi, afterEach } from 'vitest';
import { detectEditors } from '@editmamei/backends/detect-editors.ts';
import type { HostPlatform } from '@editmamei/platform/host-platform.ts';
import type { GimpInstall } from '@editmamei/backends/gimp/detect.ts';

function fakeHost(detect: () => Promise<unknown>): HostPlatform {
  return {
    os: 'win32',
    adapter: {
      run: async () => {
        throw new Error('not used by detectEditors');
      },
      isRunning: async () => false,
      launch: async () => {
        throw new Error('not used by detectEditors');
      },
    },
    detector: { detect: detect as HostPlatform['detector']['detect'] },
  };
}

const SAMPLE_INSTALL: GimpInstall = {
  source: 'conventional',
  path: 'C:\\Program Files\\GIMP 3\\bin\\gimp-console-3.exe',
  launch: { command: 'C:\\Program Files\\GIMP 3\\bin\\gimp-console-3.exe', args: [] },
};

describe('detectEditors', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports both found when both probes resolve well within budget', async () => {
    const result = await detectEditors({
      budgetMs: 1000,
      hostPlatform: fakeHost(async () => ({ version: '2026', path: 'C:\\Photoshop.exe' })),
      detectGimp: async () => SAMPLE_INSTALL,
    });
    expect(result).toEqual({ photoshop: true, gimp: SAMPLE_INSTALL, timedOut: false });
  });

  it('reports photoshop:false and gimp:null when both probes reject/miss', async () => {
    const result = await detectEditors({
      budgetMs: 1000,
      hostPlatform: fakeHost(async () => {
        throw new Error('no Photoshop install could be found on this machine');
      }),
      detectGimp: async () => null,
    });
    expect(result).toEqual({ photoshop: false, gimp: null, timedOut: false });
  });

  it('times out within the budget and reports whatever finished, leaving the other at its not-found default', async () => {
    vi.useFakeTimers();
    const neverResolves = new Promise<never>(() => {
      /* a probe that hangs — simulates a slow registry query or similar */
    });

    const resultPromise = detectEditors({
      budgetMs: 750,
      hostPlatform: fakeHost(async () => ({ version: '2026', path: 'C:\\Photoshop.exe' })),
      detectGimp: () => neverResolves,
    });

    await vi.advanceTimersByTimeAsync(750);
    const result = await resultPromise;

    expect(result.timedOut).toBe(true);
    expect(result.photoshop).toBe(true); // finished before the budget expired
    expect(result.gimp).toBeNull(); // the hung probe never finished
  });

  it('honors a custom budgetMs', async () => {
    vi.useFakeTimers();
    const neverResolves = new Promise<never>(() => {});

    const resultPromise = detectEditors({
      budgetMs: 20,
      hostPlatform: fakeHost(() => neverResolves),
      detectGimp: () => neverResolves,
    });

    await vi.advanceTimersByTimeAsync(20);
    const result = await resultPromise;

    expect(result).toEqual({ photoshop: false, gimp: null, timedOut: true });
  });

  it('does not mutate the returned result after the timer fires later than the winning probe', async () => {
    vi.useFakeTimers();
    const result = await (async () => {
      const p = detectEditors({
        budgetMs: 50,
        hostPlatform: fakeHost(async () => ({ version: '2026', path: 'C:\\Photoshop.exe' })),
        detectGimp: async () => SAMPLE_INSTALL,
      });
      // Let the microtask queue settle the (already-resolved) probes before
      // the fake timer would fire.
      await vi.advanceTimersByTimeAsync(0);
      return p;
    })();
    expect(result.timedOut).toBe(false);

    // Advance well past budgetMs. If the timeout's setTimeout callback were
    // still live and mutating a shared result object, this would flip
    // timedOut to true on the object the caller already holds.
    await vi.advanceTimersByTimeAsync(1000);
    expect(result.timedOut).toBe(false);
  });
});
