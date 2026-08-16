/**
 * Ask the go-core binary whether a modal dialog is blocking Photoshop, and
 * optionally click one of its buttons.
 *
 * **This deliberately does NOT go through `ScriptQueue`.** The queue is
 * occupied by the very call the dialog is blocking, so anything enqueued
 * behind it waits on a call that cannot finish until the queue drains — a
 * deadlock. Spawning the core binary as a sibling process is what makes this
 * observable at all: window enumeration does not travel over the scripting
 * transport, so it still works while that transport is dead.
 *
 * Every method resolves; none reject. A broken probe must never be able to
 * turn a working call into a failing one, so any spawn/parse/exit failure
 * becomes `{ status: 'unknown' }` — which callers must treat as "could not
 * tell", never as "no dialog".
 */
import { resolveCoreBinaryPath } from '../api/snippet-client.js';
import { Logger } from '../utils/logger.js';
import { runChildWithTimeout } from './run-child.js';

/** How long the probe child gets. Window enumeration measures in single-digit ms. */
const PROBE_TIMEOUT_MS = 4000;

export interface DialogButton {
  index: number;
  id: number;
  caption: string;
  default: boolean;
}

export type DialogStatus =
  'dialog' | 'clear' | 'unknown' | 'unsupported' | 'stale' | 'cleared' | 'replaced' | 'unchanged';

/** How safe a dialog is to act on without asking. Derived from STRUCTURE only. */
export type DialogStakes = 'running' | 'data_loss' | 'informational' | 'decision';

export interface DialogReport {
  status: DialogStatus;
  reason?: string;
  /** Identity of THIS dialog. Must be handed back to click into it. */
  token?: string;
  title?: string;
  text?: string;
  buttons?: DialogButton[];
  otherControls?: number;
  hasProgress?: boolean;
  stakes?: DialogStakes;
  depth?: number;
  ownerPid?: number;
  probeMs?: number;
}

export interface DialogProbe {
  probe(pids: readonly number[]): Promise<DialogReport>;
  click(pids: readonly number[], token: string, buttonId: number): Promise<DialogReport>;
}

/** Test seam so the tool layer can be exercised without a Photoshop or a binary. */
const probeOps = {
  run: runChildWithTimeout,
  resolveBinary: resolveCoreBinaryPath,
};

function parseReport(stdout: string): DialogReport {
  const trimmed = stdout.trim();
  if (!trimmed) return { status: 'unknown', reason: 'probe-produced-no-output' };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null || !('status' in parsed)) {
      return { status: 'unknown', reason: 'probe-output-not-a-report' };
    }
    return parsed as DialogReport;
  } catch {
    return { status: 'unknown', reason: 'probe-output-not-json' };
  }
}

export class GoDialogProbe implements DialogProbe {
  private readonly logger = new Logger('DialogProbe');

  probe(pids: readonly number[]): Promise<DialogReport> {
    return this.invoke(['dialog', '--action', 'probe', '--pid', pids.join(',')]);
  }

  click(pids: readonly number[], token: string, buttonId: number): Promise<DialogReport> {
    return this.invoke([
      'dialog',
      '--action',
      'click',
      '--pid',
      pids.join(','),
      '--token',
      token,
      '--button-id',
      String(buttonId),
    ]);
  }

  private async invoke(args: string[]): Promise<DialogReport> {
    if (args.includes('--pid') && args[args.indexOf('--pid') + 1] === '') {
      return { status: 'unknown', reason: 'no-photoshop-pid' };
    }
    try {
      const { stdout, exitCode } = await probeOps.run(probeOps.resolveBinary(), args, {
        timeout: PROBE_TIMEOUT_MS,
        diagLabel: 'editmamei-core dialog',
      });
      if (exitCode !== 0) {
        // The binary reserves non-zero for "the probe itself is broken"; a
        // busy Photoshop is still an exit-0 answer.
        return { status: 'unknown', reason: `probe-exit-${exitCode}` };
      }
      return parseReport(stdout);
    } catch (error) {
      // Missing binary, spawn failure, or the probe's own timeout. All are
      // "could not tell", never "clear".
      this.logger.debug('Dialog probe failed', error);
      return { status: 'unknown', reason: 'probe-unavailable' };
    }
  }
}

/**
 * Find the running Photoshop process IDs.
 *
 * Resolved fresh on every probe, never cached. A PID cached across a Photoshop
 * restart enumerates zero windows, and code that reads "zero windows" as "no
 * dialog" reports a confident `clear` about a Photoshop that is not even the
 * one running. (Observed during the spike: Photoshop restarted mid-session and
 * the stale PID silently returned an empty window list.)
 *
 * Returns every match because more than one Photoshop.exe can exist; the probe
 * checks them all.
 */
export async function resolvePhotoshopPids(): Promise<number[]> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await probeOps.run(
        'tasklist',
        ['/FI', 'IMAGENAME eq Photoshop.exe', '/FO', 'CSV', '/NH'],
        { timeout: 4000, diagLabel: 'tasklist Photoshop.exe' }
      );
      return [...stdout.matchAll(/^"[^"]*","(\d+)"/gm)].map((m) => Number(m[1]));
    }
    const { stdout } = await probeOps.run('pgrep', ['-x', 'Adobe Photoshop'], {
      timeout: 4000,
      diagLabel: 'pgrep Adobe Photoshop',
    });
    return stdout
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

/**
 * Human-readable one-liner for a report, used in tool output and logs.
 * Kept here so the tool layer and any future watcher phrase it identically.
 */
export function describeReport(r: DialogReport): string {
  switch (r.status) {
    case 'clear':
      return 'No dialog is open in Photoshop.';
    case 'unsupported':
      return `Dialog detection is not available on this platform${r.reason ? ` (${r.reason})` : ''}.`;
    case 'unknown':
      return `Could not determine whether a dialog is open${r.reason ? ` (${r.reason})` : ''}. This is NOT the same as "no dialog".`;
    case 'cleared':
      return 'The dialog was dismissed and Photoshop is no longer blocked.';
    case 'unchanged':
      return 'The button was clicked but the dialog is still open.';
    case 'replaced':
      return `The click closed that dialog and Photoshop opened another one: ${r.title ?? '(untitled)'}. Stopping here — inspect it before acting again.`;
    case 'stale':
      return `That dialog is no longer the one on screen (${r.reason ?? 'changed'}). Inspect again before clicking.`;
    default: {
      const buttons = (r.buttons ?? []).map((b) => b.caption).join(' / ') || 'none readable';
      return `Photoshop is blocked by a dialog: "${r.title ?? '(untitled)'}" — ${r.text ?? '(no message)'} [buttons: ${buttons}]`;
    }
  }
}

/** @internal test-only */
export function __setProbeOpsForTests(overrides: Partial<typeof probeOps>): void {
  Object.assign(probeOps, overrides);
}

/** @internal test-only */
export function __resetProbeOpsForTests(): void {
  probeOps.run = runChildWithTimeout;
  probeOps.resolveBinary = resolveCoreBinaryPath;
}
