/**
 * Spawn a child process, buffer its stdout/stderr, and enforce a hard
 * timeout that actually kills the child — not just rejects the caller-
 * facing promise.
 *
 * The previous `execAsync(...)` model in both runners had two latent
 * failure modes BLOCK-3 surfaced:
 *
 *   1. Per-task `setTimeout(reject, N)` only rejects the promise. The
 *      `cscript` / `osascript` child keeps running, holding the COM /
 *      AppleScript transport open against Photoshop. If PS popped a
 *      modal (license expiry, missing font, GPU init, "discard mask?"),
 *      the entire script queue starved behind a dead child until the
 *      user dismissed the dialog — including health-check pings.
 *
 *   2. `execAsync`'s default `maxBuffer` is 1 MB. A large
 *      `ps_execute_script` return (deep layer trees, big JSON
 *      payloads) would blow that and reject with an unactionable
 *      "stdout maxBuffer length exceeded."
 *
 * This helper fixes both:
 *
 *   - Spawn directly so we keep a `ChildProcess` reference. On timeout,
 *     SIGTERM with a grace window, then SIGKILL. The returned promise
 *     does not settle until the child has actually exited — callers can
 *     immediately clean up the per-invocation TempDir without hitting
 *     EBUSY on Windows.
 *
 *   - Buffer stdout / stderr ourselves, up to `maxOutputBytes` (default
 *     32 MB). Past that we kill the child and reject with an actionable
 *     error that names the cap and the script head so users can spot a
 *     runaway return.
 *
 * Test seam: `_spawn` is the production binding by default; tests can
 * call `__setSpawnForTests` to inject a stub `ChildProcess`. Pair every
 * test with `__resetForTests` (afterEach).
 */
import * as cp from 'node:child_process';

export interface RunChildResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** POSIX signal name if the child was killed (e.g. SIGTERM, SIGKILL). */
  signal: string | null;
}

export interface RunChildOptions {
  /** Hard timeout in ms. After this elapses we SIGTERM the child. */
  timeout: number;
  /**
   * Grace window between SIGTERM and SIGKILL. The child usually exits
   * within a few hundred ms of SIGTERM; if it doesn't, we escalate.
   */
  killGraceMs?: number;
  /**
   * Cap on stdout + stderr buffer. If the child produces more output
   * than this, we kill it and reject. Default 32 MB.
   */
  maxOutputBytes?: number;
  /**
   * For diagnostics on timeout / overflow — a short label the caller
   * can identify in logs. Usually the script's first line trimmed.
   */
  diagLabel?: string;
  /**
   * Optional data to write to the child's stdin, after which stdin is
   * closed (end). When set, the child is spawned with a piped stdin;
   * otherwise stdin is `'ignore'` (the historical behavior every existing
   * caller relies on). Used to pass params JSON to the editmamei-core
   * snippet binary without hitting the Windows command-line length cap.
   */
  input?: string;
  /**
   * Environment for the child. When set, it REPLACES the inherited env, so
   * callers that only want to ADD vars must spread `process.env` themselves.
   * Undefined → inherit the parent env (the historical behavior every other
   * caller relies on).
   */
  env?: Record<string, string | undefined>;
}

const childOps = {
  spawn: cp.spawn,
};

/**
 * Run a command to completion or timeout, whichever comes first.
 *
 * Resolves with stdout / stderr / exitCode when the child exits
 * naturally. Rejects with a descriptive Error when the child:
 *   - times out (after SIGKILL has been delivered AND the child has
 *     reported exit)
 *   - exceeds maxOutputBytes (after kill)
 *   - fails to spawn at all (e.g. missing binary, ENOENT)
 *   - exits non-zero (caller decides whether non-zero is an error,
 *     since cscript / osascript both legitimately return non-zero on
 *     a graceful Photoshop error envelope)
 *
 * NOTE on non-zero exit: this helper does NOT throw on non-zero exit.
 * It returns the result with exitCode set so the caller can apply its
 * own policy (the runners parse `ERROR:` from stdout
 * regardless of exit code, so they want the result either way).
 */
