import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GimpBackend } from '@editmamei/backends/gimp/backend.ts';
import { GimpError } from '@editmamei/backends/gimp/errors.ts';
import type { GimpSession, GimpSessionOptions } from '@editmamei/backends/gimp/session.ts';
import type { GimpInstall } from '@editmamei/backends/gimp/detect.ts';
import { runWithToolBudget } from '@editmamei/utils/tool-budget-context.ts';

const SAMPLE_INSTALL: GimpInstall = {
  source: 'conventional',
  path: 'C:/Program Files/GIMP 3/bin/gimp-console-3.2.exe',
  launch: { command: 'C:/Program Files/GIMP 3/bin/gimp-console-3.2.exe', args: [] },
};

interface RecordedFakeCall {
  op: string;
  args: Record<string, unknown>;
  timeoutMs?: number;
}

/** A minimal fake shaped like `GimpSession` — the unit-test seam for `GimpBackend` itself, distinct from `tests/fixtures/fake-gimp-session.ts` (which fakes `GimpBackend`, one layer up). */
function makeFakeSession(
  opts: {
    result?: unknown;
    gimpVersion?: string;
    state?: string;
    lastStartOrigin?: 'cold' | 'restarted';
  } = {}
) {
  const calls: RecordedFakeCall[] = [];
  let shutdownCalls = 0;
  const fake = {
    calls,
    get shutdownCalls() {
      return shutdownCalls;
    },
    gimpVersion: opts.gimpVersion,
    state: opts.state ?? 'ready',
    lastStartOrigin: opts.lastStartOrigin,
    async call(
      op: string,
      args: Record<string, unknown> = {},
      callOpts: { timeoutMs?: number } = {}
    ) {
      calls.push({ op, args, timeoutMs: callOpts.timeoutMs });
      return opts.result ?? {};
    },
    latestPreviewPath: () => '/fake/session/latest-preview.jpg',
    copyToLatestPreview: (_src: string) => {},
    tempPath: (name: string) => `/fake/session/${name}`,
    // Mirrors the real GimpSession's own memoized shutdownPromise latch —
    // a second shutdown() call is a no-op, not a second teardown.
    _shutdownStarted: false,
    async shutdown() {
      if (this._shutdownStarted) return;
      this._shutdownStarted = true;
      shutdownCalls++;
    },
  };
  return fake;
}

function backendWithFakeSession(
  install: GimpInstall | null,
  fake: ReturnType<typeof makeFakeSession>
): { backend: GimpBackend; sessionFactory: ReturnType<typeof vi.fn> } {
  const sessionFactory = vi.fn((_opts: GimpSessionOptions) => fake as unknown as GimpSession);
  const backend = new GimpBackend(install, { sessionFactory });
  return { backend, sessionFactory };
}

