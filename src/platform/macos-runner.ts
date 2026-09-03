import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { Logger } from '../utils/logger.js';
import { TempDir } from '../utils/temp.js';
import { DEFAULT_SCRIPT_TIMEOUT_MS } from '../utils/operation-timeouts.js';
import { ScriptQueue } from './script-queue.js';
import type { PhotoshopInfo, PlatformAdapter } from './ports.js';
import { runChildWithTimeout } from './run-child.js';
import { decodeScriptResult } from './script-result.js';
import { waitForLaunchReady } from './launch-readiness.js';

const execAsync = promisify(exec);

/**
 * Per-attempt cap for the launch readiness probe — a real script round trip
 * (see `launch()`), short enough that a few failed attempts still fit inside
 * `LAUNCH_READY_MAX_WAIT_MS`.
 */
const LAUNCH_PROBE_TIMEOUT_MS = 2_000;

/** Hard cap on the pgrep check itself, so a wedged process table can't hang isRunning(). */
const IS_RUNNING_EXEC_TIMEOUT_MS = 3_000;

/**
 * Characters that cannot appear in an application name we compose into an
 * AppleScript string literal. Quote and backslash would terminate or escape the
 * literal; carriage return, newline and tab are all treated as statement
 * separators in one AppleScript context or another.
 */
