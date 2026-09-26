import { describe, it, expect, vi, afterEach } from 'vitest';

// Mocks the GIMP detector module so `resolveBootEditors`' env/gimp_path
// wiring can be observed without ever touching the real filesystem — the
// module-level mock also stands in for `detectEditors`' own default detector
// (both live in the same module graph as `detect-editors.ts`'s import).
vi.mock('@editmamei/backends/gimp/detect.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@editmamei/backends/gimp/detect.ts')>();
  return { ...actual, detectGimp: vi.fn(actual.detectGimp) };
});

import {
  detectEditors,
  resolveEditorRegistration,
  resolveBootEditors,
  type DetectEditorsResult,
} from '@editmamei/backends/detect-editors.ts';
import { detectGimp } from '@editmamei/backends/gimp/detect.ts';
import type { GimpInstall } from '@editmamei/backends/gimp/detect.ts';
import type { Settings } from '@editmamei/core/settings.ts';

const SAMPLE_INSTALL: GimpInstall = {
  source: 'conventional',
  path: 'C:\\Program Files\\GIMP 3\\bin\\gimp-console-3.exe',
  launch: { command: 'C:\\Program Files\\GIMP 3\\bin\\gimp-console-3.exe', args: [] },
};

describe('detectEditors', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports the GIMP install when the probe resolves well within budget', async () => {
    const result = await detectEditors({ budgetMs: 1000, detectGimp: async () => SAMPLE_INSTALL });
    expect(result).toEqual({ gimp: SAMPLE_INSTALL, timedOut: false });
  });

  it('reports gimp:null when the probe rejects/misses', async () => {
    const result = await detectEditors({ budgetMs: 1000, detectGimp: async () => null });
    expect(result).toEqual({ gimp: null, timedOut: false });
  });

  it('times out within the budget, leaving gimp at its not-found default', async () => {
    vi.useFakeTimers();
    const neverResolves = new Promise<never>(() => {
      /* a probe that hangs — simulates a slow filesystem query */
    });

    const resultPromise = detectEditors({ budgetMs: 750, detectGimp: () => neverResolves });

    await vi.advanceTimersByTimeAsync(750);
    const result = await resultPromise;

    expect(result.timedOut).toBe(true);
    expect(result.gimp).toBeNull();
  });

  it('honors a custom budgetMs', async () => {
    vi.useFakeTimers();
    const neverResolves = new Promise<never>(() => {});

    const resultPromise = detectEditors({ budgetMs: 20, detectGimp: () => neverResolves });

    await vi.advanceTimersByTimeAsync(20);
    const result = await resultPromise;

    expect(result).toEqual({ gimp: null, timedOut: true });
  });

  it('does not mutate the returned result after the timer fires later than the winning probe', async () => {
    vi.useFakeTimers();
    const result = await (async () => {
      const p = detectEditors({ budgetMs: 50, detectGimp: async () => SAMPLE_INSTALL });
      // Let the microtask queue settle the (already-resolved) probe before
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

describe('resolveEditorRegistration', () => {
  const FOUND: DetectEditorsResult = { gimp: SAMPLE_INSTALL, timedOut: false };
  const NOT_FOUND: DetectEditorsResult = { gimp: null, timedOut: false };
  const TIMED_OUT: DetectEditorsResult = { gimp: null, timedOut: true };

  it('auto: GIMP found -> both register (Photoshop is never conditional on detection)', () => {
    expect(resolveEditorRegistration(FOUND, 'auto')).toEqual({
      registerPhotoshop: true,
      registerGimp: true,
      gimpInstall: SAMPLE_INSTALL,
    });
  });

  it('auto: GIMP not found -> ps_* only', () => {
    expect(resolveEditorRegistration(NOT_FOUND, 'auto')).toEqual({
      registerPhotoshop: true,
      registerGimp: false,
      gimpInstall: null,
    });
  });

  it('auto: GIMP detection timed out -> ps_* only (treated the same as not found; Photoshop registers regardless either way)', () => {
    expect(resolveEditorRegistration(TIMED_OUT, 'auto')).toEqual({
      registerPhotoshop: true,
      registerGimp: false,
      gimpInstall: null,
    });
  });

  it("pin 'photoshop' always registers ps_* only, regardless of GIMP detection", () => {
    for (const detected of [FOUND, NOT_FOUND, TIMED_OUT]) {
      expect(resolveEditorRegistration(detected, 'photoshop')).toEqual({
        registerPhotoshop: true,
        registerGimp: false,
        gimpInstall: null,
      });
    }
  });

  it("pin 'gimp' always registers gimp_* and NEVER ps_*, regardless of detection — even with no install found", () => {
    expect(resolveEditorRegistration(NOT_FOUND, 'gimp')).toEqual({
      registerPhotoshop: false,
      registerGimp: true,
      gimpInstall: null,
    });
    expect(resolveEditorRegistration(FOUND, 'gimp')).toEqual({
      registerPhotoshop: false,
      registerGimp: true,
      gimpInstall: SAMPLE_INSTALL,
    });
  });

  it("defaults the pin to 'auto' when omitted", () => {
    expect(resolveEditorRegistration(FOUND)).toEqual(resolveEditorRegistration(FOUND, 'auto'));
  });

  it('a Photoshop detection false-negative can never remove the Photoshop tools (the settled safety invariant)', () => {
    // There is no "photoshop found" input to this function at all any more
    // — this test exists to make that invariant explicit and future-proof:
    // no matter what GIMP detection says, registerPhotoshop is true unless
    // the pin is literally 'gimp'.
    for (const detected of [FOUND, NOT_FOUND, TIMED_OUT]) {
      for (const pin of ['auto', 'photoshop'] as const) {
        expect(resolveEditorRegistration(detected, pin).registerPhotoshop).toBe(true);
      }
    }
  });
});

function makeSettings(over: Partial<Settings> = {}): Settings {
  return {
    telemetry: { usage: true, diagnostics: false, install_id: 'a'.repeat(32) },
    privacy: { send_previews_to_llm: true },
    ps_path: null,
    update_check: true,
    editor: 'auto',
    gimp_path: null,
    ...over,
  };
}

describe('resolveBootEditors', () => {
  afterEach(() => {
    vi.mocked(detectGimp).mockClear();
    vi.mocked(detectGimp).mockReset();
  });

  it('runs detection and folds it through resolveEditorRegistration using the settings pin', async () => {
    const detectEditorsFn = vi.fn(async () => ({ gimp: SAMPLE_INSTALL, timedOut: false }));
    const result = await resolveBootEditors({
      settings: makeSettings({ editor: 'auto' }),
      env: {},
      detectEditorsFn,
    });
    expect(detectEditorsFn).toHaveBeenCalledOnce();
    expect(result).toEqual({
      registerPhotoshop: true,
      registerGimp: true,
      gimpInstall: SAMPLE_INSTALL,
    });
  });

  it('EDITMAMEI_EDITOR env overrides the settings-file pin', async () => {
    const detectEditorsFn = vi.fn(async () => ({ gimp: SAMPLE_INSTALL, timedOut: false }));
    const result = await resolveBootEditors({
      settings: makeSettings({ editor: 'auto' }),
      env: { EDITMAMEI_EDITOR: 'gimp' },
      detectEditorsFn,
    });
    expect(result.registerPhotoshop).toBe(false);
    expect(result.registerGimp).toBe(true);
  });

  it("EDITMAMEI_GIMP_PATH overrides detectGimp's env, ahead of the settings gimp_path field", async () => {
    vi.mocked(detectGimp).mockResolvedValue(null);
    await resolveBootEditors({
      settings: makeSettings({ gimp_path: 'C:/from-settings/gimp-console.exe' }),
      env: { EDITMAMEI_GIMP_PATH: 'C:/from-env/gimp-console.exe' },
    });
    expect(detectGimp).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({ EDITMAMEI_GIMP_PATH: 'C:/from-env/gimp-console.exe' }),
      })
    );
  });

  it('falls back to the settings gimp_path field when EDITMAMEI_GIMP_PATH is unset', async () => {
    vi.mocked(detectGimp).mockResolvedValue(null);
    await resolveBootEditors({
      settings: makeSettings({ gimp_path: 'C:/from-settings/gimp-console.exe' }),
      env: {},
    });
    expect(detectGimp).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({ EDITMAMEI_GIMP_PATH: 'C:/from-settings/gimp-console.exe' }),
      })
    );
  });

  it('builds no override at all when neither EDITMAMEI_GIMP_PATH nor gimp_path is set — detectGimp runs with its own defaults', async () => {
    vi.mocked(detectGimp).mockResolvedValue(null);
    await resolveBootEditors({ settings: makeSettings({ gimp_path: null }), env: {} });
    expect(detectGimp).toHaveBeenCalledWith();
  });
});
