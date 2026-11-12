/**
 * ps_relight preview: the orchestration around Photoshop's Relight panel.
 *
 * The panel is opened by script (it blocks Photoshop), the go-core window helper captures the
 * preview and closes the panel, and hidden layers come back. These pin the order, the cleanup on
 * every failure, and honest reporting when the panel rendered anyway. The window helper's own
 * logic is in go-core/window_test.go; the live loop was verified on Photoshop 28.0 / Windows.
 */

import { describe, it, expect } from 'vitest';
import {
  runRelightPreview,
  type PreviewDeps,
  type WindowAction,
} from '@editmamei/tools/relight-preview.ts';

type Mode = 'preview_prepare' | 'preview_open' | 'preview_restore';

interface Scenario {
  platform?: typeof process.platform;
  prepare?: Record<string, unknown> | Error;
  open?: Record<string, unknown> | Error;
  restore?: Record<string, unknown> | Error;
  capture?: Record<string, unknown> | Error;
  helper?: Record<string, unknown> | Error;
  cancel?: Record<string, unknown> | Error;
}

const PNG = 'iVBORw0KGgo=';

function harness(sc: Scenario = {}) {
  const log: string[] = [];
  const scripts: Array<{ mode: Mode; extra: Record<string, unknown>; timeoutMs?: number }> = [];
  const windowCalls: Array<{ action: WindowAction; args: string[]; signal?: AbortSignal }> = [];
  const pick = async (
    v: Record<string, unknown> | Error | undefined,
    dflt: Record<string, unknown>
  ) => {
    if (v instanceof Error) throw v;
    return v ?? dflt;
  };
  const deps: PreviewDeps = {
    platform: sc.platform ?? 'win32',
    script: async (mode, extra, timeoutMs) => {
      log.push(`script:${mode}`);
      scripts.push({ mode, extra, timeoutMs });
      if (mode === 'preview_prepare') {
        return pick(sc.prepare, {
          prepared: true,
          edit: false,
          hidden_ids: [],
          context: { document: { width: 3508, height: 5260 } },
        });
      }
      if (mode === 'preview_open') {
        return pick(sc.open, { panel_closed: true, rendered: false, edit: false, open_error: '' });
      }
      return pick(sc.restore, { restored: 1 });
    },
    window: async (action, args, _timeout, signal) => {
      log.push(`window:${action}`);
      windowCalls.push({ action, args, signal });
      if (action === 'capture') {
        return pick(sc.capture, {
          crop: { x: 10, y: 20, w: 583, h: 880 },
          signature: 'ab'.repeat(1024),
          window_signature: 'cd'.repeat(1024),
        });
      }
      if (action === 'relight-preview') {
        return pick(sc.helper, {
          settled: true,
          png_base64: PNG,
          width: 583,
          height: 880,
          closed: 'discarded',
        });
      }
      return pick(sc.cancel, { closed: 'discarded' });
    },
  };
  return { deps, log, scripts, windowCalls };
}

const LIGHTS = [{ left_right: 90 }];

