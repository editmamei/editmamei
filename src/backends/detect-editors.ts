/**
 * Time-boxed, concurrent install detection for both editors.
 *
 * Filesystem/registry only — this never round-trips an editor, preserving the
 * boot-ordering invariant the MCP handshake depends on (`server.ts`'s
 * `loadModules()` → `connect()` → fire-and-forget warmup sequence).
 * `detectEditors()` only reports what it finds; it does not decide which
 * tool modules a boot sequence loads — that decision, and wiring this
 * result into it, belongs to the caller.
 *
 * Photoshop detection reuses the existing platform detector
 * (`resolveHostPlatform().detector`) the same way `PhotoshopConnection` does,
 * so a later caller that also constructs a `PhotoshopConnection` doesn't pay
 * for detection twice. Both real detectors (`WindowsDetector`,
 * `MacOSDetector`) reject when nothing is found and resolve when something is
 * — `detectEditors` only cares about which, not the resolved `PhotoshopInfo`
 * itself.
 */

import { resolveHostPlatform, type HostPlatform } from '../platform/host-platform.js';
import { detectGimp, type GimpInstall, type DetectGimpOptions } from './gimp/detect.js';

export interface DetectEditorsOptions {
  /** Overall time box in ms for both probes together. Default 750. */
  budgetMs?: number;
  /** Injected host platform (tests). Defaults to `resolveHostPlatform()`. */
  hostPlatform?: HostPlatform;
  /** Injected GIMP detector (tests). Defaults to the real `detectGimp`. */
  detectGimp?: (opts?: DetectGimpOptions) => Promise<GimpInstall | null>;
}

export interface DetectEditorsResult {
  photoshop: boolean;
  gimp: GimpInstall | null;
  timedOut: boolean;
}

/**
 * Detect Photoshop and GIMP installs concurrently, capped at one shared time
 * box. On timeout, `timedOut` is `true` and the result carries whichever
 * probe(s) had already finished — the other stays at its not-found default
 * rather than blocking the caller further.
 */
export async function detectEditors(opts: DetectEditorsOptions = {}): Promise<DetectEditorsResult> {
  const budgetMs = opts.budgetMs ?? 750;
  const host = opts.hostPlatform ?? resolveHostPlatform();
  const gimpDetector = opts.detectGimp ?? detectGimp;

  // Plain locals, not a shared result object mutated from both a probe and a
  // timer: a naive shared-object version leaves the timer running after the
  // probes win the race, and it goes on to flip `timedOut` on the object the
  // caller already received. Building the result once, after the race is
  // decided, makes that impossible.
  let photoshop = false;
  let gimp: GimpInstall | null = null;

  const psProbe = host.detector.detect().then(
    () => {
      photoshop = true;
    },
    () => {
      photoshop = false;
    }
  );
  const gimpProbe = gimpDetector().then(
    (install) => {
      gimp = install;
    },
    () => {
      gimp = null;
    }
  );

  const both = Promise.all([psProbe, gimpProbe]).then(() => 'settled' as const);
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), budgetMs);
  });

  const winner = await Promise.race([both, timeout]);
  clearTimeout(timer!);

  return { photoshop, gimp, timedOut: winner === 'timeout' };
}
