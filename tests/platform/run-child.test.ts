import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import {
  runChildWithTimeout,
  __setChildOpsForTests,
  __resetForTests,
} from '@editmamei/platform/run-child.ts';

/**
 * Build a stub ChildProcess that gives the test driver control over when
 * stdout/stderr emit, when 'exit' fires, and what signal/code it reports.
 * This lets us assert kill-on-timeout, overflow-on-output, and the
 * await-exit-before-resolve contract without forking real processes.
 */
function makeStubChild(): {
  child: ChildProcess;
  emitStdout: (s: string) => void;
  emitStderr: (s: string) => void;
  emitExit: (code: number | null, signal: string | null) => void;
  emitError: (err: Error) => void;
  killSpy: ReturnType<typeof vi.fn>;
  killedSignals: string[];
  stdinEnd: ReturnType<typeof vi.fn>;
} {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdinEnd = vi.fn();
  const stdin = Object.assign(new EventEmitter(), { end: stdinEnd });
  const proc = new EventEmitter() as EventEmitter & {
    stdout: typeof stdout;
    stderr: typeof stderr;
    stdin: typeof stdin;
    kill: (signal?: string) => boolean;
  };
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.stdin = stdin;

  const killedSignals: string[] = [];
  const killSpy = vi.fn((signal?: string) => {
    killedSignals.push(signal ?? 'SIGTERM');
    return true;
  });
  proc.kill = killSpy;

  return {
    child: proc as unknown as ChildProcess,
    emitStdout: (s: string) => stdout.emit('data', Buffer.from(s, 'utf8')),
    emitStderr: (s: string) => stderr.emit('data', Buffer.from(s, 'utf8')),
    emitExit: (code, signal) => proc.emit('exit', code, signal),
    emitError: (err) => proc.emit('error', err),
    killSpy,
    killedSignals,
    stdinEnd,
  };
}

