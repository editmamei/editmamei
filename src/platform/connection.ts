import { Logger } from '../utils/logger.js';
import { resolveHostPlatform, type HostPlatform } from './host-platform.js';
import type { PhotoshopInfo } from './ports.js';

// Re-exported so the many modules that already reach for the install record
// through this one keep working; the type itself is declared alongside the
// ports it travels over.
export type { PhotoshopInfo } from './ports.js';

/**
 * Shorten a string for a log line, marking how much was dropped so a reader can
 * tell a truncated script from a short one.
 *
 * @internal exported for unit tests only — not a stable public API.
 */
export function truncateForLog(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}…[+${s.length - maxLen} chars]`;
}

/**
 * How long a confirmed-running Photoshop is trusted before we probe again.
 *
 * The probe spawns a process every time it runs — pure fixed overhead, paid on
 * every script, and multiplied fifteen to twenty-five times over inside an
 * orchestration tool that chains many of them. The trade is that a Photoshop
 * which quits inside the window goes unnoticed until the next script fails
 * against it; that failure clears the latch, so the call after it probes and
 * relaunches as normal.
 */
export const RUNNING_LATCH_TTL_MS = 30_000;

export interface PhotoshopConnectionOptions {
  /** Injected clock (tests). Defaults to Date.now. */
  now?: () => number;
  /**
   * Injected host (tests). Defaults to resolving the real one — which
   * succeeds on every OS, handing back inert ports where Photoshop cannot
   * exist. Supplying a host lets a test exercise platform-specific behaviour
   * anywhere.
   */
  host?: HostPlatform;
}

/**
 * The server's single handle on the local Photoshop.
 *
 * Owns three things the tool layer should not have to think about: which
 * install we are talking to, whether it is running, and serializing scripts
 * onto it. Everything platform-specific lives behind the adapter resolved at
 * construction.
 */
export class PhotoshopConnection {
  private readonly logger: Logger;
  private readonly host: HostPlatform;
  private readonly now: () => number;

  private photoshopInfo: PhotoshopInfo | null = null;

  /**
   * The in-flight detect(), shared by every concurrent caller.
   *
   * Boot starts a Photoshop probe without awaiting it, so that the MCP
   * handshake is never held up behind a Photoshop round trip. That leaves a
   * window in which the boot probe is still detecting when the first tool call
   * arrives. Both callers used to see a null install, start competing
   * detections, and the loser could resolve null — leaving the connection
   * convinced no Photoshop had been found while one had. Sharing one promise
   * makes the second caller await the first result instead of racing it.
   */
  private detectInFlight: Promise<PhotoshopInfo | null> | null = null;

  /** Epoch ms until which a running Photoshop is trusted without probing; 0 = stale. */
  private runningLatchUntil = 0;

  /** Set once a script has ever completed against Photoshop. See `hasReachedPhotoshop`. */
  private everReachedPhotoshop = false;

  constructor(opts: PhotoshopConnectionOptions = {}) {
    this.logger = new Logger('PhotoshopConnection');
    this.now = opts.now ?? Date.now;
    // Resolution succeeds anywhere; on a platform Photoshop does not exist
    // for, the ports it hands back refuse every call with the reason.
    this.host = opts.host ?? resolveHostPlatform();
  }

  /**
   * Prove Photoshop is reachable by running a trivial script and checking what
   * comes back. Detecting the install on disk is not enough — that succeeds
   * with Photoshop closed.
   */
  async ping(): Promise<boolean> {
    try {
      this.logger.debug('Pinging Photoshop');
      const result = await this.executeScript("'pong';");
      return typeof result === 'string' && result.trim() === 'pong';
    } catch (error) {
      this.logger.error('Ping failed', error);
      return false;
    }
  }

  /**
   * Resolve the install, sharing one in-flight detection across concurrent
   * callers. A failed detection is not cached, so a transient miss during boot
   * cannot leave the connection permanently convinced there is no Photoshop.
   */
  async ensureDetected(): Promise<PhotoshopInfo | null> {
    if (this.photoshopInfo) return this.photoshopInfo;

    if (!this.detectInFlight) {
      this.detectInFlight = this.host.detector
        .detect()
        .then((info) => {
          if (info) {
            // Hand the install to the adapter BEFORE caching it. The hook
            // validates what it is given and can reject — caching first would
            // leave a permanently half-configured connection that never
            // re-detects, so every later call would fail with the downstream
            // symptom instead of this cause.
            this.host.adapter.useInstall?.(info);
            this.photoshopInfo = info;
          }
          return info;
        })
        .finally(() => {
          // Cleared whatever the outcome, so a failure is retryable.
          this.detectInFlight = null;
        });
    }

    return this.detectInFlight;
  }

  async getVersion(): Promise<string> {
    try {
      await this.ensureDetected();
      return this.photoshopInfo?.version || 'Unknown';
    } catch (error) {
      this.logger.error('Failed to read the Photoshop version', error);
      throw error;
    }
  }

  async executeScript(script: string, timeout?: number): Promise<unknown> {
    try {
      await this.ensureDetected();
      if (!this.photoshopInfo) {
        throw new Error(
          'Photoshop info not available — the local install could not be detected. ' +
            'Check that Photoshop is installed (set PHOTOSHOP_PATH to override detection).'
        );
      }

      await this.ensureRunning(this.photoshopInfo);

      // Guarded rather than left to the logger's own level check: the argument
      // is built before the call, so the gate inside the logger cannot prevent
      // the work. At the default level this ran on every single script for no
      // observable benefit.
      if (this.logger.isDebugEnabled()) {
        this.logger.debug(
          `Executing script (${script.length} chars, PS ${this.photoshopInfo.version}, ${this.host.os}): ${truncateForLog(script, 200)}`
        );
      }

      const result = await this.host.adapter.run(script, timeout);
      // A script that ran is itself proof Photoshop is up, so refresh the latch
      // and spare a busy session the probe between calls.
      this.runningLatchUntil = this.now() + RUNNING_LATCH_TTL_MS;
      // Distinct from `photoshopInfo`, which is pure disk/registry detection and
      // says nothing about whether Photoshop ever answered — see `hasReachedPhotoshop`.
      this.everReachedPhotoshop = true;
      return result;
    } catch (error) {
      // Clear the latch so the next call probes — and can relaunch — rather
      // than trusting a Photoshop that just failed to run something.
      this.runningLatchUntil = 0;
      this.logFailure(script, error);
      throw error;
    }
  }

  /**
   * Make sure Photoshop is up, launching it if not.
   *
   * Skipped entirely while the freshness latch is live. A negative probe is
   * never latched — it falls straight through to the launch.
   */
  private async ensureRunning(info: PhotoshopInfo): Promise<void> {
    if (this.now() < this.runningLatchUntil) return;

    if (await this.host.adapter.isRunning()) {
      this.runningLatchUntil = this.now() + RUNNING_LATCH_TTL_MS;
      return;
    }

    this.logger.info('Photoshop is not running; launching it');
    await this.host.adapter.launch(info.path);
  }

  /**
   * Record a failed script with the surrounding detail that makes it
   * diagnosable: which Photoshop, which platform, how long the script was, and
   * enough of its head to recognize.
   */
  private logFailure(script: string, error: unknown): void {
    const psVersion = this.photoshopInfo?.version ?? 'unknown';
    this.logger.error(
      `Script execution failed (PS ${psVersion}, ${this.host.os}, ${script.length} chars)`,
      error,
      `\n--- script head (200 chars) ---\n${truncateForLog(script, 200)}`
    );

    // Opt-in: dump the whole failing script so it can be replayed by hand. Off
    // by default so template content does not end up in captured logs.
    if (process.env.LOG_SCRIPT_ON_ERROR === '1') {
      this.logger.error(`--- full failing script ---\n${script}\n--- end script ---`);
    }
  }

  getPhotoshopInfo(): PhotoshopInfo | null {
    return this.photoshopInfo;
  }

  /**
   * Whether a script has EVER completed against Photoshop on this connection —
   * i.e. genuine proof of a live round trip, not just that an install was found on
   * disk (`getPhotoshopInfo()` populates from pure detection and stays populated
   * even when Photoshop never answers). Callers that want to piggyback more work
   * onto "Photoshop is reachable" — without risking `ensureRunning()`'s auto-launch
   * as a side effect of a call that was never going to touch Photoshop — must gate
   * on this, not on `getPhotoshopInfo() !== null`.
   *
   * STICKY, not live: once true it stays true for the rest of the process, even
   * after Photoshop quits. It answers "was Photoshop EVER reached on this
   * connection", not "is it running right now" — see `isCurrentlyRunning` for that.
   */
  hasReachedPhotoshop(): boolean {
    return this.everReachedPhotoshop;
  }

  /**
   * Whether Photoshop is running RIGHT NOW, checked directly via the platform
   * adapter's process check — unlike `executeScript`/`ping`, this never launches
   * it (skips `ensureRunning` entirely). For callers that must never be the thing
   * that starts Photoshop even when `hasReachedPhotoshop()` is stale-true (it was
   * reached earlier in the session and has since quit) — the background
   * ps_version probe in EditmameiServer is the motivating case. Cheap: a single
   * process-existence check (`tasklist` / `pgrep`), not a script round trip.
   */
  async isCurrentlyRunning(): Promise<boolean> {
    if (!this.photoshopInfo) return false;
    try {
      return await this.host.adapter.isRunning();
    } catch {
      return false;
    }
  }
}