export async function runChildWithTimeout(
  command: string,
  args: readonly string[],
  options: RunChildOptions
): Promise<RunChildResult> {
  const {
    timeout,
    killGraceMs = 2000,
    maxOutputBytes = 32 * 1024 * 1024,
    diagLabel = command,
  } = options;

  return new Promise<RunChildResult>((resolve, reject) => {
    let child: cp.ChildProcess;
    try {
      // stdin is 'pipe' only when the caller supplies input; otherwise
      // 'ignore' (unchanged behavior for every existing caller).
      const stdinMode: 'pipe' | 'ignore' = options.input !== undefined ? 'pipe' : 'ignore';
      child = childOps.spawn(command, args, {
        stdio: [stdinMode, 'pipe', 'pipe'],
        // Only pass env when the caller set one; otherwise omit so the child
        // inherits the parent env exactly as before.
        ...(options.env !== undefined ? { env: options.env } : {}),
      });
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = '';
    let stderr = '';
    let totalBytes = 0;
    let timedOut = false;
    let overflowed = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let escalateTimer: ReturnType<typeof setTimeout> | null = null;

    const clearTimers = (): void => {
      if (killTimer !== null) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      if (escalateTimer !== null) {
        clearTimeout(escalateTimer);
        escalateTimer = null;
      }
    };

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      fn();
    };

    const killNow = (reason: 'timeout' | 'overflow'): void => {
      if (reason === 'timeout') timedOut = true;
      else overflowed = true;

      // SIGTERM first — gives cscript / osascript a chance to clean up
      // and report exit normally. If it ignores SIGTERM (some Windows
      // shells do), escalate to SIGKILL after the grace window.
      try {
        child.kill('SIGTERM');
      } catch {
        /* child may have already exited; harmless */
      }
      escalateTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* child may have already exited; harmless */
        }
      }, killGraceMs);
    };

    // Per-task hard timeout.
    killTimer = setTimeout(() => {
      if (!settled) killNow('timeout');
    }, timeout);

    const handleChunk = (chunk: Buffer | string, target: 'stdout' | 'stderr'): void => {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      totalBytes += Buffer.byteLength(s, 'utf8');
      if (target === 'stdout') stdout += s;
      else stderr += s;
      if (totalBytes > maxOutputBytes && !timedOut && !overflowed) {
        killNow('overflow');
      }
    };

    child.stdout?.on('data', (c) => handleChunk(c, 'stdout'));
    child.stderr?.on('data', (c) => handleChunk(c, 'stderr'));

    // Feed stdin when the caller provided input, then close it. Guard
    // child.stdin (a stubbed test child may not have one). Swallow stdin
    // 'error' (EPIPE) — a child that exits before draining stdin is a
    // normal race, surfaced via the exit/error paths, not here.
    if (options.input !== undefined && child.stdin) {
      child.stdin.on('error', () => {
        /* EPIPE on early child exit — handled elsewhere */
      });
      child.stdin.end(options.input);
    }

    child.on('error', (err) => {
      // Spawn failure (binary missing, EACCES, etc.). The child is
      // definitionally not running; settle immediately.
      settle(() => reject(err));
    });

    // We settle on the 'exit' event (which fires after stdout/stderr
    // close), so stdout/stderr buffers are complete when we resolve.
    child.on('exit', (code, signal) => {
      if (timedOut) {
        settle(() =>
          reject(
            new Error(
              `Script execution timeout after ${timeout}ms (${diagLabel}). The child process was killed, ` +
                `but Photoshop runs as a separate process and may have kept executing — the operation ` +
                `could still have completed. Check Photoshop's actual state before retrying. Common ` +
                `causes: a genuinely slow operation (e.g. a large RAW file's first Camera Raw engine ` +
                `init) exceeding the timeout, or a modal dialog open in Photoshop (license, missing ` +
                `font, GPU init, "Discard?" prompt) — dismiss it if present.`
            )
          )
        );
        return;
      }
      if (overflowed) {
        // Include the first 256 chars of stdout in the diagnostic so a user
        // staring at "32 MB exceeded" has a hint about what was about to be
        // returned (a deep history dump? a runaway loop?). Trim to a single
        // line so a multi-line dump doesn't blow up terminal output.
        const head = stdout.slice(0, 256).replace(/\s+/g, ' ').trim();
        settle(() =>
          reject(
            new Error(
              `Script output exceeded ${maxOutputBytes} bytes (${diagLabel}). Consider returning a smaller ` +
                `subset of the data or paginating the operation. ` +
                `[stdout head] ${head}${stdout.length > 256 ? '…' : ''}`
            )
          )
        );
        return;
      }
      settle(() => resolve({ stdout, stderr, exitCode: code, signal }));
    });
  });
}

// ============================================================================
// Test seam — production code never touches these.
// ============================================================================

/**
 * Test-only — override one or more childOps. Mirrors the
 * `__setFsOpsForTests` pattern in `src/utils/temp.ts` so both modules
 * share the same test-seam shape (`Partial<typeof ops>` setter + a
 * reset hook).
 * @internal
 */
export function __setChildOpsForTests(overrides: Partial<typeof childOps>): void {
  Object.assign(childOps, overrides);
}

/**
 * Test-only — restore production childOps. Pair with the setter via
 * `afterEach`.
 * @internal
 */
export function __resetForTests(): void {
  childOps.spawn = cp.spawn;
}
