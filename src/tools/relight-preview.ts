/**
 * ps_relight preview: a free look at a relight before anyone pays for it.
 *
 * Photoshop's Relight panel shows a low-resolution preview on the canvas and only
 * renders (and charges Adobe Firefly credits) on Done. Opening the panel by script
 * (AM 'lightshop' with DialogModes.ALL) preloads it with Claude's lights but makes
 * Photoshop modal: no script can run until the panel closes. So the preview is
 * read from Photoshop's own window by the go-core's `window` helpers
 * (go-core/window.go), which then close the panel with Escape and the
 * "Discard" button, never Enter.
 *
 * Order, for one call:
 *   1. preview_prepare script: fit on screen, hide visible layers above the target.
 *   2. `window capture`: the canvas crop and its signature, before the panel.
 *   3. preview_open script (blocks while the panel is open) and, beside it,
 *      `window relight-preview` (waits for the preview, hides the light markers,
 *      captures, closes the panel).
 *   4. preview_restore script: show the layers step 1 hid.
 * Whatever fails, the panel is closed (or the person is told to close it) and the
 * hidden layers are shown again.
 *
 * Windows only for now: on macOS the same idea needs Screen Recording and
 * Accessibility permissions and is untested.
 */
import type { ToolResult } from '../core/tool-registry.js';
import type { SnippetClient } from '../api/snippet-client.js';
import { resolveCoreBinaryPath, ensureExecutable } from '../api/snippet-client.js';
import { runChildWithTimeout } from '../platform/run-child.js';
import type { PhotoshopConnection } from '../platform/connection.js';
import { runScript } from '../utils/run-script.js';

/** How long the panel script may hold Photoshop. The preview lands in ~5 s. */
export const PREVIEW_PANEL_TIMEOUT_MS = 90_000;
/** How long the window helper waits for the preview to appear and settle. */
export const PREVIEW_SETTLE_TIMEOUT_MS = 45_000;
const WINDOW_CAPTURE_TIMEOUT_MS = 15_000;
// Settle wait plus the N press, the capture, Escape and the dialog search.
const WINDOW_PREVIEW_CHILD_TIMEOUT_MS = PREVIEW_SETTLE_TIMEOUT_MS + 20_000;
const WINDOW_CANCEL_TIMEOUT_MS = 15_000;
/**
 * How long to wait for the panel script after the helper could NOT confirm the panel
 * closed. A closed panel returns its script at once; past this, it's still open.
 */
export const PANEL_CLOSE_GRACE_MS = 5_000;

export type WindowAction = 'capture' | 'relight-preview' | 'cancel-relight';

/** Runs `editmamei-core window <action>` and returns its JSON. Throws on its error. */
export type WindowRunner = (
  action: WindowAction,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal
) => Promise<Record<string, unknown>>;

/** Runs the relight snippet in one mode and returns the script's result. */
export type RelightScriptRunner = (
  mode: 'preview_prepare' | 'preview_open' | 'preview_restore',
  extra: Record<string, unknown>,
  timeoutMs?: number
) => Promise<Record<string, unknown>>;

export interface PreviewDeps {
  platform: typeof process.platform;
  script: RelightScriptRunner;
  window: WindowRunner;
  /** Tests shorten PANEL_CLOSE_GRACE_MS. */
  panelGraceMs?: number;
}

type Settled<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown }
  | { status: 'pending' };

