/**
 * Poll a readiness probe after launching Photoshop, returning as soon as it
 * reports true — replacing a fixed post-launch sleep that was paid in full on
 * every cold start regardless of how quickly Photoshop actually came up.
 *
 * Capped at `maxWaitMs`, never shorter than the fixed sleep this replaces: if
 * Photoshop hasn't answered by then, the caller proceeds anyway exactly as
 * before, and the first script that follows is what actually proves it's up.
 */

const DEFAULT_POLL_INTERVAL_MS = 250;

/** Matches the old fixed launch pause — the worst-case wait is unchanged. */
export const LAUNCH_READY_MAX_WAIT_MS = 5_000;

export interface LaunchReadinessOptions {
  intervalMs?: number;
  maxWaitMs?: number;
  /** Test seam: invoked instead of a real timer-backed delay. */
  sleep?: (ms: number) => Promise<void>;
  /** Checked before each probe; once true, the loop stops without polling further. */
  isAborted?: () => boolean;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

/**
 * Probe `isReady` at `intervalMs` until it resolves true or `maxWaitMs`
 * elapses. Returns whether it ever reported ready.
 */
export async function waitForLaunchReady(
  isReady: () => Promise<boolean>,
  options: LaunchReadinessOptions = {}
): Promise<boolean> {
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxWaitMs = options.maxWaitMs ?? LAUNCH_READY_MAX_WAIT_MS;
  const sleep = options.sleep ?? defaultSleep;
  const isAborted = options.isAborted ?? (() => false);
  const attempts = Math.max(1, Math.ceil(maxWaitMs / intervalMs));

  for (let i = 0; i < attempts; i++) {
    if (isAborted()) return false;
    if (await isReady()) return true;
    if (i < attempts - 1) await sleep(intervalMs);
  }
  return false;
}
