/**
 * Poll a readiness probe after launching Photoshop, returning as soon as it
 * reports true — replacing a fixed post-launch sleep that was paid in full on
 * every cold start regardless of how quickly Photoshop actually came up.
 *
 * Bounded by real elapsed time against `maxWaitMs`, not by an iteration
 * count: the probe itself (a trivial script round trip — see the runners'
 * `launch()`) can take non-trivial time on its own, especially while COM /
 * AppleEvents aren't answering yet, so a count derived from `maxWaitMs /
 * intervalMs` would let slow, repeatedly-failing attempts blow well past the
 * intended cap. Tracking `now()` directly keeps the wall-clock budget honest
 * regardless of how long each attempt takes.
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
  /** Test seam: injectable clock. Defaults to Date.now. */
  now?: () => number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

/**
 * Probe `isReady` until it resolves true or `maxWaitMs` of real elapsed time
 * (per `now`) passes. Returns whether it ever reported ready.
 */
export async function waitForLaunchReady(
  isReady: () => Promise<boolean>,
  options: LaunchReadinessOptions = {}
): Promise<boolean> {
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxWaitMs = options.maxWaitMs ?? LAUNCH_READY_MAX_WAIT_MS;
  const sleep = options.sleep ?? defaultSleep;
  const isAborted = options.isAborted ?? (() => false);
  const now = options.now ?? Date.now;
  const deadline = now() + maxWaitMs;

  while (now() < deadline) {
    if (isAborted()) return false;
    if (await isReady()) return true;
    if (now() >= deadline) break;
    await sleep(intervalMs);
  }
  return false;
}