/** Wait for a promise, but no longer than ms. */
async function settleWithin<T>(p: Promise<T>, ms: number): Promise<Settled<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Promise<Settled<T>>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'pending' }), ms);
  });
  try {
    return await Promise.race([
      p.then(
        (value): Settled<T> => ({ status: 'fulfilled', value }),
        (reason: unknown): Settled<T> => ({ status: 'rejected', reason })
      ),
      pending,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A script runner timeout: Photoshop may still be holding the panel open. */
function isTimeout(e: unknown): boolean {
  return /time(d)? ?out/i.test(errorText(e));
}

export function coreWindowRunner(binaryPath: string = resolveCoreBinaryPath()): WindowRunner {
  return async (action, args, timeoutMs, signal) => {
    ensureExecutable(binaryPath);
    const result = await runChildWithTimeout(binaryPath, ['window', action, ...args], {
      timeout: timeoutMs,
      diagLabel: `editmamei-core window ${action}`,
      signal,
    });
    if (signal?.aborted) return { aborted: true };
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    } catch {
      throw new Error(
        `editmamei-core window ${action} failed (exit ${result.exitCode}): ${result.stderr.trim() || '(no output)'}`
      );
    }
    if (result.exitCode !== 0) {
      throw new Error(String(parsed.error ?? `editmamei-core window ${action} failed`));
    }
    return parsed;
  };
}

export function snippetScriptRunner(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  base: Record<string, unknown>
): RelightScriptRunner {
  return async (mode, extra, timeoutMs) => {
    const script = await snippetClient.build('relight', { ...base, ...extra, mode });
    return (await runScript(connection, script, timeoutMs)) as Record<string, unknown>;
  };
}

function text(t: string): ToolResult['content'][number] {
  return { type: 'text' as const, text: t };
}

function previewError(message: string, extra: Record<string, unknown> = {}): ToolResult {
  return {
    content: [text(message)],
    structuredContent: { preview: true, rendered: false, adobe_credits_used: 0, ...extra },
    isError: true,
  };
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const CLOSE_PANEL_BY_HAND =
  "Photoshop's Relight panel may still be open. Ask the person to click Cancel in it (not Done, which renders and costs Adobe Firefly credits) before anything else runs in Photoshop.";

/**
 * Runs one free preview. `lights` is echoed back as the person's slider values,
 * and `renderedCredits` is what a Done in the panel costs, for honest reporting.
 */
export async function runRelightPreview(
  deps: PreviewDeps,
  lights: unknown[],
  renderedCredits: number
): Promise<ToolResult> {
  if (deps.platform !== 'win32') {
    return previewError(
      "The free Relight preview isn't available on macOS yet. Plan the lights carefully and render once with the person's approval (ps_relight without preview)."
    );
  }

  let prepared: Record<string, unknown>;
  try {
    prepared = await deps.script('preview_prepare', {});
  } catch (e) {
    return previewError(`Couldn't start the Relight preview: ${errorText(e)}`);
  }
  const hiddenIds = Array.isArray(prepared.hidden_ids) ? (prepared.hidden_ids as number[]) : [];
  const edit = prepared.edit === true;
  const docWidth = Number((prepared.context as { document?: { width?: number } })?.document?.width);
  const docHeight = Number(
    (prepared.context as { document?: { height?: number } })?.document?.height
  );
  const aspect = docWidth > 0 && docHeight > 0 ? docWidth / docHeight : 0;

  // Did closing work? A new-layer preview closes only through the Discard dialog,
  // so for it only 'discarded' counts: 'no_dialog' there means the dialog wasn't
  // recognized (another UI language, blocked keys) and the panel may still be
  // open. An edit preview's panel closes on Escape with no dialog.
  const closedBy = (closed: unknown): boolean =>
    closed === 'discarded' || (edit && closed === 'no_dialog');
  const graceMs = deps.panelGraceMs ?? PANEL_CLOSE_GRACE_MS;

  let panelStarted = false;
  let panelClosed = true;
  let panelResult: Record<string, unknown> | null = null;
  let shot: Record<string, unknown> | null = null;
  let failure: string | null = null;
  let layersAfter: number | null = null;
  // A layer that couldn't be shown again is worth saying, but doesn't spoil the preview.
  let restoreNote = '';

  try {
    const base = await deps.window(
      'capture',
      aspect > 0 ? ['-aspect', aspect.toFixed(6)] : [],
      WINDOW_CAPTURE_TIMEOUT_MS
    );
    const crop = base.crop as { x: number; y: number; w: number; h: number };
    const helperArgs = [
      '-crop',
      `${crop.x},${crop.y},${crop.w},${crop.h}`,
      '-baseline',
      String(base.signature),
      '-timeout-ms',
      String(PREVIEW_SETTLE_TIMEOUT_MS),
    ];
    if (typeof base.window_signature === 'string') {
      helperArgs.push('-window-baseline', base.window_signature);
    }

    const stopHelper = new AbortController();
    panelStarted = true;
    panelClosed = false;
    const panel = deps
      .script('preview_open', {}, PREVIEW_PANEL_TIMEOUT_MS)
      .then((r) => {
        panelClosed = true;
        // The panel never opened (Photoshop refused it): nothing to wait for.
        if (typeof r.open_error === 'string' && r.open_error !== '') stopHelper.abort();
        return r;
      })
      .catch((e: unknown) => {
        stopHelper.abort();
        throw e;
      });
    // Settled below; this only keeps an early rejection from going unhandled.
    panel.catch(() => undefined);

    let helperResult = await deps
      .window('relight-preview', helperArgs, WINDOW_PREVIEW_CHILD_TIMEOUT_MS, stopHelper.signal)
      .catch(
        (e: unknown) => ({ closed: 'failed', error: errorText(e) }) as Record<string, unknown>
      );
    if (!closedBy(helperResult.closed) && !panelClosed && !stopHelper.signal.aborted) {
      // The helper couldn't close the panel: try once more before giving up.
      try {
        const retry = await deps.window('cancel-relight', [], WINDOW_CANCEL_TIMEOUT_MS);
        helperResult = { ...helperResult, closed_retry: retry.closed };
      } catch {
        // Handled below: the panel is treated as possibly open.
      }
    }
    shot = helperResult;
    const helperClosed = closedBy(helperResult.closed) || closedBy(helperResult.closed_retry);

    // When the helper closed the panel, the script returns at once; give it the
    // full timeout in case Photoshop is slow. When it didn't, wait only briefly:
    // a panel that's still open won't close by itself, and the person should be
    // told now rather than after the script times out.
    const outcome = await settleWithin(
      panel,
      helperClosed || stopHelper.signal.aborted ? PREVIEW_PANEL_TIMEOUT_MS + 5_000 : graceMs
    );
    if (outcome.status === 'fulfilled') {
      panelResult = outcome.value;
    } else if (outcome.status === 'pending') {
      failure = "the Relight panel didn't close";
    } else if (!isTimeout(outcome.reason)) {
      // The script itself threw, so it finished and Photoshop isn't held.
      panelClosed = true;
      failure = `the Relight panel script failed: ${errorText(outcome.reason)}`;
    } else {
      failure = `the Relight panel script failed: ${errorText(outcome.reason)}`;
      // A script timeout leaves the panel open in Photoshop: close it from outside.
      try {
        const closed = await deps.window('cancel-relight', [], WINDOW_CANCEL_TIMEOUT_MS);
        panelClosed = closedBy(closed.closed);
      } catch {
        panelClosed = false;
      }
    }
  } catch (e) {
    failure = errorText(e);
  } finally {
    // A restore queues behind an open panel and would hang, so it runs only once
    // the panel is known closed. Without a script result it also reads the layer
    // count, to tell whether Done rendered.
    if (panelClosed && (hiddenIds.length > 0 || (panelStarted && !panelResult))) {
      try {
        const restored = await deps.script('preview_restore', { hiddenIds });
        if (typeof restored.layer_count === 'number') layersAfter = restored.layer_count;
        if (typeof restored.restored === 'number' && restored.restored < hiddenIds.length) {
          restoreNote = ` ${hiddenIds.length - restored.restored} of the ${hiddenIds.length} layer(s) hidden for the preview couldn't be shown again; show them with ps_set_layer.`;
        }
      } catch (e) {
        restoreNote = ` Couldn't show the ${hiddenIds.length} layer(s) hidden for the preview again (${errorText(e)}); show them with ps_set_layer.`;
      }
    }
  }

  const layersBefore = typeof prepared.layer_count === 'number' ? prepared.layer_count : null;
  const rendered =
    panelResult?.rendered === true ||
    (!panelResult && layersAfter !== null && layersBefore !== null && layersAfter > layersBefore);
  if (rendered) {
    // Someone clicked Done in the panel: Photoshop rendered and charged for it.
    const layer = String(panelResult?.layer_name ?? '') || 'a Relight layer';
    return {
      content: [
        text(
          `Photoshop rendered this relight: Done was clicked in the Relight panel, so ${renderedCredits} Adobe Firefly generative credits were used and the result is "${layer}". Check it with ps_get_preview.${restoreNote}`
        ),
      ],
      structuredContent: {
        preview: true,
        rendered: true,
        adobe_credits_used: renderedCredits,
        layer_name: layer,
        edit,
        context: panelResult?.context,
      },
    };
  }

  if (!panelClosed) {
    return previewError(
      `The Relight preview didn't finish: ${failure ?? 'the panel did not close'}. ${CLOSE_PANEL_BY_HAND}` +
        (hiddenIds.length > 0
          ? ` ${hiddenIds.length} layer(s) above it were hidden for the preview; show them again with ps_set_layer once the panel is closed.`
          : ''),
      { hidden_layer_ids: hiddenIds }
    );
  }

  const png = typeof shot?.png_base64 === 'string' ? shot.png_base64 : '';
  const openError = typeof panelResult?.open_error === 'string' ? panelResult.open_error : '';
  if (openError) {
    return previewError(`Photoshop didn't open the Relight panel: ${openError}`);
  }
  if (!png || failure || !panelStarted) {
    const why = failure ?? (typeof shot?.error === 'string' ? shot.error : 'no image came back');
    // Without the panel script's own answer, a render can only be ruled out by
    // the layer count, and an edit adds no layer.
    const outcome =
      panelResult || !panelStarted
        ? 'Nothing was rendered and no Adobe Firefly credits were used.'
        : edit
          ? "Photoshop's panel was closed from outside, so whether anything rendered can't be confirmed: check the Relight layer and the History panel before trying again."
          : 'No new Relight layer appeared, so nothing was rendered.';
    return previewError(`No preview image: ${why}. ${outcome}${restoreNote}`);
  }

  const settled = shot?.settled === true;
  const note = settled
    ? ''
    : " The preview may not have finished drawing (it didn't hold still in time), so treat it as rough.";
  return {
    content: [
      {
        type: 'image' as const,
        data: png,
        mimeType: 'image/png',
      },
      text(
        `Free preview from Photoshop's Relight panel${edit ? ' (editing the existing Relight layer)' : ''}: low resolution, nothing rendered, no Adobe Firefly credits used. Judge the light's direction, color and mood from it, not fine detail.${note} To keep this look, call ps_relight again with the same lights and without preview: that render costs ${renderedCredits} Adobe Firefly credits and needs the person's approval.${restoreNote}`
      ),
    ],
    structuredContent: {
      preview: true,
      rendered: false,
      adobe_credits_used: 0,
      settled,
      edit,
      lights,
      preview_width: shot?.width,
      preview_height: shot?.height,
      context: panelResult?.context,
    },
  };
}
