/**
 * Tiny shell helpers used by adapters that detect / invoke external
 * binaries. Kept in its own module so test seams can stub them via
 * vi.mock without dragging in unrelated client logic.
 *
 * Both helpers wrap node:child_process spawn calls with conservative
 * defaults (no shell, 5s timeout) — install/uninstall/status are
 * synchronous-feeling commands and shouldn't hang on a misbehaving
 * client binary.
 */

import { spawn } from 'node:child_process';

/**
 * Returns true if `cmd` resolves to a binary on the current PATH.
 *
 * Uses `where` on Windows and `command -v` on POSIX (the latter is a
 * shell builtin available everywhere bash/zsh/sh are). Both fail with
 * a non-zero exit when the binary is missing.
 */
export async function isOnPath(cmd: string): Promise<boolean> {
  const probe =
    process.platform === 'win32'
      ? spawn('where', [cmd], { stdio: 'ignore', windowsHide: true })
      : spawn('command', ['-v', cmd], { stdio: 'ignore', shell: '/bin/sh' });

  return new Promise<boolean>((resolve) => {
    const finish = (ok: boolean) => {
      try {
        probe.kill();
      } catch {
        // process already exited; nothing to clean up
      }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), 5000);
    probe.on('exit', (code) => {
      clearTimeout(timer);
      finish(code === 0);
    });
    probe.on('error', () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when the spawn itself failed (ENOENT, EACCES, etc.). */
  spawnFailed: boolean;
  /** True when the helper killed the child after the 10s timeout. */
  timedOut: boolean;
}

/**
 * Spawn a command, capture stdout/stderr, return the exit code. No shell
 * interpolation — args are passed as an array. 10s timeout; on timeout
 * the child is killed and we return exitCode = -1 with whatever output
 * we captured so far.
 *
 * The result also carries `spawnFailed` / `timedOut` discriminators so
 * callers can distinguish "binary missing" from "binary hung" — both
 * were previously reported as `exitCode = -1` and the install adapter
 * surfaced the same generic failure for both.
 */
export async function runCapture(cmd: string, args: string[]): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let spawnFailed = false;
    let timedOut = false;
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }, 10000);
    child.on('error', (err) => {
      clearTimeout(timer);
      spawnFailed = true;
      resolve({
        exitCode: -1,
        stdout,
        stderr: stderr + String(err),
        spawnFailed,
        timedOut,
      });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? -1,
        stdout,
        stderr,
        spawnFailed,
        timedOut,
      });
    });
  });
}