describe('GimpBackend', () => {
  describe('lazy session creation', () => {
    it('never constructs a session at construction time', () => {
      const fake = makeFakeSession();
      const { sessionFactory } = backendWithFakeSession(SAMPLE_INSTALL, fake);
      expect(sessionFactory).not.toHaveBeenCalled();
    });

    it('constructs the session on the first call() and reuses it on later calls', async () => {
      const fake = makeFakeSession();
      const { backend, sessionFactory } = backendWithFakeSession(SAMPLE_INSTALL, fake);
      await backend.call('ping', {});
      expect(sessionFactory).toHaveBeenCalledTimes(1);
      await backend.call('ping', {});
      expect(sessionFactory).toHaveBeenCalledTimes(1); // memoized, not a fresh session per call
      expect(fake.calls).toHaveLength(2);
    });

    it('passes the resolved install through to the session factory', async () => {
      const fake = makeFakeSession();
      const { backend, sessionFactory } = backendWithFakeSession(SAMPLE_INSTALL, fake);
      await backend.call('ping', {});
      expect(sessionFactory).toHaveBeenCalledWith(
        expect.objectContaining({ install: SAMPLE_INSTALL })
      );
    });

    it('also constructs the session lazily via latestPreviewPath/tempPath, not just call()', () => {
      const fake = makeFakeSession();
      const { backend, sessionFactory } = backendWithFakeSession(SAMPLE_INSTALL, fake);
      expect(backend.latestPreviewPath()).toBe('/fake/session/latest-preview.jpg');
      expect(sessionFactory).toHaveBeenCalledTimes(1);
      expect(backend.tempPath('x.jpg')).toBe('/fake/session/x.jpg');
      expect(sessionFactory).toHaveBeenCalledTimes(1); // same session, not a second one
    });
  });

  describe('installed / install', () => {
    it('reports installed:true and the resolved install when one was given', () => {
      const backend = new GimpBackend(SAMPLE_INSTALL);
      expect(backend.installed).toBe(true);
      expect(backend.install).toBe(SAMPLE_INSTALL);
    });

    it('reports installed:false and install:null when constructed with none', () => {
      const backend = new GimpBackend(null);
      expect(backend.installed).toBe(false);
      expect(backend.install).toBeNull();
    });
  });

  describe('gimp_not_installed', () => {
    it('every method that reaches ensureSession() rejects with gimp_not_installed, and never constructs a session', async () => {
      const backend = new GimpBackend(null);
      await expect(backend.call('ping', {})).rejects.toMatchObject({
        code: 'gimp_not_installed',
      });
      expect(() => backend.latestPreviewPath()).toThrow(
        expect.objectContaining({ code: 'gimp_not_installed' })
      );
      expect(() => backend.tempPath('x')).toThrow(
        expect.objectContaining({ code: 'gimp_not_installed' })
      );
    });

    it('after a boot-time detection timeout, the first call re-detects once and uses an install found late', async () => {
      const fake = makeFakeSession();
      const detectGimpFn = vi.fn(async () => SAMPLE_INSTALL);
      const sessionFactory = vi.fn((_o: GimpSessionOptions) => fake as unknown as GimpSession);
      const backend = new GimpBackend(null, {
        sessionFactory,
        detectGimpFn,
        gimpDetectionTimedOut: true,
      });
      await backend.call('ping', {});
      await backend.call('ping', {});
      expect(detectGimpFn).toHaveBeenCalledTimes(1);
      expect(backend.installed).toBe(true);
      expect(fake.calls.map((c) => c.op)).toEqual(['ping', 'ping']);
    });

    it('prepare() runs the owed re-detect so the path helpers work before the first call', async () => {
      const fake = makeFakeSession();
      const detectGimpFn = vi.fn(async () => SAMPLE_INSTALL);
      const backend = new GimpBackend(null, {
        sessionFactory: () => fake as unknown as GimpSession,
        detectGimpFn,
        gimpDetectionTimedOut: true,
      });
      expect(() => backend.latestPreviewPath()).toThrow(
        expect.objectContaining({ code: 'gimp_not_installed' })
      );
      await backend.prepare();
      expect(backend.latestPreviewPath()).toBe('/fake/session/latest-preview.jpg');
      expect(detectGimpFn).toHaveBeenCalledTimes(1);
    });

    it('the default re-detect honours the configured gimp_path, not only the standard install locations', async () => {
      // A configured path that exists nowhere near a standard install location.
      const dir = mkdtempSync(join(tmpdir(), 'em-gimp-configured-'));
      const configured = join(dir, 'custom-gimp-console.exe');
      writeFileSync(configured, '');
      try {
        const backend = new GimpBackend(null, {
          sessionFactory: () => makeFakeSession() as unknown as GimpSession,
          gimpDetectionTimedOut: true,
          gimpPath: configured,
        });
        await backend.prepare();
        expect(backend.install).toMatchObject({ source: 'env', path: configured });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('without a boot timeout there is no re-detect: a real miss stays gimp_not_installed', async () => {
      const detectGimpFn = vi.fn(async () => SAMPLE_INSTALL);
      const backend = new GimpBackend(null, { detectGimpFn, gimpDetectionTimedOut: false });
      await backend.prepare();
      await expect(backend.call('ping', {})).rejects.toMatchObject({ code: 'gimp_not_installed' });
      expect(detectGimpFn).not.toHaveBeenCalled();
    });

    it('names the EDITMAMEI_GIMP_PATH env var and the gimp_path setting as the fix', async () => {
      const backend = new GimpBackend(null);
      await expect(backend.call('ping', {})).rejects.toThrow(/EDITMAMEI_GIMP_PATH/);
      await expect(backend.call('ping', {})).rejects.toThrow(/gimp_path/);
    });
  });

  describe('budget exhaustion', () => {
    it('rejects with gimp_timeout, without ever reaching the session, when the enclosing tool budget has already expired', async () => {
      const fake = makeFakeSession();
      const { backend } = backendWithFakeSession(SAMPLE_INSTALL, fake);
      const expiredDeadline = Date.now() - 1;
      await expect(
        runWithToolBudget(
          { toolName: 'gimp_open_document', budgetMs: 30_000, deadline: expiredDeadline },
          () => backend.call('open', { path: 'C:/x.jpg' })
        )
      ).rejects.toMatchObject({ code: 'gimp_timeout' });
      expect(fake.calls).toHaveLength(0);
    });

    it('passes the remaining budget as timeoutMs when the deadline has not yet expired', async () => {
      const fake = makeFakeSession();
      const { backend } = backendWithFakeSession(SAMPLE_INSTALL, fake);
      const deadline = Date.now() + 10_000;
      await runWithToolBudget({ toolName: 'gimp_open_document', budgetMs: 30_000, deadline }, () =>
        backend.call('open', { path: 'C:/x.jpg' })
      );
      expect(fake.calls).toHaveLength(1);
      const seenTimeout = fake.calls[0]!.timeoutMs!;
      expect(seenTimeout).toBeGreaterThan(0);
      expect(seenTimeout).toBeLessThanOrEqual(10_000);
    });

    it('an explicit timeoutMs always wins over the enclosing budget', async () => {
      const fake = makeFakeSession();
      const { backend } = backendWithFakeSession(SAMPLE_INSTALL, fake);
      await backend.call('open', { path: 'C:/x.jpg' }, 777);
      expect(fake.calls[0]!.timeoutMs).toBe(777);
    });

    it('with no enclosing budget at all, timeoutMs is left undefined (the session applies its own default)', async () => {
      const fake = makeFakeSession();
      const { backend } = backendWithFakeSession(SAMPLE_INSTALL, fake);
      await backend.call('open', { path: 'C:/x.jpg' });
      expect(fake.calls[0]!.timeoutMs).toBeUndefined();
    });
  });

  describe('shutdown', () => {
    it('delegates to the session shutdown when one was started', async () => {
      const fake = makeFakeSession();
      const { backend } = backendWithFakeSession(SAMPLE_INSTALL, fake);
      await backend.call('ping', {});
      await backend.shutdown();
      expect(fake.shutdownCalls).toBe(1);
    });

    it('is a safe no-op on the underlying session when none was ever started, but still marks the backend closed', async () => {
      const fake = makeFakeSession();
      const { backend, sessionFactory } = backendWithFakeSession(SAMPLE_INSTALL, fake);
      await backend.shutdown();
      expect(sessionFactory).not.toHaveBeenCalled(); // shutdown alone never starts GIMP
      expect(fake.shutdownCalls).toBe(0); // nothing to shut down — no session ever existed

      // The regression this closes: a later call() must NOT start a fresh
      // GIMP process behind a backend that was already told to shut down.
      await expect(backend.call('ping', {})).rejects.toMatchObject({
        code: 'gimp_session_restarted',
      });
      expect(sessionFactory).not.toHaveBeenCalled();
    });

    it('call() after a shutdown that DID have a session rejects the same way, and never re-invokes the underlying session', async () => {
      const fake = makeFakeSession();
      const { backend, sessionFactory } = backendWithFakeSession(SAMPLE_INSTALL, fake);
      await backend.call('ping', {});
      expect(fake.calls).toHaveLength(1);
      await backend.shutdown();
      await expect(backend.call('ping', {})).rejects.toMatchObject({
        code: 'gimp_session_restarted',
      });
      expect(fake.calls).toHaveLength(1); // the second call never reached the (already-shut-down) session
      expect(sessionFactory).toHaveBeenCalledTimes(1); // no second session either
    });

    it('is idempotent — a second shutdown() is safe', async () => {
      const fake = makeFakeSession();
      const { backend } = backendWithFakeSession(SAMPLE_INSTALL, fake);
      await backend.call('ping', {});
      await backend.shutdown();
      await expect(backend.shutdown()).resolves.toBeUndefined();
      expect(fake.shutdownCalls).toBe(1); // the underlying session's own memoized shutdown isn't re-invoked
    });
  });

  describe('gimpVersion / state passthrough', () => {
    it('defaults to undefined / idle before any session exists', () => {
      const backend = new GimpBackend(SAMPLE_INSTALL);
      expect(backend.gimpVersion).toBeUndefined();
      expect(backend.state).toBe('idle');
      expect(backend.startOrigin).toBeUndefined();
    });

    it('mirrors the underlying session once one exists', async () => {
      const fake = makeFakeSession({ gimpVersion: '3.2.6', state: 'ready' });
      const { backend } = backendWithFakeSession(SAMPLE_INSTALL, fake);
      await backend.call('ping', {});
      expect(backend.gimpVersion).toBe('3.2.6');
      expect(backend.state).toBe('ready');
    });

    it("startOrigin delegates to the underlying session's lastStartOrigin", async () => {
      const fake = makeFakeSession({ state: 'starting', lastStartOrigin: 'restarted' });
      const { backend } = backendWithFakeSession(SAMPLE_INSTALL, fake);
      await backend.call('ping', {});
      expect(backend.startOrigin).toBe('restarted');
    });
  });

  describe('copyToLatestPreview', () => {
    it('delegates to the session', () => {
      const fake = makeFakeSession();
      const spy = vi.spyOn(fake, 'copyToLatestPreview');
      const { backend } = backendWithFakeSession(SAMPLE_INSTALL, fake);
      backend.copyToLatestPreview('/some/rendered.jpg');
      expect(spy).toHaveBeenCalledWith('/some/rendered.jpg');
    });
  });
});