describe('runChildWithTimeout', () => {
  afterEach(() => {
    __resetForTests();
    vi.useRealTimers();
  });

  // ===========================================================================
  // Happy path — child exits cleanly under timeout, stdout/stderr buffered.
  // ===========================================================================
  it('resolves with buffered stdout/stderr when the child exits 0 before timeout', async () => {
    const stub = makeStubChild();
    __setChildOpsForTests({ spawn: (() => stub.child) as never });

    const promise = runChildWithTimeout('cmd', ['arg'], { timeout: 5000 });
    stub.emitStdout('{"ok":true}');
    stub.emitStderr('warning text');
    stub.emitExit(0, null);

    const result = await promise;
    expect(result.stdout).toBe('{"ok":true}');
    expect(result.stderr).toBe('warning text');
    expect(result.exitCode).toBe(0);
    expect(stub.killSpy).not.toHaveBeenCalled();
  });

  it('does NOT throw on non-zero exit — the caller decides what to do', async () => {
    const stub = makeStubChild();
    __setChildOpsForTests({ spawn: (() => stub.child) as never });

    const promise = runChildWithTimeout('cmd', [], { timeout: 5000 });
    stub.emitStdout('ERROR: PS modal pending');
    stub.emitExit(1, null);

    const result = await promise;
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('ERROR:');
  });

  // ===========================================================================
  // Timeout kills the child via SIGTERM, then SIGKILL after grace.
  //
  // Previous execAsync model: timeout rejected the caller-facing promise but
  // never killed the child. Photoshop modal dialog → cscript/osascript hung
  // forever → entire executor queue starved. runChildWithTimeout fixes this:
  // on timeout, we SIGTERM, then SIGKILL after killGraceMs, AND we wait for
  // the actual 'exit' event before rejecting so the caller can clean up
  // its temp dir without an EBUSY race.
  // ===========================================================================
  it('SIGTERMs the child on timeout and SIGKILLs after the grace window', async () => {
    vi.useFakeTimers();
    const stub = makeStubChild();
    __setChildOpsForTests({ spawn: (() => stub.child) as never });

    const promise = runChildWithTimeout('cmd', [], {
      timeout: 1000,
      killGraceMs: 500,
    });

    // Advance to the timeout — child gets SIGTERM.
    await vi.advanceTimersByTimeAsync(1000);
    expect(stub.killedSignals).toEqual(['SIGTERM']);

    // Advance through the grace window — escalation to SIGKILL.
    await vi.advanceTimersByTimeAsync(500);
    expect(stub.killedSignals).toEqual(['SIGTERM', 'SIGKILL']);

    // Child reports exit. Only NOW should the promise reject — proves we
    // awaited the actual exit instead of bailing on the timer.
    stub.emitExit(null, 'SIGKILL');
    await expect(promise).rejects.toThrow(/timeout after 1000ms/);
  });

  // The killed child is NOT proof the PS-side operation failed — Photoshop is
  // a separate process that keeps running the JSX it already received (see
  // the file-header note). The message must say so honestly instead
  // of asserting a modal dialog as the cause: modal *detection* doesn't exist
  // in this product, and a large-RAW/first-Camera-Raw-open is at least as
  // likely. See classifyError's 'timeout' vs 'ps_modal_blocking' test in
  // tests/unit/session-log.test.ts for the matching classifier decision.
  it('error message on timeout states the op may have completed and lists slow-op + modal as possible causes (not an assertion of modal)', async () => {
    vi.useFakeTimers();
    const stub = makeStubChild();
    __setChildOpsForTests({ spawn: (() => stub.child) as never });

    const promise = runChildWithTimeout('osascript', ['wrapper.scpt'], {
      timeout: 100,
      killGraceMs: 50,
      diagLabel: 'osascript wrapper.scpt',
    });
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(50);
    stub.emitExit(null, 'SIGKILL');

    await expect(promise).rejects.toThrow(/may have kept executing/);
    await expect(promise).rejects.toThrow(/could still have completed/);
    await expect(promise).rejects.toThrow(/Camera Raw engine init/);
    await expect(promise).rejects.toThrow(/modal dialog open in Photoshop/);
  });

  // ===========================================================================
  // T05 P1-3 — output overflow kills the child rather than truncating.
  // ===========================================================================
  it('kills the child and rejects when stdout exceeds maxOutputBytes', async () => {
    const stub = makeStubChild();
    __setChildOpsForTests({ spawn: (() => stub.child) as never });

    const promise = runChildWithTimeout('cmd', [], {
      timeout: 5000,
      maxOutputBytes: 10,
    });

    stub.emitStdout('this is more than ten bytes of output');
    expect(stub.killedSignals).toContain('SIGTERM');
    stub.emitExit(null, 'SIGTERM');

    await expect(promise).rejects.toThrow(/exceeded 10 bytes/);
  });

  // ===========================================================================
  // Spawn failure (binary not found) settles immediately, not on a timer.
  // ===========================================================================
  it('rejects immediately when the child emits an error event (spawn failure)', async () => {
    const stub = makeStubChild();
    __setChildOpsForTests({ spawn: (() => stub.child) as never });

    const promise = runChildWithTimeout('nonexistent', [], { timeout: 5000 });
    stub.emitError(Object.assign(new Error('ENOENT: spawn failed'), { code: 'ENOENT' }));

    await expect(promise).rejects.toThrow(/ENOENT: spawn failed/);
  });

  it('rejects when spawn() itself throws synchronously', async () => {
    __setChildOpsForTests({
      spawn: ((): never => {
        throw new Error('spawn synchronously failed');
      }) as never,
    });

    await expect(runChildWithTimeout('cmd', [], { timeout: 5000 })).rejects.toThrow(
      /spawn synchronously failed/
    );
  });

  // ===========================================================================
  // Cleanup contract: timers MUST be cleared after settle so the event
  // loop doesn't stay awake. Without this, a 30s timeout on a 100ms-exit
  // child would keep the process alive for 29.9 idle seconds.
  // ===========================================================================
  it('clears the kill timer on natural exit so the event loop is not held open', async () => {
    vi.useFakeTimers();
    const stub = makeStubChild();
    __setChildOpsForTests({ spawn: (() => stub.child) as never });

    const promise = runChildWithTimeout('cmd', [], { timeout: 30_000 });
    stub.emitExit(0, null);
    await promise;

    // Advance past what would have been the timeout. If the kill timer
    // was still pending it would fire here; SIGTERM would be called on
    // the already-exited stub child.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stub.killSpy).not.toHaveBeenCalled();
  });

  // ===========================================================================
  // QA coverage gaps — added 2026-05-31.
  // ===========================================================================

  it('handles a stub with no stderr stream (stdio=ignore future caller)', async () => {
    // child.stderr?.on uses optional chain; verify a missing stderr does
    // not crash the helper and the resolve path still fires on exit.
    const stub = makeStubChild();
    // Pretend stderr was never piped (stdio: 'ignore' in a future caller).
    (stub.child as unknown as { stderr: null }).stderr = null;
    __setChildOpsForTests({ spawn: (() => stub.child) as never });

    const promise = runChildWithTimeout('cmd', [], { timeout: 5000 });
    stub.emitStdout('{"ok":true}');
    stub.emitExit(0, null);

    const result = await promise;
    expect(result.stdout).toBe('{"ok":true}');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  // ===========================================================================
  // stdin feed — used by the editmamei-core SnippetClient to pass params JSON.
  // ===========================================================================
  it('writes provided input to child stdin and closes it', async () => {
    const stub = makeStubChild();
    __setChildOpsForTests({ spawn: (() => stub.child) as never });

    const promise = runChildWithTimeout('editmamei-core', ['build', 'x'], {
      timeout: 5000,
      input: '{"radius":2}',
    });
    stub.emitStdout('jsx-body');
    stub.emitExit(0, null);

    const result = await promise;
    expect(result.stdout).toBe('jsx-body');
    expect(stub.stdinEnd).toHaveBeenCalledWith('{"radius":2}');
  });

  it('does NOT touch stdin when no input is provided (existing-caller behavior)', async () => {
    const stub = makeStubChild();
    __setChildOpsForTests({ spawn: (() => stub.child) as never });

    const promise = runChildWithTimeout('cmd', ['arg'], { timeout: 5000 });
    stub.emitStdout('ok');
    stub.emitExit(0, null);

    await promise;
    expect(stub.stdinEnd).not.toHaveBeenCalled();
  });

  it('does NOT double-kill when more stdout arrives after the overflow kill fires', () => {
    // Real-world scenario: a runaway child emits a huge chunk that
    // exceeds maxOutputBytes, we SIGTERM, but the child still has a
    // pending buffer that flushes before it exits. The handler must
    // not re-enter killNow on each subsequent chunk.
    const stub = makeStubChild();
    __setChildOpsForTests({ spawn: (() => stub.child) as never });

    runChildWithTimeout('cmd', [], {
      timeout: 5000,
      maxOutputBytes: 10,
    }).catch(() => undefined);

    stub.emitStdout('first chunk over the cap of ten bytes — triggers kill');
    expect(stub.killedSignals).toEqual(['SIGTERM']);

    // Subsequent chunks must NOT trigger another kill.
    stub.emitStdout('trailing data after the kill');
    stub.emitStderr('stderr trailer too');
    expect(stub.killedSignals).toEqual(['SIGTERM']);
  });
});