describe('runRelightPreview', () => {
  it('returns the captured preview as an image, free and unrendered', async () => {
    const h = harness();
    const result = await runRelightPreview(h.deps, LIGHTS, 30);
    expect(result.isError).toBeFalsy();
    expect(result.content[0]).toEqual({ type: 'image', data: PNG, mimeType: 'image/png' });
    expect(result.structuredContent).toMatchObject({
      preview: true,
      rendered: false,
      adobe_credits_used: 0,
      settled: true,
      lights: LIGHTS,
    });
    const words = (result.content[1] as { text: string }).text;
    expect(words).toMatch(/no Adobe Firefly credits used/);
    expect(words).toMatch(/costs 30 Adobe Firefly credits and needs the person's approval/);
  });

  it('captures the baseline before the panel opens, with the document shape', async () => {
    const h = harness();
    await runRelightPreview(h.deps, LIGHTS, 30);
    expect(h.log.indexOf('window:capture')).toBeLessThan(h.log.indexOf('script:preview_open'));
    expect(h.windowCalls[0].args).toEqual(['-aspect', (3508 / 5260).toFixed(6)]);
    const helper = h.windowCalls.find((c) => c.action === 'relight-preview')!;
    expect(helper.args).toEqual(
      expect.arrayContaining(['-crop', '10,20,583,880', '-baseline', '-window-baseline'])
    );
    expect(h.scripts.find((s) => s.mode === 'preview_open')!.timeoutMs).toBe(90_000);
  });

  it('shows the hidden layers again afterwards', async () => {
    const h = harness({
      prepare: {
        prepared: true,
        hidden_ids: [7, 9],
        context: { document: { width: 1, height: 1 } },
      },
    });
    await runRelightPreview(h.deps, LIGHTS, 30);
    const restore = h.scripts.find((s) => s.mode === 'preview_restore');
    expect(restore?.extra).toEqual({ hiddenIds: [7, 9] });
    expect(h.log.at(-1)).toBe('script:preview_restore');
  });

  it("doesn't touch layers it never hid", async () => {
    const h = harness();
    await runRelightPreview(h.deps, LIGHTS, 30);
    expect(h.scripts.some((s) => s.mode === 'preview_restore')).toBe(false);
  });

  it('reports a render honestly when Done was clicked in the panel', async () => {
    const h = harness({
      open: { panel_closed: true, rendered: true, layer_name: 'Relight Layer 2', edit: false },
    });
    const result = await runRelightPreview(h.deps, LIGHTS, 30);
    expect(result.structuredContent).toMatchObject({
      preview: true,
      rendered: true,
      adobe_credits_used: 30,
      layer_name: 'Relight Layer 2',
    });
    expect((result.content[0] as { text: string }).text).toMatch(
      /30 Adobe Firefly generative credits were used/
    );
  });

  it('closes the panel from outside when its script fails, then restores layers', async () => {
    const h = harness({
      prepare: { prepared: true, hidden_ids: [4], context: { document: { width: 1, height: 1 } } },
      open: new Error('Script execution timeout after 90000ms'),
      helper: { settled: false, closed: 'failed', error: 'no key sent' },
    });
    const result = await runRelightPreview(h.deps, LIGHTS, 30);
    expect(h.log).toContain('window:cancel-relight');
    expect(h.scripts.some((s) => s.mode === 'preview_restore')).toBe(true);
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.adobe_credits_used).toBe(0);
  });

  it('stops the window helper when the panel script fails', async () => {
    let helperSignal: AbortSignal | undefined;
    const h = harness({ open: new Error('boom') });
    const window = h.deps.window;
    h.deps.window = async (action, args, timeoutMs, signal) => {
      if (action === 'relight-preview') {
        helperSignal = signal;
        await new Promise((r) => setTimeout(r, 5));
      }
      return window(action, args, timeoutMs, signal);
    };
    await runRelightPreview(h.deps, LIGHTS, 30);
    expect(helperSignal?.aborted).toBe(true);
  });

  it('tells the person to close the panel when it cannot be closed, and keeps layers as they are', async () => {
    const h = harness({
      prepare: { prepared: true, hidden_ids: [4], context: { document: { width: 1, height: 1 } } },
      open: new Error('Script execution timeout'),
      helper: { closed: 'failed', error: "couldn't bring Photoshop to the front" },
      cancel: new Error("couldn't bring Photoshop to the front"),
    });
    const result = await runRelightPreview(h.deps, LIGHTS, 30);
    expect(result.isError).toBe(true);
    const words = (result.content[0] as { text: string }).text;
    expect(words).toMatch(/click Cancel/);
    expect(words).toMatch(/never Done/);
    expect(words).toMatch(/ps_set_layer/);
    // A restore would queue behind the open panel; it waits for the person.
    expect(h.scripts.some((s) => s.mode === 'preview_restore')).toBe(false);
    expect(result.structuredContent?.hidden_layer_ids).toEqual([4]);
  });

  it('retries closing once when the helper could not send Escape', async () => {
    let opened = true;
    const h = harness({ helper: { settled: true, png_base64: PNG, closed: 'failed' } });
    const script = h.deps.script;
    h.deps.script = async (mode, extra, t) => {
      if (mode === 'preview_open') {
        // The panel closes only once cancel-relight has run.
        while (opened) await new Promise((r) => setTimeout(r, 1));
      }
      return script(mode, extra, t);
    };
    const window = h.deps.window;
    h.deps.window = async (action, args, t, signal) => {
      if (action === 'cancel-relight') opened = false;
      return window(action, args, t, signal);
    };
    const result = await runRelightPreview(h.deps, LIGHTS, 30);
    expect(h.log).toContain('window:cancel-relight');
    expect(result.isError).toBeFalsy();
  });

  it('restores layers when the first capture fails, without opening the panel', async () => {
    const h = harness({
      prepare: { prepared: true, hidden_ids: [3], context: { document: { width: 1, height: 1 } } },
      capture: new Error("couldn't find the photo in Photoshop's window, so there's no preview"),
    });
    const result = await runRelightPreview(h.deps, LIGHTS, 30);
    expect(result.isError).toBe(true);
    expect(h.scripts.some((s) => s.mode === 'preview_open')).toBe(false);
    expect(h.scripts.some((s) => s.mode === 'preview_restore')).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/couldn't find the photo/);
  });

  it("isn't available on macOS yet, and touches nothing there", async () => {
    const h = harness({ platform: 'darwin' });
    const result = await runRelightPreview(h.deps, LIGHTS, 30);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/isn't available on macOS yet/);
    expect(h.log).toEqual([]);
  });

  // On non-English Photoshop (or with keys blocked) the Discard dialog isn't recognized and the
  // helper reports no_dialog while the panel is still open. That must not count as closed.
  it('treats no_dialog on a new-layer preview as still open, and says so promptly', async () => {
    const h = harness({
      prepare: { prepared: true, hidden_ids: [4], context: { document: { width: 1, height: 1 } } },
      helper: { settled: true, png_base64: PNG, closed: 'no_dialog' },
      cancel: { closed: 'no_dialog' },
    });
    h.deps.panelGraceMs = 20;
    const script = h.deps.script;
    h.deps.script = (mode, extra, t) =>
      mode === 'preview_open' ? new Promise(() => undefined) : script(mode, extra, t);
    const started = Date.now();
    const result = await runRelightPreview(h.deps, LIGHTS, 30);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/click Cancel/);
    expect(h.scripts.some((s) => s.mode === 'preview_restore')).toBe(false);
  });

  it('accepts no_dialog as closed for an edit preview, whose panel closes on Escape', async () => {
    const h = harness({
      prepare: {
        prepared: true,
        edit: true,
        hidden_ids: [],
        context: { document: { width: 1, height: 1 } },
      },
      helper: { settled: true, png_base64: PNG, closed: 'no_dialog' },
    });
    const result = await runRelightPreview(h.deps, LIGHTS, 30);
    expect(result.isError).toBeFalsy();
    expect(h.log).not.toContain('window:cancel-relight');
  });

  it('after a timeout, a cancel that finds no dialog leaves a new-layer panel counted open', async () => {
    const h = harness({
      prepare: { prepared: true, hidden_ids: [4], context: { document: { width: 1, height: 1 } } },
      open: new Error('Script execution timeout after 90000ms'),
      helper: { closed: 'failed' },
      cancel: { closed: 'no_dialog' },
    });
    const result = await runRelightPreview(h.deps, LIGHTS, 30);
    expect((result.content[0] as { text: string }).text).toMatch(/click Cancel/);
    expect(h.scripts.some((s) => s.mode === 'preview_restore')).toBe(false);
  });

  it("doesn't send keys to close a panel when the script itself failed (it isn't holding Photoshop)", async () => {
    const h = harness({ open: new Error('Relight did not open: no layer') });
    const result = await runRelightPreview(h.deps, LIGHTS, 30);
    expect(result.isError).toBe(true);
    expect(h.log).not.toContain('window:cancel-relight');
  });

  it('notices a render by the layer count when the panel script timed out', async () => {
    const h = harness({
      prepare: {
        prepared: true,
        hidden_ids: [],
        layer_count: 2,
        context: { document: { width: 1, height: 1 } },
      },
      open: new Error('Script execution timeout after 90000ms'),
      helper: { closed: 'failed' },
      restore: { restored: 0, layer_count: 3 },
    });
    const result = await runRelightPreview(h.deps, LIGHTS, 30);
    expect(result.structuredContent).toMatchObject({ rendered: true, adobe_credits_used: 30 });
  });

  it('says so when not every hidden layer came back', async () => {
    const h = harness({
      prepare: {
        prepared: true,
        hidden_ids: [4, 5],
        context: { document: { width: 1, height: 1 } },
      },
      restore: { restored: 1, layer_count: 3 },
    });
    const result = await runRelightPreview(h.deps, LIGHTS, 30);
    expect(result.isError).toBeFalsy();
    expect(result.content[0]).toMatchObject({ type: 'image' });
    expect((result.content[1] as { text: string }).text).toMatch(/1 of the 2 layer/);
  });

  // A script timeout means the panel didn't close, even for an edit preview (whose panel can
  // close with no dialog): a cancel that finds no dialog proves nothing then.
  it('after a timeout, an edit preview needs a clicked Discard to count as closed', async () => {
    const h = harness({
      prepare: {
        prepared: true,
        edit: true,
        hidden_ids: [4],
        context: { document: { width: 1, height: 1 } },
      },
      open: new Error('Script execution timeout after 90000ms'),
      helper: { closed: 'no_dialog' },
      cancel: { closed: 'no_dialog' },
    });
    const result = await runRelightPreview(h.deps, LIGHTS, 30);
    expect((result.content[0] as { text: string }).text).toMatch(/click Cancel/);
    expect(h.scripts.some((s) => s.mode === 'preview_restore')).toBe(false);
  });

  it('a restore stuck behind the panel means the panel is still open', async () => {
    const h = harness({
      prepare: { prepared: true, hidden_ids: [4], context: { document: { width: 1, height: 1 } } },
      restore: new Error('Script execution timeout after 10000ms'),
    });
    const result = await runRelightPreview(h.deps, LIGHTS, 30);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/click Cancel/);
    expect(h.scripts.find((s) => s.mode === 'preview_restore')?.timeoutMs).toBe(10_000);
  });

  it('marks an unsettled preview as rough', async () => {
    const h = harness({ helper: { settled: false, png_base64: PNG, closed: 'no_dialog' } });
    const result = await runRelightPreview(h.deps, LIGHTS, 30);
    expect(result.structuredContent?.settled).toBe(false);
    expect((result.content[1] as { text: string }).text).toMatch(/rough/);
  });
});
