import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { Logger } from '../utils/logger.js';
import { TempDir } from '../utils/temp.js';
import { DEFAULT_SCRIPT_TIMEOUT_MS } from '../utils/operation-timeouts.js';
import { ScriptQueue } from './script-queue.js';
import type { PlatformAdapter } from './ports.js';
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

/** Hard cap on the tasklist check itself, so a wedged process table can't hang isRunning(). */
const IS_RUNNING_EXEC_TIMEOUT_MS = 3_000;

/**
 * Drives Photoshop on Windows through COM.
 *
 * There is no direct COM binding in this process. Each call writes the script
 * to a private temp directory alongside a small VBScript shim, then runs the
 * shim under `cscript`; the shim is what actually holds the COM handle and
 * calls `DoJavaScript`. Going through a child process is what makes a wedged
 * Photoshop survivable — a hung COM call is a child we can kill, rather than a
 * blocked call inside our own event loop.
 */
export class WindowsScriptRunner implements PlatformAdapter {
  private readonly logger = new Logger('WindowsScriptRunner');
  private readonly queue = new ScriptQueue(this.logger);

  async run(script: string, timeoutMs: number = DEFAULT_SCRIPT_TIMEOUT_MS): Promise<unknown> {
    // Serialized through the shared queue so Photoshop never receives two
    // interleaved DoJavaScript calls. Load-bearing: concurrent scripts corrupt
    // each other's document state.
    return this.queue.enqueue(() => this.runOnce(script, timeoutMs), timeoutMs);
  }

  /**
   * Write the script and its shim into a private directory, run it, then remove
   * the directory.
   *
   * The temp directory carries an unguessable suffix, so the script path can be
   * composed into the shim without worrying about another process substituting
   * a file underneath us between write and execute.
   */
  private async runOnce(script: string, timeoutMs: number): Promise<unknown> {
    const dir = await TempDir.create('editmamei-win-');
    try {
      const scriptPath = await dir.write('script.jsx', script);
      const shimPath = await dir.write('run.vbs', this.buildComShim(scriptPath));

      // Deliberately not execAsync: a Photoshop modal dialog blocks the COM
      // call indefinitely, and only a killable child gets us out of it. The
      // helper also lifts the output cap that truncated large script results.
      const { stdout, stderr } = await runChildWithTimeout('cscript', ['//nologo', shimPath], {
        timeout: timeoutMs,
        diagLabel: 'cscript run.vbs',
      });
      if (stderr) {
        this.logger.warn('Script execution reported a warning', stderr);
      }
      return decodeScriptResult(stdout);
    } finally {
      // The helper waits for the child to exit before resolving, so the shim's
      // file handle is released and removal cannot fail with EBUSY.
      await dir.cleanup();
    }
  }

  /**
   * Compose the VBScript shim that holds the COM handle.
   *
   * VBScript has no exception handling, so failures are checked through
   * `Err.Number` after each step and reported on stdout using the same failure
   * marker the wrapper uses, which `decodeScriptResult` then turns back into a
   * thrown error.
   */
  private buildComShim(scriptPath: string): string {
    // The path is composed into a double-quoted VBScript literal, where an
    // apostrophe is an ordinary character — Windows account names legitimately
    // contain one (`D'Angelo` puts it in %TEMP%), so rejecting it would break
    // those users outright. A double quote is the only character that would
    // terminate the literal early, and mkdtemp never produces one.
    if (scriptPath.includes('"')) {
      throw new Error('Refusing to compose the COM shim: script path contains a double quote');
    }

    // Backslash doubling is load-bearing, not defensive. The path is handed to
    // DoJavaScript as ExtendScript *source*, where a lone backslash inside a
    // string literal opens an escape sequence — `C:\Users\...` would arrive
    // mangled. Doubling here means ExtendScript resolves it back to the
    // original path.
    return `
On Error Resume Next
Dim ps
Set ps = CreateObject("Photoshop.Application")

If Err.Number <> 0 Then
    WScript.Echo "ERROR: could not attach to Photoshop over COM - " & Err.Description
    WScript.Quit 1
End If

Dim scriptResult
scriptResult = ps.DoJavaScript("$.evalFile(""" & Replace("${scriptPath}", "\\", "\\\\") & """);")

If Err.Number <> 0 Then
    WScript.Echo "ERROR: " & Err.Description
    WScript.Quit 1
Else
    WScript.Echo scriptResult
End If
`.trim();
  }

  async isRunning(): Promise<boolean> {
    try {
      const { stdout } = await execAsync('tasklist /FI "IMAGENAME eq Photoshop.exe"', {
        timeout: IS_RUNNING_EXEC_TIMEOUT_MS,
      });
      return stdout.toLowerCase().includes('photoshop.exe');
    } catch {
      // tasklist is missing, refused to run, or exceeded its own timeout;
      // treat as "cannot confirm".
      return false;
    }
  }

  async launch(executablePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.logger.info('Launching Photoshop', executablePath);
      const child = spawn(executablePath, [], { detached: true, stdio: 'ignore' });
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
      // long before COM is ready to accept a DoJavaScript call, so
      // isRunning() would report "up" while every real script still fails
      // to attach. A rejecting attempt means "not ready yet", not failure.
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