const UNSAFE_IN_APPLESCRIPT_LITERAL = /["\\\r\n\t]/;

/**
 * Drives Photoshop on macOS through AppleScript.
 *
 * Each call writes the script and a small AppleScript wrapper into a private
 * temp directory and runs `osascript` against the wrapper; the wrapper is what
 * addresses Photoshop and calls `do javascript`. As on Windows, going through a
 * child process is what makes a wedged Photoshop recoverable.
 *
 * Unlike Windows, this adapter has to know *which* application to address —
 * AppleScript targets an app by display name, and several Photoshop releases
 * can be installed side by side. That name arrives via `useInstall`.
 */
export class MacOSScriptRunner implements PlatformAdapter {
  private readonly logger = new Logger('MacOSScriptRunner');
  private readonly queue = new ScriptQueue(this.logger);

  /**
   * Display name of the bundle to address, supplied by the detector.
   *
   * Deliberately null until `useInstall` provides one. A hardcoded fallback is
   * how this acquired a stale default in the first place — it kept naming a
   * release the product no longer targets, and AppleScript answered with an
   * opaque "application isn't running" rather than anything a user could act
   * on. Failing loudly beats addressing the wrong application.
   */
  private appName: string | null = null;

  useInstall(install: PhotoshopInfo): void {
    const name = install.appName;
    if (!name) {
      // Every script from here on will refuse to compose, so say why now
      // rather than leaving only the downstream symptom.
      this.logger.warn(
        'This Photoshop install carries no application name, so AppleScript has nothing to address',
        install.path
      );
      return;
    }

    if (UNSAFE_IN_APPLESCRIPT_LITERAL.test(name)) {
      throw new Error(
        `Photoshop's application name (${JSON.stringify(name)}) contains a character that ` +
          'cannot be composed into AppleScript.'
      );
    }

    this.appName = name;
    this.logger.debug('Addressing Photoshop as', name);
  }

  async run(script: string, timeoutMs: number = DEFAULT_SCRIPT_TIMEOUT_MS): Promise<unknown> {
    // Serialized through the shared queue so Photoshop never receives two
    // interleaved osascript calls. See script-queue.ts for why the queue's
    // own deadline is deliberately slacker than this one.
    return this.queue.enqueue(() => this.runOnce(script, timeoutMs), timeoutMs);
  }

  private async runOnce(script: string, timeoutMs: number): Promise<unknown> {
    const dir = await TempDir.create('editmamei-mac-');
    try {
      const scriptPath = await dir.write('script.jsx', script);
      const wrapperPath = await dir.write(
        'run.scpt',
        this.buildAppleScriptWrapper(scriptPath, timeoutMs)
      );

      const { stdout, stderr, exitCode } = await runChildWithTimeout('osascript', [wrapperPath], {
        timeout: timeoutMs,
        diagLabel: 'osascript run.scpt',
      });
      if (stderr) {
        this.logger.warn('Script execution reported a warning', stderr);
      }

      // A failure in AppleScript itself never reaches the wrapper's own failure
      // marker, because Photoshop never returns control for the marker to be
      // written — the Apple Event manager's timeout (-1712) is the common case.
      // osascript reports that on stderr with a non-zero exit instead, so
      // without this check the call resolved quietly with empty stdout. Windows
      // has no equivalent gap: its shim always writes a marker line before
      // exiting.
      if (exitCode !== 0) {
        throw new Error(
          `osascript exited with code ${exitCode}: ${stderr.trim() || '(no output on stderr)'}`
        );
      }

      return decodeScriptResult(stdout);
    } finally {
      await dir.cleanup();
    }
  }

  private buildAppleScriptWrapper(
    scriptPath: string,
    timeoutMs: number = DEFAULT_SCRIPT_TIMEOUT_MS
  ): string {
    if (!this.appName) {
      throw new Error(
        'No Photoshop application name has been set for this runner — the install was never ' +
          'handed to useInstall(), so there is no application for AppleScript to address.'
      );
    }

    const posixPath = scriptPath.replace(/\\/g, '/');

    // A quote or a newline in the path would break out of the literals the
    // path is composed into, so they are refused outright rather than escaped.
    // The path comes from mkdtemp plus a fixed filename, so this holds by
    // construction today; the guard is here so that a future change to how the
    // path is produced fails loudly instead of emitting a broken — or
    // attacker-shaped — script. An apostrophe is handled below by encoding
    // rather than refusal, because real account names contain them.
    if (posixPath.includes('"') || posixPath.includes('\n')) {
      throw new Error('Refusing to compose the wrapper: script path would break the AppleScript');
    }

    // Apple Events carry their own timeout, defaulting to about two minutes and
    // entirely independent of the budget the caller passed us. Without an
    // explicit clause, any budget at or above that default is silently
    // ineffective: AppleScript gives up first and reports its own generic
    // timeout rather than ours. Deriving the clause from the caller's budget
    // keeps our deadline the one that fires.
    //
    // Guarded because a non-finite or negative budget would emit
    // `with timeout of NaN seconds`, which fails to *compile* and would break
    // every macOS call rather than just this one.
    const timeoutSeconds =
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.max(1, Math.ceil(timeoutMs / 1000)) : 1;

    // The path lands inside a single-quoted JavaScript string, which itself
    // sits inside the double-quoted AppleScript literal. encodeURI() handles
    // the double quote and newline but deliberately leaves the apostrophe
    // alone — and an apostrophe would close that inner literal early, which is
    // a genuine break-out and not merely a broken path. Percent-encoding it
    // ourselves keeps the value quote-free; decodeURI() reassembles the real
    // path inside Photoshop. Users with an apostrophe in their account name
    // depend on this.
    const encodedPath = encodeURI(posixPath).replace(/'/g, '%27');

    // No `activate` clause: issuing one before every call pulled Photoshop to
    // the foreground on every tool call. `do javascript` runs perfectly well
    // against a backgrounded Photoshop. Should a future release regress that,
    // the fix is a single activate on first use, not one per call.
    return `with timeout of ${timeoutSeconds} seconds
\ttell application "${this.appName}"
\t\tdo javascript "$.evalFile(decodeURI('${encodedPath}'))"
\tend tell
end timeout`;
  }

  async isRunning(): Promise<boolean> {
    try {
      const { stdout } = await execAsync('pgrep -f "Adobe Photoshop"', {
        timeout: IS_RUNNING_EXEC_TIMEOUT_MS,
      });
      return stdout.trim().length > 0;
    } catch {
      // pgrep exits non-zero when nothing matches, or the check itself
      // exceeded its own timeout; both read as "cannot confirm".
      return false;
    }
  }

  async launch(executablePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.logger.info('Launching Photoshop', executablePath);
      const child = spawn('open', ['-a', executablePath], { detached: true, stdio: 'ignore' });
      child.unref();

      // Guards against the readiness poll resolving after a spawn error
      // already rejected this promise.
      let aborted = false;
      child.on('error', (error) => {
        aborted = true;
        reject(new Error(`Could not launch Photoshop at ${executablePath}: ${error.message}`));
      });

      // The probe is a real script round trip, not a process-existence
      // check: Photoshop's process exists within milliseconds of spawning,
      // long before AppleEvents are ready to accept a `do javascript` call,
      // so isRunning() would report "up" while every real script still
      // fails to attach. A rejecting attempt means "not ready yet", not
      // failure.
      const probe = (): Promise<boolean> =>
        this.run("'pong';", LAUNCH_PROBE_TIMEOUT_MS)
          .then(() => true)
          .catch(() => false);

      waitForLaunchReady(probe, { isAborted: () => aborted })
        .catch(() => false) // a probe chain that somehow rejects must not leave this promise unsettled
        .then(() => {
          if (!aborted) resolve();
        });
    });
  }
}
