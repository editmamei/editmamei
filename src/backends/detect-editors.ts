/**
 * Time-boxed GIMP install detection, and the pure decision that turns it
 * (plus the `editor` pin) into which built-in tool modules a boot registers.
 *
 * Filesystem-only — this never round-trips an editor, preserving the
 * boot-ordering invariant the MCP handshake depends on (`server.ts`'s
 * `loadModules()` → `connect()` → fire-and-forget warmup sequence).
 * `detectEditors()` only reports what it finds; it does not decide which
 * tool modules a boot sequence loads — that decision is
 * `resolveEditorRegistration` below.
 *
 * Photoshop is NOT probed here. The registration decision below registers
 * the Photoshop tool set unconditionally unless the pin says otherwise, so a
 * Photoshop presence check has nothing left to decide — a false negative
 * from a registry/filesystem probe could otherwise remove the Photoshop
 * tools for a machine that has it installed, for no benefit. Photoshop's own
 * connection still detects its install lazily on first use, exactly as it
 * did before GIMP support existed (`PhotoshopConnection`'s own detect seam).
 */

import { detectGimp, type GimpInstall, type DetectGimpOptions } from './gimp/detect.js';
import { applyEditorEnvOverride, type EditorPin, type Settings } from '../core/settings.js';

export interface DetectEditorsOptions {
  /** Time box in ms for the GIMP probe. Default 750. */
  budgetMs?: number;
  /** Injected GIMP detector (tests). Defaults to the real `detectGimp`. */
  detectGimp?: (opts?: DetectGimpOptions) => Promise<GimpInstall | null>;
}

export interface DetectEditorsResult {
  gimp: GimpInstall | null;
  timedOut: boolean;
}

/**
 * Detect a GIMP install, capped at a time box. On timeout, `timedOut` is
 * `true` and `gimp` stays at its not-found default rather than blocking the
 * caller further.
 */
export async function detectEditors(opts: DetectEditorsOptions = {}): Promise<DetectEditorsResult> {
  const budgetMs = opts.budgetMs ?? 750;
  const gimpDetector = opts.detectGimp ?? detectGimp;

  // A plain local, not a shared result object mutated from both the probe
  // and the timer: a naive shared-object version leaves the timer running
  // after the probe wins the race, and it goes on to flip `timedOut` on the
  // object the caller already received. Building the result once, after the
  // race is decided, makes that impossible.
  let gimp: GimpInstall | null = null;

  const gimpProbe = gimpDetector().then(
    (install) => {
      gimp = install;
    },
    () => {
      gimp = null;
    }
  );

  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), budgetMs);
  });

  const winner = await Promise.race([gimpProbe.then(() => 'settled' as const), timeout]);
  clearTimeout(timer!);

  return { gimp, timedOut: winner === 'timeout' };
}

/** Which built-in editor tool sets `EditmameiServer` should register. */
export interface EditorRegistrationDecision {
  registerPhotoshop: boolean;
  registerGimp: boolean;
  /** Handed to `GimpBackend` when `registerGimp` — `null` when pinned to 'gimp' but nothing was actually found. */
  gimpInstall: GimpInstall | null;
}

/**
 * Turn a `detectEditors()` result plus the `editor` pin into the boot
 * decision `src/index.ts` hands `EditmameiServer`. Pure and synchronous —
 * `detectEditors` already did the only I/O this needs.
 *
 * The rule is deliberately asymmetric between the two editors:
 *
 *   - **Photoshop tools register unless the pin explicitly says 'gimp'.**
 *     There is no Photoshop presence check feeding this decision (see the
 *     file doc comment) — a detection false negative can never remove the
 *     Photoshop surface a user may be relying on. The downloaded Pro module
 *     follows the same rule (only skipped when pinned to 'gimp' — see
 *     `ModuleLifecycle`/`server.ts`).
 *   - **GIMP tools register when a GIMP install was actually found, or when
 *     pinned to 'gimp'** (in which case they register even with nothing
 *     found — every `gimp_*` call then fails once with a clear
 *     `gimp_not_installed` error, an honest, actionable failure rather than
 *     a silently empty tool surface).
 *   - **Pin 'photoshop'** forces Photoshop-only, regardless of what GIMP
 *     detection found.
 *
 * Both tool sets can be present at once (both register whenever GIMP is
 * found and the pin isn't 'gimp'); GIMP registering never excludes
 * Photoshop — only an explicit 'gimp' pin does that.
 */
export function resolveEditorRegistration(
  detected: DetectEditorsResult,
  pin: EditorPin = 'auto'
): EditorRegistrationDecision {
  if (pin === 'gimp') {
    return { registerPhotoshop: false, registerGimp: true, gimpInstall: detected.gimp };
  }
  if (pin === 'photoshop') {
    return { registerPhotoshop: true, registerGimp: false, gimpInstall: null };
  }
  const gimpFound = detected.gimp !== null;
  return {
    registerPhotoshop: true,
    registerGimp: gimpFound,
    gimpInstall: gimpFound ? detected.gimp : null,
  };
}

export interface ResolveBootEditorsOptions {
  settings: Settings;
  /** Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Injected for tests. Defaults to the real `detectEditors`. */
  detectEditorsFn?: typeof detectEditors;
}

/**
 * The whole boot-time editor decision, in one testable, mostly-pure
 * function: applies the `EDITMAMEI_EDITOR` env override onto the loaded
 * settings, resolves a `gimp_path` override (`EDITMAMEI_GIMP_PATH` wins over
 * the settings field, mirroring how `detectGimp` itself already treats that
 * env var) into a `detectGimp` override, runs `detectEditors`, and folds the
 * result through `resolveEditorRegistration`. `src/index.ts` calls this
 * directly instead of inlining the wiring so the whole decision can be
 * exercised with an injected settings object, env, and detector.
 */
export async function resolveBootEditors(
  opts: ResolveBootEditorsOptions
): Promise<EditorRegistrationDecision> {
  const env = opts.env ?? process.env;
  const effectiveSettings = applyEditorEnvOverride(opts.settings, env);
  const gimpPathOverride = env.EDITMAMEI_GIMP_PATH ?? effectiveSettings.gimp_path ?? undefined;
  const detectGimpOverride = gimpPathOverride
    ? (o?: DetectGimpOptions) =>
        detectGimp({ ...o, env: { ...(o?.env ?? env), EDITMAMEI_GIMP_PATH: gimpPathOverride } })
    : undefined;
  const detectEditorsFn = opts.detectEditorsFn ?? detectEditors;
  const detected = await detectEditorsFn({ detectGimp: detectGimpOverride });
  return resolveEditorRegistration(detected, effectiveSettings.editor);
}
