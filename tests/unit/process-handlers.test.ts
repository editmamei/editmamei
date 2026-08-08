import { describe, it, expect, vi, afterEach } from 'vitest';
import { __installProcessHandlersForTests } from '@editmamei/index.ts';

/**
 * The MCP server is a long-lived
 * stdio subprocess of the AI client. Any stray unhandled rejection or
 * uncaught exception killed the process abruptly with no diagnostic.
 *
 * `src/index.ts` installs two process-level handlers at startup:
 *   - `unhandledRejection` logs and KEEPS ALIVE
 *   - `uncaughtException` logs and EXITS 1 (process state is undefined)
 *
 * These tests verify both handlers are installed and behave as specced.
 * We swap process.exit for a no-op and capture stderr to assert the
 * diagnostic was emitted; we do NOT actually crash the test runner.
 */

describe('process-level safety nets', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  const installed: Array<{ event: string; listener: (...args: unknown[]) => void }> = [];

  afterEach(() => {
    // Remove every listener we installed so subsequent tests don't fire
    // them — vitest reports an unhandled rejection if our handler stays
    // attached and another test triggers one.
    for (const { event, listener } of installed) {
      process.off(event, listener as (...args: unknown[]) => void);
    }
    installed.length = 0;
    stderrSpy.mockRestore();
    if (exitSpy) exitSpy.mockRestore();
  });

  function install(): void {
    // Track every listener installed so afterEach can detach them.
    const eventsBefore = {
      unhandledRejection: process.listeners('unhandledRejection').length,
      uncaughtException: process.listeners('uncaughtException').length,
    };
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    __installProcessHandlersForTests();
    const afterRej = process.listeners('unhandledRejection');
    const afterExc = process.listeners('uncaughtException');
    if (afterRej.length > eventsBefore.unhandledRejection) {
      installed.push({
        event: 'unhandledRejection',
        listener: afterRej[afterRej.length - 1] as (...args: unknown[]) => void,
      });
    }
    if (afterExc.length > eventsBefore.uncaughtException) {
      installed.push({
        event: 'uncaughtException',
        listener: afterExc[afterExc.length - 1] as (...args: unknown[]) => void,
      });
    }
  }

  it('installs an unhandledRejection handler that logs to stderr without exiting', () => {
    const exitBefore = vi.fn();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(exitBefore as never);

    install();

    const installedListener = installed.find((l) => l.event === 'unhandledRejection')!;
    expect(installedListener).toBeDefined();
    installedListener.listener(new Error('test rejection'), Promise.resolve());

    expect(exitBefore).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalled();
    const written = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(written).toMatch(/unhandled promise rejection/i);
    expect(written).toMatch(/kept alive/i);
  });

  it('installs an uncaughtException handler that logs and queues exit(1)', () => {
    const fakeExit = vi.fn();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(fakeExit as never);
    // Stub setImmediate so the deferred process.exit never actually runs.
    // Otherwise the immediate fires AFTER our afterEach removes the
    // listener, re-enters real process.exit (which vitest stubs to throw
    // "unexpectedly called"), cascades through uncaughtException, and
    // hangs the worker. We just want to verify the policy here.
    const immediateSpy = vi.spyOn(globalThis, 'setImmediate').mockImplementation((() => ({
      hasRef: () => true,
      ref: () => undefined,
      unref: () => undefined,
    })) as never);

    install();

    const installedListener = installed.find((l) => l.event === 'uncaughtException')!;
    expect(installedListener).toBeDefined();

    installedListener.listener(new Error('boom'), 'uncaughtException');

    expect(process.exitCode).toBe(1);
    // Reset exitCode so the test runner doesn't inherit it.
    process.exitCode = 0;

    expect(stderrSpy).toHaveBeenCalled();
    const written = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(written).toMatch(/uncaught exception/i);
    expect(written).toMatch(/exiting with code 1/i);

    immediateSpy.mockRestore();
  });

  it('calling install twice in the same process registers two handlers (no idempotency guard)', () => {
    // The function does NOT dedupe — calling twice doubles up. This is
    // contract-pinning, not a recommendation: in production only main()
    // calls install once. If a future refactor adds an idempotency
    // guard, this test should be updated (and the guard reasoned about
    // in the install function's docstring).
    const fakeExit = vi.fn();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(fakeExit as never);

    const rejBefore = process.listeners('unhandledRejection').length;
    install();
    const rejAfterFirst = process.listeners('unhandledRejection').length;
    install();
    const rejAfterSecond = process.listeners('unhandledRejection').length;

    expect(rejAfterFirst - rejBefore).toBe(1);
    expect(rejAfterSecond - rejAfterFirst).toBe(1);

    // Track both new listeners for afterEach cleanup.
    const allRej = process.listeners('unhandledRejection');
    const allExc = process.listeners('uncaughtException');
    installed.length = 0;
    installed.push(
      {
        event: 'unhandledRejection',
        listener: allRej[allRej.length - 2] as (...args: unknown[]) => void,
      },
      {
        event: 'unhandledRejection',
        listener: allRej[allRej.length - 1] as (...args: unknown[]) => void,
      },
      {
        event: 'uncaughtException',
        listener: allExc[allExc.length - 2] as (...args: unknown[]) => void,
      },
      {
        event: 'uncaughtException',
        listener: allExc[allExc.length - 1] as (...args: unknown[]) => void,
      }
    );
  });

  it('the exit handler uses setImmediate, not synchronous exit (lets stderr flush)', () => {
    // Spy on global setImmediate to verify the handler defers exit via
    // setImmediate rather than calling process.exit synchronously. We
    // intercept the immediate's callback so it never actually runs —
    // running it would re-enter process.exit and cascade through the
    // installed handler on the test worker. The behavior we want to pin
    // is just "exit is deferred via setImmediate" — execution of the
    // deferred work is Node's job, not ours to test.
    const fakeExit = vi.fn();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(fakeExit as never);
    const immediateSpy = vi.spyOn(globalThis, 'setImmediate').mockImplementation(((
      _cb: () => void
    ) => {
      return { hasRef: () => true, ref: () => undefined, unref: () => undefined } as never;
    }) as never);

    install();

    const installedListener = installed.find((l) => l.event === 'uncaughtException')!;
    installedListener.listener(new Error('boom'), 'uncaughtException');

    // The handler deferred via setImmediate; process.exit was NOT called
    // synchronously (which would have skipped the stderr flush window).
    expect(immediateSpy).toHaveBeenCalled();
    expect(fakeExit).not.toHaveBeenCalled();

    immediateSpy.mockRestore();
    process.exitCode = 0;
  });
});
