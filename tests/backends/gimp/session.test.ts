import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GimpSession,
  resolveOpsPyPath,
  defaultRootDir,
  defaultTreeKill,
  BATCH_LINE,
  SHUTDOWN_GRACE_MS,
  KILL_CONFIRM_MS,
  type SpawnFn,
  type GimpSessionOptions,
} from '@editmamei/backends/gimp/session.ts';
import type { GimpInstall } from '@editmamei/backends/gimp/detect.ts';
import { GimpError } from '@editmamei/backends/gimp/errors.ts';
import { Logger } from '@editmamei/utils/logger.ts';
import { userOwnedTempRoot } from '@editmamei/utils/temp.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * True if any call to a `vi.spyOn(logger, 'warn'|'error'|...)` spy's first
 * argument contains `substring`. `toHaveBeenCalledWith(expect.stringContaining(...))`
 * looks like it does this but doesn't: it requires the WHOLE argument list to
 * match, and every real `logger.warn(message, ...details)` call in this
 * codebase passes extra arguments (e.g. `{ code, signal }`), so a one-arg
 * matcher against a two-arg call always reports "not called" regardless of
 * what was actually logged -- the assertion can never fail. Proven by
 * temporarily deleting the `shuttingDown` early-return in session.ts's exit
 * listener and re-running the "not logged as a crash" test below: with the
 * naive matcher it stayed green; with this helper it failed exactly as
 * expected, then went back to green once the code was restored.
 */
function loggedMessageContaining(spy: ReturnType<typeof vi.spyOn>, substring: string): boolean {
  return spy.mock.calls.some(
    (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes(substring)
  );
}

/** The mock type killTree spies are declared as everywhere in this file. */
type KillTreeSpy = ReturnType<typeof vi.fn<(proc: ChildProcess) => void>>;

// Every test's temp rootDir + any FakeGimpServer polling loops it started,
// torn down in one afterEach rather than a per-test try/finally.
const cleanupFns: Array<() => void> = [];
function registerCleanup(rootDir: string, servers: FakeGimpServer[] = []): void {
  cleanupFns.push(() => {
    for (const s of servers) s.stop();
    rmSync(rootDir, { recursive: true, force: true });
  });
}

const INSTALL: GimpInstall = {
  source: 'conventional',
  path: 'FAKE_GIMP_CONSOLE',
  launch: { command: 'FAKE_GIMP_CONSOLE', args: [] },
};

/**
 * A stub `ChildProcess`: an EventEmitter with the surface session.ts
 * touches. The default pid is a real-PID-format number far outside any
 * range this machine (or CI) would ever actually allocate — belt-and-
 * suspenders alongside `buildSession`'s killTree-spy default below: if a
 * real tree-kill ever DID run against a stub by mistake, it would target a
 * pid that can't collide with an actual running process.
 */
function makeStubChild(pid = 999_999_999): {
  child: ChildProcess;
  emitStderr: (s: string) => void;
  /** Emits 'exit' THEN 'close' (real Node's usual ordering) -- the combined
   * helper most tests want, when the exit/close distinction itself isn't
   * what's under test. */
  emitExit: (code: number | null, signal: string | null) => void;
  /** Emits ONLY 'exit' (sets `exitCode`, no 'close') -- for tests that need
   * to control the gap between the two events, e.g. proving classification
   * waits for 'close' rather than firing on 'exit'. */
  emitExitEvent: (code: number | null, signal: string | null) => void;
  /** Emits ONLY 'close' (does not touch `exitCode`) -- paired with
   * `emitExitEvent` above. */
  emitCloseEvent: (code: number | null) => void;
  killSpy: ReturnType<typeof vi.fn>;
} {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const proc = new EventEmitter() as EventEmitter & {
    stdout: typeof stdout;
    stderr: typeof stderr;
    pid: number;
    exitCode: number | null;
    kill: (signal?: string) => boolean;
  };
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.pid = pid;
  proc.exitCode = null;
  const killSpy = vi.fn(() => true);
  proc.kill = killSpy;
  const emitExitEvent = (code: number | null, signal: string | null): void => {
    proc.exitCode = code;
    proc.emit('exit', code, signal);
  };
  const emitCloseEvent = (code: number | null): void => {
    proc.emit('close', code);
  };
  return {
    child: proc as unknown as ChildProcess,
    emitStderr: (s: string) => stderr.emit('data', Buffer.from(s, 'utf8')),
    emitExit: (code, signal) => {
      emitExitEvent(code, signal);
      emitCloseEvent(code);
    },
    emitExitEvent,
    emitCloseEvent,
    killSpy,
  };
}

function writeReady(rpcDir: string, pid = 999): void {
  writeFileSync(join(rpcDir, 'ready.tmp'), String(pid));
  renameSync(join(rpcDir, 'ready.tmp'), join(rpcDir, 'ready'));
}

/**
 * A fake in-GIMP `serve()` loop: polls `rpc/req-*.json`, answers via
 * `responder`, ignores (never answers) any op named in `hangOps` — the
 * seam tests use to force a timeout without waiting one out for real. The
 * response path is derived from the request's own id, exactly like the real
 * bridge does — the request no longer carries a `resp` field at all.
 */
class FakeGimpServer {
  private stopped = false;
  readonly calls: Array<{ op: string; args: unknown }> = [];
  /** Highest number of req-*.json files this loop ever saw at once — the serial-queue proof. */
  maxConcurrentRequests = 0;

  constructor(
    private readonly rpcDir: string,
    private readonly responder: (op: string, args: unknown) => unknown,
    private readonly hangOps: ReadonlySet<string> = new Set(),
    /** Mirrors real GIMP exiting once it sees rpc/shutdown, so shutdown() doesn't have to wait out its grace window in every test. */
    private readonly onShutdown?: () => void
  ) {
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      if (existsSync(join(this.rpcDir, 'shutdown'))) {
        this.onShutdown?.();
        return;
      }
      let names: string[] = [];
      try {
        names = readdirSync(this.rpcDir).filter((n) => n.startsWith('req-') && n.endsWith('.json'));
      } catch {
        /* rpc dir removed — stop quietly */
        return;
      }
      this.maxConcurrentRequests = Math.max(this.maxConcurrentRequests, names.length);
      for (const name of names) {
        const reqPath = join(this.rpcDir, name);
        let req: { id: number; op: string; args: unknown };
        try {
          req = JSON.parse(readFileSync(reqPath, 'utf8'));
        } catch {
          continue;
        }
        if (this.hangOps.has(req.op)) continue; // deliberately never answered
        this.calls.push({ op: req.op, args: req.args });
        let resp: Record<string, unknown>;
        try {
          resp = { id: req.id, ok: true, result: this.responder(req.op, req.args) };
        } catch (err) {
          resp = { id: req.id, ok: false, code: 'gimp_op_failed', error: String(err) };
        }
        // Derived independently from the id, same as the real bridge —
        // never trusts a `resp` field inside the request.
        const respPath = join(this.rpcDir, `resp-${req.id}.json`);
        writeFileSync(`${respPath}.tmp`, JSON.stringify(resp));
        renameSync(`${respPath}.tmp`, respPath);
        try {
          unlinkSync(reqPath);
        } catch {
          /* already gone */
        }
      }
      await sleep(2);
    }
  }
}

const pingOk = (op: string): unknown => {
  if (op === 'ping') return { major: 3, minor: 2, micro: 6 };
  return { op };
};

interface Harness {
  rootDir: string;
  spawnCalls: Array<{
    command: string;
    args: readonly string[];
    env: Record<string, string | undefined>;
  }>;
  killTreeSpy: KillTreeSpy;
  logger: Logger;
  warnSpy: ReturnType<typeof vi.spyOn>;
  servers: FakeGimpServer[];
  session: GimpSession;
}

/**
 * Builds a GimpSession whose spawn() is intercepted: it creates a stub child,
 * discovers the session dir the real code chose (via the env vars session.ts
 * sets), writes rpc/ready (unless `autoReady` is false), and starts a
 * FakeGimpServer against it (unless `respondToShutdown` is false, in which
 * case the stub never exits on its own — used to exercise the grace-timeout
 * kill path).
 */
function harness(
  opts: {
    responder?: (op: string, args: unknown) => unknown;
    hangOps?: ReadonlySet<string>;
    autoReady?: boolean;
    respondToShutdown?: boolean;
    /** Extra GimpSessionOptions merged into the constructor call (e.g. `readRespFile`). Never overrides `killTree` unless it sets one itself. */
    extra?: Partial<GimpSessionOptions>;
  } = {}
): Harness {
  const rootDir = mkdtempSync(join(tmpdir(), 'em-gimp-session-'));
  const spawnCalls: Harness['spawnCalls'] = [];
  const killTreeSpy = (opts.extra?.killTree ?? vi.fn()) as KillTreeSpy;
  const logger = new Logger('test');
  const warnSpy = vi.spyOn(logger, 'warn');
  const servers: FakeGimpServer[] = [];
  const responder = opts.responder ?? pingOk;
  const autoReady = opts.autoReady ?? true;
  const respondToShutdown = opts.respondToShutdown ?? true;

  const spawn: SpawnFn = (command, args, options) => {
    const env = (options.env ?? {}) as Record<string, string | undefined>;
    spawnCalls.push({ command, args, env });
    const { child, emitExit } = makeStubChild();
    const sessionDir = env.EM_GIMP_SESSION!;
    const rpcDir = join(sessionDir, 'rpc');
    if (autoReady) {
      writeReady(rpcDir);
      servers.push(
        new FakeGimpServer(
          rpcDir,
          responder,
          opts.hangOps,
          respondToShutdown ? () => emitExit(0, null) : undefined
        )
      );
    }
    return child;
  };

  const session = new GimpSession({
    install: INSTALL,
    rootDir,
    spawn,
    logger,
    ...opts.extra,
    // AFTER `...opts.extra`: a test that passes `extra` for some unrelated
    // seam (e.g. `readRespFile`) must never accidentally restore the real
    // `defaultTreeKill` by spreading over this — `killTreeSpy` always wins.
    killTree: killTreeSpy,
  });
  registerCleanup(rootDir, servers);
  return { rootDir, spawnCalls, killTreeSpy, logger, warnSpy, servers, session };
}

/**
 * The ONLY sanctioned way this file builds a bare GimpSession outside
 * `harness()`. ALWAYS supplies a killTree spy unless the caller explicitly
 * overrides it — the structural fix for a real hazard where a test that
 * omitted `killTree` entirely let the default `defaultTreeKill` run a REAL
 * `taskkill /PID <pid> /T /F` against a fake pid on the dev machine every
 * time this suite ran. See the guard test directly below.
 */
function buildSession(opts: Partial<GimpSessionOptions> & { rootDir: string; spawn: SpawnFn }): {
  session: GimpSession;
  killTreeSpy: KillTreeSpy;
} {
  const killTreeSpy = (opts.killTree ?? vi.fn()) as KillTreeSpy;
  const session = new GimpSession({
    install: INSTALL,
    ...opts,
    killTree: killTreeSpy,
  });
  return { session, killTreeSpy };
}

describe('test-suite safety', () => {
  it('buildSession() always supplies a killTree spy by default, never the real defaultTreeKill', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'em-gimp-guard-'));
    registerCleanup(rootDir);
    const { killTreeSpy } = buildSession({ rootDir, spawn: () => makeStubChild().child });
    expect(vi.isMockFunction(killTreeSpy)).toBe(true);
    expect(killTreeSpy).not.toBe(defaultTreeKill);
  });

  it('harness() always supplies a killTree spy by default, never the real defaultTreeKill', () => {
    const h = harness();
    expect(vi.isMockFunction(h.killTreeSpy)).toBe(true);
    expect(h.killTreeSpy).not.toBe(defaultTreeKill);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  while (cleanupFns.length > 0) cleanupFns.pop()!();
});

describe('resolveOpsPyPath', () => {
  it('resolves to bridge/ops.py next to this module, and the file exists under src/', () => {
    const path = resolveOpsPyPath();
    expect(path.replace(/\\/g, '/')).toMatch(/src\/backends\/gimp\/bridge\/ops\.py$/);
    expect(existsSync(path)).toBe(true);
  });
});

describe('defaultRootDir', () => {
  it('is a sibling "gimp" directory under the per-user private cache root, never os.tmpdir()', () => {
    expect(defaultRootDir()).toBe(join(userOwnedTempRoot(), 'gimp'));
  });
});

describe('BATCH_LINE', () => {
  it('is a fixed constant carrying no path — it only reads env vars', () => {
    expect(BATCH_LINE).toContain("os.environ['EM_GIMP_OPS']");
    expect(BATCH_LINE).toContain("os.environ['EM_GIMP_SESSION']");
    expect(BATCH_LINE).not.toMatch(/[\\/](bin|bridge|session-)/);
    expect(BATCH_LINE).not.toContain(':\\');
  });
});

describe('GimpSession', () => {
  it('does the ready handshake, pings, and reaches state ready', async () => {
    const h = harness();
    expect(h.session.state).toBe('idle');

    const result = await h.session.call<{ op: string }>('open', { path: 'x.jpg' });

    expect(result).toEqual({ op: 'open' });
    expect(h.session.state).toBe('ready');
    expect(h.session.gimpVersion).toBe('3.2.6');
    expect(h.spawnCalls).toHaveLength(1);
    expect(h.spawnCalls[0]!.args).toEqual([
      '-i',
      '--batch-interpreter=python-fu-eval',
      '-b',
      BATCH_LINE,
      '--quit',
    ]);
    expect(h.spawnCalls[0]!.env.EM_GIMP_OPS).toBe(resolveOpsPyPath());
    expect(h.spawnCalls[0]!.env.EM_GIMP_PARENT_PID).toBe(String(process.pid));
  });

  describe('version gate', () => {
    it('rejects GIMP 3.0 as unsupported', async () => {
      const h = harness({
        responder: (op) => (op === 'ping' ? { major: 3, minor: 0, micro: 0 } : {}),
      });
      await expect(h.session.call('open', {})).rejects.toMatchObject({
        code: 'gimp_version_unsupported',
      });
      expect(h.session.state).toBe('dead');
      expect(h.killTreeSpy).toHaveBeenCalled();
    });

    it('accepts GIMP 3.2 with no warning', async () => {
      const h = harness({
        responder: (op) => (op === 'ping' ? { major: 3, minor: 2, micro: 0 } : {}),
      });
      await h.session.call('open', {});
      expect(h.session.state).toBe('ready');
      expect(h.warnSpy).not.toHaveBeenCalled();
    });

    it('accepts GIMP 3.4 but logs an untested-version warning', async () => {
      const h = harness({
        responder: (op) => (op === 'ping' ? { major: 3, minor: 4, micro: 0 } : {}),
      });
      await h.session.call('open', {});
      expect(h.session.state).toBe('ready');
      expect(h.warnSpy).toHaveBeenCalledWith(expect.stringContaining('3.4.0'));
    });
  });

  it('serializes calls in order — one request in flight at a time', async () => {
    const order: string[] = [];
    const h = harness({
      responder: (op) => {
        order.push(op);
        if (op === 'ping') return { major: 3, minor: 2, micro: 6 };
        return { op };
      },
    });

    const results = await Promise.all([
      h.session.call('a', {}),
      h.session.call('b', {}),
      h.session.call('c', {}),
    ]);

    expect(results).toEqual([{ op: 'a' }, { op: 'b' }, { op: 'c' }]);
    // 'ping' is inserted by the session itself, ahead of the caller's ops.
    expect(order).toEqual(['ping', 'a', 'b', 'c']);
    // The fake server never saw more than one req-*.json file at a time.
    expect(h.servers[0]!.maxConcurrentRequests).toBeLessThanOrEqual(1);
  });

  it('on timeout: tree-kills, rejects with gimp_timeout, and the NEXT call starts a fresh session dir', async () => {
    const h = harness({ hangOps: new Set(['slow']) });

    await expect(h.session.call('slow', {}, { timeoutMs: 30 })).rejects.toMatchObject({
      code: 'gimp_timeout',
    });
    expect(h.killTreeSpy).toHaveBeenCalledTimes(1);
    expect(h.session.state).toBe('dead');

    const result = await h.session.call<{ op: string }>('open', {});
    expect(result).toEqual({ op: 'open' });
    expect(h.session.state).toBe('ready');
    expect(h.spawnCalls).toHaveLength(2);
    expect(h.spawnCalls[0]!.env.EM_GIMP_SESSION).not.toBe(h.spawnCalls[1]!.env.EM_GIMP_SESSION);
  });

  it('unexpected exit rejects the in-flight call AND every queued call with gimp_session_restarted, without touching a fresh session', async () => {
    const h = harness({ hangOps: new Set(['a', 'b', 'c']) });

    const a = h.session.call('a', {});
    const b = h.session.call('b', {});
    const c = h.session.call('c', {});

    // Let the ping + first request actually land before we crash the process.
    await sleep(30);

    // Reach into the spawn call to kill the underlying stub directly —
    // simulate GIMP dying mid-session (not our own shutdown()/timeout kill).
    const stub = (h.session as unknown as { proc: ChildProcess }).proc;
    (stub as unknown as { exitCode: number | null }).exitCode = 1;
    stub.emit('exit', 1, null);

    await expect(a).rejects.toMatchObject({ code: 'gimp_session_restarted' });
    await expect(b).rejects.toMatchObject({ code: 'gimp_session_restarted' });
    await expect(c).rejects.toMatchObject({ code: 'gimp_session_restarted' });
    expect(h.session.state).toBe('dead');

    // The NEXT call (issued after the crash was already known) is the one
    // that gets a fresh GIMP.
    const d = await h.session.call<{ op: string }>('open', {});
    expect(d).toEqual({ op: 'open' });
    expect(h.spawnCalls).toHaveLength(2);
  });

  it('a late exit event from an already-superseded process does not mark a fresh, healthy session dead', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'em-gimp-session-'));
    const servers: FakeGimpServer[] = [];
    const stubs: Array<ReturnType<typeof makeStubChild>> = [];
    const spawn: SpawnFn = (_c, _a, options) => {
      const env = options.env as Record<string, string>;
      const stub = makeStubChild();
      stubs.push(stub);
      const rpcDir = join(env.EM_GIMP_SESSION, 'rpc');
      writeReady(rpcDir);
      servers.push(new FakeGimpServer(rpcDir, pingOk, new Set(['slow'])));
      return stub.child;
    };
    // killTree doesn't kill synchronously here — it schedules the exit for
    // LATER, well after a fresh session has had time to become ready. This
    // is exactly the real-world shape: a tree-kill is fire-and-forget, and
    // the OS reaps the process on its own schedule.
    const killTreeSpy = vi.fn((proc: ChildProcess) => {
      setTimeout(() => {
        (proc as unknown as { exitCode: number | null }).exitCode = 1;
        proc.emit('exit', 1, null);
      }, 30);
    });
    const { session } = buildSession({ rootDir, spawn, killTree: killTreeSpy });
    registerCleanup(rootDir, servers);

    await expect(session.call('slow', {}, { timeoutMs: 10 })).rejects.toMatchObject({
      code: 'gimp_timeout',
    });
    await session.call('ping', {}); // fresh session -- stub #2
    expect(session.state).toBe('ready');
    expect(stubs).toHaveLength(2);

    await sleep(60); // let stub #1's delayed, kill-triggered exit actually fire

    expect(session.state).toBe('ready'); // must NOT have flipped to 'dead'
    const liveCount = stubs.filter((s) => s.child.exitCode === null).length;
    expect(liveCount).toBe(1); // exactly one live fake process
  });

  it('a readiness timeout rejects with gimp_start_failed without waiting the real 60s (injected clock)', async () => {
    let calls = 0;
    const now = () => {
      calls++;
      return calls * 100_000; // monotonically past any deadline within one or two reads
    };
    const rootDir = mkdtempSync(join(tmpdir(), 'em-gimp-session-'));
    registerCleanup(rootDir);
    const spawn: SpawnFn = () => makeStubChild().child; // never writes ready
    const { session } = buildSession({ rootDir, spawn, now });
    await expect(session.call('ping', {})).rejects.toMatchObject({ code: 'gimp_start_failed' });
  });

  it('shutdown() during "starting" makes the pending call reject almost immediately, not wait out the 60s ready timeout', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'em-gimp-session-'));
    registerCleanup(rootDir);
    const spawn: SpawnFn = () => makeStubChild().child; // never writes ready, never exits on its own
    const { session } = buildSession({ rootDir, spawn });

    const callPromise = session.call('ping', {});
    callPromise.catch(() => {});
    await sleep(10); // let #startFresh spawn and enter #waitForReady's poll loop

    const start = Date.now();
    const shutdownDone = session.shutdown(); // `shuttingDown` flips synchronously, well before shutdown() itself finishes

    await expect(callPromise).rejects.toMatchObject({
      code: 'gimp_session_restarted',
      message: expect.stringContaining('session closed'),
    });
    // Comfortably bounded well under the real 60s READY_TIMEOUT_MS -- in
    // practice this resolves within one POLL_INTERVAL_MS (2ms) of
    // `shuttingDown` flipping, not anywhere near the ready deadline.
    expect(Date.now() - start).toBeLessThan(1000);
    await shutdownDone; // don't leave shutdown's grace/kill timers running into later tests
  });

  it('spawn failure (ENOENT-like) rejects with gimp_start_failed', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'em-gimp-session-'));
    registerCleanup(rootDir);
    const spawn: SpawnFn = () => {
      throw Object.assign(new Error('spawn FAKE_GIMP_CONSOLE ENOENT'), { code: 'ENOENT' });
    };
    const { session } = buildSession({ rootDir, spawn });
    await expect(session.call('ping', {})).rejects.toMatchObject({ code: 'gimp_start_failed' });
    expect(session.state).toBe('dead');
  });

  it('an async ENOENT reported via the error event gives gimp_start_failed "not found", not a generic exit classification', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'em-gimp-session-'));
    registerCleanup(rootDir);
    const spawn: SpawnFn = () => {
      const { child } = makeStubChild();
      // How Node actually reports a failed spawn most of the time: an async
      // 'error' event, often followed by an 'exit' whose code is some
      // errno-derived negative number (commonly -2 for ENOENT) rather than
      // anything that reads as "GIMP exited before ready".
      setImmediate(() => {
        child.emit(
          'error',
          Object.assign(new Error('spawn FAKE_GIMP_CONSOLE ENOENT'), { code: 'ENOENT' })
        );
        (child as unknown as { exitCode: number | null }).exitCode = -2;
        child.emit('exit', -2, null);
      });
      return child;
    };
    const { session } = buildSession({ rootDir, spawn });
    await expect(session.call('ping', {})).rejects.toMatchObject({
      code: 'gimp_start_failed',
      message: expect.stringContaining('not found'),
    });
  });

  // GIMP's own three wordings for "the batch interpreter itself isn't there"
  // (extracted from gimp-console-3.exe 3.2.6, with python-fu-eval
  // substituted where the binary's `%s` is) — each must classify as sticky
  // gimp_python_missing, and a second call must fail fast with no relaunch.
  it.each([
    "The batch interpreter 'python-fu-eval' is not available. Batch mode disabled.",
    'No batch interpreters are available. Batch mode disabled.',
    "The procedure 'python-fu-eval' is not a valid batch interpreter.",
  ])('GIMP\'s real "%s" message classifies as gimp_python_missing (sticky)', async (message) => {
    const rootDir = mkdtempSync(join(tmpdir(), 'em-gimp-session-'));
    registerCleanup(rootDir);
    let spawnCount = 0;
    const spawn: SpawnFn = () => {
      spawnCount++;
      const { child, emitStderr, emitExit } = makeStubChild();
      // Never write rpc/ready — GIMP dies first because Python support
      // isn't compiled into this build, so "python-fu-eval" was never
      // registered as an interpreter at all. Deferred to a macrotask so
      // #startFresh's synchronous `.on('data')`/`.on('exit')` listener
      // registration (which happens right after spawn() returns) is in
      // place before these fire — emitting inline here would fire before
      // anything is listening.
      setImmediate(() => {
        emitStderr(message);
        emitExit(1, null);
      });
      return child;
    };
    const { session } = buildSession({ rootDir, spawn });
    await expect(session.call('ping', {})).rejects.toMatchObject({ code: 'gimp_python_missing' });
    expect(spawnCount).toBe(1);

    // Sticky: a second call fails fast with the same error, no relaunch.
    await expect(session.call('ping', {})).rejects.toMatchObject({ code: 'gimp_python_missing' });
    expect(spawnCount).toBe(1);
  });

  it('GIMP\'s generic per-call wrapper failure ("procedure execution of python-fu-eval failed: ...") classifies as gimp_start_failed, NOT sticky', async () => {
    // The interpreter EXISTS here (unlike the case above) -- this is GIMP's
    // wrapper reporting that some exception was raised INSIDE our own
    // bridge code (a bug in ops.py, a bad batch line, ...), which is not a
    // property of the install and can plausibly succeed on a plain retry.
    const rootDir = mkdtempSync(join(tmpdir(), 'em-gimp-session-'));
    registerCleanup(rootDir);
    let spawnCount = 0;
    const spawn: SpawnFn = () => {
      spawnCount++;
      const { child, emitStderr, emitExit } = makeStubChild();
      setImmediate(() => {
        emitStderr(
          "procedure execution of python-fu-eval failed: NameError: name 'Gimp' is not defined"
        );
        emitExit(1, null);
      });
      return child;
    };
    const { session } = buildSession({ rootDir, spawn });
    await expect(session.call('ping', {})).rejects.toMatchObject({ code: 'gimp_start_failed' });
    expect(spawnCount).toBe(1);

    // NOT sticky: the next call retries a fresh spawn rather than failing fast.
    await expect(session.call('ping', {})).rejects.toMatchObject({ code: 'gimp_start_failed' });
    expect(spawnCount).toBe(2);
  });

  it('classifies on the close event, not exit, so output that arrives in the gap between them is still seen', async () => {
    // The ≥20ms real gap between 'exit' and the late stderr/'close' is
    // deliberate: emitting them all in the same synchronous tick would let
    // an exit-based implementation pass this test by accident (there'd be
    // no actual race to lose). Manually verified this test fails against a
    // reverted, exit-based classification and passes against the current
    // close-based one.
    const rootDir = mkdtempSync(join(tmpdir(), 'em-gimp-session-'));
    registerCleanup(rootDir);
    const spawn: SpawnFn = () => {
      const { child, emitStderr, emitExitEvent, emitCloseEvent } = makeStubChild();
      setImmediate(() => {
        // 'exit' fires first, before the diagnostic text has been delivered
        // at all -- classifying here would see incomplete (or no) output.
        emitExitEvent(1, null);
        setTimeout(() => {
          emitStderr(
            "The batch interpreter 'python-fu-eval' is not available. Batch mode disabled."
          );
          // 'close' fires only once stdio is fully flushed -- classification
          // must wait for THIS event to see the message.
          emitCloseEvent(1);
        }, 20);
      });
      return child;
    };
    const { session } = buildSession({ rootDir, spawn });
    await expect(session.call('ping', {})).rejects.toMatchObject({ code: 'gimp_python_missing' });
  });

  it('classifies via a bounded grace period after exit when close never arrives at all (a surviving child holding stdio open)', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'em-gimp-session-'));
    registerCleanup(rootDir);
    const spawn: SpawnFn = () => {
      const { child, emitStderr, emitExitEvent } = makeStubChild();
      // 'close' is deliberately NEVER emitted here -- simulates a
      // grandchild process still holding the stdio pipes open after the
      // parent itself has exited, so 'close' never fires on this stream.
      setImmediate(() => {
        emitStderr("The batch interpreter 'python-fu-eval' is not available. Batch mode disabled.");
        emitExitEvent(1, null);
      });
      return child;
    };
    const { session } = buildSession({ rootDir, spawn });
    const start = Date.now();
    await expect(session.call('ping', {})).rejects.toMatchObject({ code: 'gimp_python_missing' });
    // Bounded by CLOSE_AFTER_EXIT_GRACE_MS (500ms), nowhere near the real
    // 60s READY_TIMEOUT_MS it would otherwise hang out (and misclassify at
    // the end of, since a timed-out start is gimp_start_failed, not this).
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it('GIMP exiting before ready with an unrelated error classifies as gimp_start_failed', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'em-gimp-session-'));
    registerCleanup(rootDir);
    const spawn: SpawnFn = () => {
      const { child, emitExit } = makeStubChild();
      setImmediate(() => emitExit(1, null));
      return child;
    };
    const { session } = buildSession({ rootDir, spawn });
    await expect(session.call('ping', {})).rejects.toMatchObject({ code: 'gimp_start_failed' });
  });

  it('all calls queued behind a failed START get the REAL start error, not a generic "session restarted", and spawn runs only once', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'em-gimp-session-'));
    registerCleanup(rootDir);
    let spawnCount = 0;
    const spawn: SpawnFn = () => {
      spawnCount++;
      const { child, emitExit } = makeStubChild();
      setImmediate(() => emitExit(1, null)); // never ready; generic exit, NOT sticky
      return child;
    };
    const { session } = buildSession({ rootDir, spawn });

    // All three fired before the first one's #startFresh() has had a chance
    // to fail -- b and c are genuinely QUEUED behind a's failing start, not
    // independent later calls.
    const a = session.call('a', {});
    const b = session.call('b', {});
    const c = session.call('c', {});

    const expectRealCause = (p: Promise<unknown>) =>
      expect(p).rejects.toMatchObject({
        code: 'gimp_start_failed',
        message: expect.stringContaining('before it became ready'),
      });
    await expectRealCause(a);
    await expectRealCause(b);
    await expectRealCause(c);
    expect(spawnCount).toBe(1); // b and c did not each trigger their own relaunch
  });

  it('a fresh start after a crash/timeout removes the stale session dir', async () => {
    const h = harness({ hangOps: new Set(['a']) });
    await expect(h.session.call('a', {}, { timeoutMs: 20 })).rejects.toMatchObject({
      code: 'gimp_timeout',
    });
    const firstSessionDir = h.spawnCalls[0]!.env.EM_GIMP_SESSION!;
    // Not removed at timeout time -- only when the NEXT start actually runs.
    expect(existsSync(firstSessionDir)).toBe(true);

    await h.session.call('ping', {});
    expect(existsSync(firstSessionDir)).toBe(false);
    expect(h.spawnCalls).toHaveLength(2);
  });

  it('#startFresh waits for the stale process to confirm exit (bounded by KILL_CONFIRM_MS) before removing its dir', async () => {
    // The timeout above already fire-and-forget-kills the stale process --
    // that alone does not guarantee it has actually exited by the time the
    // NEXT call's #startFresh runs its own stale-process cleanup. This
    // proves that cleanup waits for a real, delayed exit rather than
    // removing the directory the instant its own kill call returns.
    const rootDir = mkdtempSync(join(tmpdir(), 'em-gimp-session-'));
    const servers: FakeGimpServer[] = [];
    const stubs: Array<ReturnType<typeof makeStubChild>> = [];
    const spawn: SpawnFn = (_c, _a, options) => {
      const env = options.env as Record<string, string>;
      const stub = makeStubChild();
      stubs.push(stub);
      const rpcDir = join(env.EM_GIMP_SESSION, 'rpc');
      writeReady(rpcDir);
      servers.push(new FakeGimpServer(rpcDir, pingOk, new Set(['a'])));
      return stub.child;
    };
    // Only the FIRST kill call schedules the (delayed) real exit -- a
    // second tree-kill against an already-dying process is a realistic
    // no-op, and without this guard the test would race two independent
    // timers against the same stub.
    let exitScheduled = false;
    const killTreeSpy = vi.fn((proc: ChildProcess) => {
      if (exitScheduled) return;
      exitScheduled = true;
      setTimeout(() => {
        (proc as unknown as { exitCode: number | null }).exitCode = 1;
        proc.emit('exit', 1, null);
      }, 20);
    });
    const { session } = buildSession({ rootDir, spawn, killTree: killTreeSpy });
    registerCleanup(rootDir, servers);

    await expect(session.call('a', {}, { timeoutMs: 10 })).rejects.toMatchObject({
      code: 'gimp_timeout',
    });
    const staleSessionDir = (session as unknown as { sessionDir: string }).sessionDir;
    expect(existsSync(staleSessionDir)).toBe(true);
    expect(stubs).toHaveLength(1);

    const resultPromise = session.call<{ op: string }>('open', {});
    await sleep(10); // less than the scheduled 20ms exit -- still mid-confirm-wait
    expect(existsSync(staleSessionDir)).toBe(true); // NOT removed yet -- exit hasn't confirmed
    const result = await resultPromise;
    expect(result).toEqual({ op: 'open' });
    expect(existsSync(staleSessionDir)).toBe(false); // removed only once confirmed
    expect(stubs).toHaveLength(2); // a genuinely fresh process, not a reused one
    expect(killTreeSpy).toHaveBeenCalledTimes(2); // once from the timeout, once from #startFresh's own cleanup
  });

  it('shutdown() issued WHILE #startFresh is in its stale-process kill-confirm wait rejects the pending call with "session closed" and spawns nothing new', async () => {
    // The race this pins: #startFresh's stale-process
    // kill-and-confirm wait can take up to KILL_CONFIRM_MS (2s) before it
    // ever spawns anything new. Without a re-check right after that await,
    // a shutdown() landing during it would be silently overrun: #startFresh
    // would go on to sweep the stale dir, flip state back to 'starting',
    // and spawn a brand new GIMP process that shutdown() never gets a
    // chance to manage (it already returned).
    let calls = 0;
    const now = () => {
      calls++;
      return calls * 100_000; // monotonically past any deadline within one or two reads
    };
    const rootDir = mkdtempSync(join(tmpdir(), 'em-gimp-session-'));
    registerCleanup(rootDir);
    let spawnCount = 0;
    const killTreeSpy = vi.fn(); // never actually makes the stale stub exit
    const spawn: SpawnFn = () => {
      spawnCount++;
      return makeStubChild().child; // never writes ready, never exits on its own
    };
    const { session } = buildSession({ rootDir, spawn, now, killTree: killTreeSpy });

    // First call: readiness times out fast (the injected clock), leaving
    // `this.proc` pointing at a stub that never actually exits (killTreeSpy
    // is a no-op) -- exactly the "stale, still exitCode === null" case
    // #startFresh's cleanup exists for.
    await expect(session.call('ping', {})).rejects.toMatchObject({ code: 'gimp_start_failed' });
    expect(session.state).toBe('dead');
    expect(spawnCount).toBe(1);

    vi.useFakeTimers();
    const secondCall = session.call('ping', {});
    secondCall.catch(() => {});
    // Let #startFresh run synchronously up to (and arm) its kill-and-confirm
    // wait on the stale proc.
    await vi.advanceTimersByTimeAsync(0);
    const shutdownPromise = session.shutdown(); // `shuttingDown` flips synchronously, right now
    // Both #startFresh's stale-kill wait AND shutdown()'s own 'dead'-branch
    // kill-and-confirm wait (on the same never-exiting stub) time out.
    await vi.advanceTimersByTimeAsync(KILL_CONFIRM_MS);
    await shutdownPromise;

    await expect(secondCall).rejects.toMatchObject({
      code: 'gimp_session_restarted',
      message: expect.stringContaining('session closed'),
    });
    expect(session.state).toBe('closed');
    expect(spawnCount).toBe(1); // #startFresh never reached spawnFn() again
  });

  it('captured stdout/stderr is bounded to the last 8 KB', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'em-gimp-session-'));
    registerCleanup(rootDir);
    const spawn: SpawnFn = () => {
      const { child, emitStderr, emitExit } = makeStubChild();
      setImmediate(() => {
        // The sticky-classifying phrase arrives first, then >8 KB of
        // filler. If the cap works, that phrase is evicted from the tail by
        // the time the process exits, so classification falls through to
        // the generic case instead of gimp_python_missing.
        emitStderr(
          "The batch interpreter 'python-fu-eval' is not available. Batch mode disabled.\n"
        );
        emitStderr('x'.repeat(9000));
        emitExit(1, null);
      });
      return child;
    };
    const { session } = buildSession({ rootDir, spawn });
    await expect(session.call('ping', {})).rejects.toMatchObject({ code: 'gimp_start_failed' });
  });

  describe('sticky failures', () => {
    it('gimp_version_unsupported is sticky: later calls fail fast without relaunching', async () => {
      const h = harness({
        responder: (op) => (op === 'ping' ? { major: 3, minor: 0, micro: 0 } : {}),
      });
      await expect(h.session.call('open', {})).rejects.toMatchObject({
        code: 'gimp_version_unsupported',
      });
      expect(h.spawnCalls).toHaveLength(1);

      await expect(h.session.call('open', {})).rejects.toMatchObject({
        code: 'gimp_version_unsupported',
      });
      expect(h.spawnCalls).toHaveLength(1); // no relaunch attempt
    });

    it('a not-found (ENOENT) start failure is sticky: later calls fail fast without relaunching', async () => {
      const rootDir = mkdtempSync(join(tmpdir(), 'em-gimp-session-'));
      registerCleanup(rootDir);
      let spawnCount = 0;
      const spawn: SpawnFn = () => {
        spawnCount++;
        throw Object.assign(new Error('spawn FAKE_GIMP_CONSOLE ENOENT'), { code: 'ENOENT' });
      };
      const { session } = buildSession({ rootDir, spawn });
      await expect(session.call('ping', {})).rejects.toMatchObject({ code: 'gimp_start_failed' });
      expect(spawnCount).toBe(1);

      await expect(session.call('ping', {})).rejects.toMatchObject({ code: 'gimp_start_failed' });
      expect(spawnCount).toBe(1); // still 1 -- no relaunch attempted
    });

    it('a readiness timeout is NOT sticky: the next call retries a fresh spawn', async () => {
      let calls = 0;
      const now = () => {
        calls++;
        return calls * 100_000;
      };
      const rootDir = mkdtempSync(join(tmpdir(), 'em-gimp-session-'));
      registerCleanup(rootDir);
      let spawnCount = 0;
      const spawn: SpawnFn = () => {
        spawnCount++;
        return makeStubChild().child; // never writes ready
      };
      const { session } = buildSession({ rootDir, spawn, now });
      await expect(session.call('ping', {})).rejects.toMatchObject({ code: 'gimp_start_failed' });
      await expect(session.call('ping', {})).rejects.toMatchObject({ code: 'gimp_start_failed' });
      expect(spawnCount).toBe(2); // retried, not sticky
    });
  });

  it('shutdown is idempotent, removes the session dir, and is not logged as a crash', async () => {
    const h = harness();
    await h.session.call('open', {});
    const sessionDir = h.spawnCalls[0]!.env.EM_GIMP_SESSION!;
    expect(existsSync(sessionDir)).toBe(true);

    await h.session.shutdown();
    expect(existsSync(sessionDir)).toBe(false);
    expect(h.session.state).toBe('closed');
    expect(loggedMessageContaining(h.warnSpy, 'unexpectedly')).toBe(false);

    await expect(h.session.shutdown()).resolves.toBeUndefined();
  });

  it('shutdown falls back to tree-kill after the grace window when the process never exits on its own', async () => {
    // Real timers for the ready handshake (the fake server's own poll loop
    // needs real setTimeout to make progress); switch to fake timers only
    // for the grace window itself, which is the part worth not waiting out.
    // killTreeSpy is a no-op here (harness()'s default) -- the stub process
    // never actually exits even after the "kill", so this also exercises
    // the post-kill confirmation wait (KILL_CONFIRM_MS) before shutdown()
    // gives up and removes the dir anyway.
    const h = harness({ respondToShutdown: false });
    await h.session.call('ping', {});

    vi.useFakeTimers();
    const shutdownPromise = h.session.shutdown();
    await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS);
    await vi.advanceTimersByTimeAsync(KILL_CONFIRM_MS);
    await shutdownPromise;

    expect(h.killTreeSpy).toHaveBeenCalled();
    expect(h.session.state).toBe('closed');
    expect(loggedMessageContaining(h.warnSpy, 'did not confirm exit')).toBe(true);
  });

  it('#shutdownOnce never removes the session dir before the process actually confirms exit (it waits for exited, not just the tree-kill call)', async () => {
    // Unlike the test above, killTreeSpy HERE actually causes the stub to
    // exit (after a short delay) -- proving the dir removal waits for that
    // real exit rather than firing immediately once killTreeFn returns
    // (tree-kill is fire-and-forget; it does not itself guarantee the
    // process is gone by the time it returns).
    const rootDir = mkdtempSync(join(tmpdir(), 'em-gimp-session-'));
    const servers: FakeGimpServer[] = [];
    let stub: ReturnType<typeof makeStubChild> | undefined;
    const spawn: SpawnFn = (_c, _a, options) => {
      const env = options.env as Record<string, string>;
      stub = makeStubChild();
      const rpcDir = join(env.EM_GIMP_SESSION, 'rpc');
      writeReady(rpcDir);
      servers.push(new FakeGimpServer(rpcDir, pingOk, new Set(), undefined));
      return stub.child;
    };
    const killTreeSpy = vi.fn(() => {
      setTimeout(() => stub!.emitExit(0, null), 10);
    });
    const { session } = buildSession({ rootDir, spawn, killTree: killTreeSpy });
    registerCleanup(rootDir, servers);
    await session.call('ping', {});

    const sessionDir = (session as unknown as { sessionDir: string }).sessionDir;
    vi.useFakeTimers();
    const shutdownPromise = session.shutdown();
    await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS); // grace expires -> tree-kill fires
    await vi.advanceTimersByTimeAsync(10); // the delayed exit from killTreeSpy fires
    await shutdownPromise;

    expect(killTreeSpy).toHaveBeenCalledTimes(1);
    expect(existsSync(sessionDir)).toBe(false);
    expect(session.state).toBe('closed');
  });

  it('a timed-out call, then shutdown() (which waits for that SAME stale process to confirm exit), then it exits a bit LATER: no crash logged, dir removed only once confirmed, state closed', async () => {
    // Regression for the 'dead' branch of #shutdownOnce, which used to
    // delete the session dir immediately on seeing sessionState === 'dead',
    // without ever killing or waiting for the (possibly still-alive)
    // process, and without setting `shuttingDown` at all.
    const rootDir = mkdtempSync(join(tmpdir(), 'em-gimp-session-'));
    const servers: FakeGimpServer[] = [];
    let stub: ReturnType<typeof makeStubChild> | undefined;
    const spawn: SpawnFn = (_c, _a, options) => {
      const env = options.env as Record<string, string>;
      stub = makeStubChild();
      const rpcDir = join(env.EM_GIMP_SESSION, 'rpc');
      writeReady(rpcDir);
      servers.push(new FakeGimpServer(rpcDir, pingOk, new Set(['slow'])));
      return stub.child;
    };
    // Only the FIRST kill call (the timeout's own) schedules the delayed
    // real exit -- shutdown()'s own redundant kill against the same
    // already-dying process is a no-op here, matching the same guard used
    // for #startFresh's stale-process cleanup test above.
    let exitScheduled = false;
    const killTreeSpy = vi.fn(() => {
      if (exitScheduled) return;
      exitScheduled = true;
      setTimeout(() => stub!.emitExit(0, null), 40);
    });
    const logger = new Logger('test');
    const warnSpy = vi.spyOn(logger, 'warn');
    const { session } = buildSession({ rootDir, spawn, killTree: killTreeSpy, logger });
    registerCleanup(rootDir, servers);
    await session.call('ping', {});

    await expect(session.call('slow', {}, { timeoutMs: 10 })).rejects.toMatchObject({
      code: 'gimp_timeout',
    });
    expect(session.state).toBe('dead');

    const sessionDir = (session as unknown as { sessionDir: string }).sessionDir;
    const shutdownPromise = session.shutdown();
    await sleep(20); // less than the scheduled 40ms exit -- the confirm-wait hasn't resolved yet
    expect(existsSync(sessionDir)).toBe(true); // NOT removed yet -- exit hasn't confirmed
    await shutdownPromise;

    expect(existsSync(sessionDir)).toBe(false); // removed only once confirmed
    expect(session.state).toBe('closed');
    expect(loggedMessageContaining(warnSpy, 'unexpectedly')).toBe(false); // never logged as a fresh crash

    await expect(session.call('ping', {})).rejects.toMatchObject({
      code: 'gimp_session_restarted',
      message: expect.stringContaining('session closed'),
    });
  });

  it('an in-flight #send racing a graceful shutdown() does not resurrect state back to dead', async () => {
    // #markDead is guarded against moving a 'closed' session back to
    // 'dead', and #send itself skips #markDead once shuttingDown is set --
    // this exercises both together against a call that was ALREADY polling
    // for a response when shutdown() started.
    const h = harness({ hangOps: new Set(['slow']) }); // respondToShutdown: true (default)
    await h.session.call('ping', {});

    const hanging = h.session.call('slow', {});
    hanging.catch(() => {}); // attached now so the eventual rejection below is never "unhandled"

    await sleep(10); // let #send actually start polling for slow's response
    await h.session.shutdown(); // graceful: writes rpc/shutdown, the fake server exits the stub in response

    // The hanging call notices the process exit itself (#send's own
    // exitCode check), not #dispatch's "session closed" entry guard -- it
    // gets the generic restarted message, since from #send's position this
    // reads like any other process-went-away case.
    await expect(hanging).rejects.toMatchObject({ code: 'gimp_session_restarted' });

    expect(h.session.state).toBe('closed'); // not 'dead'
    await expect(h.session.call('ping', {})).rejects.toMatchObject({
      code: 'gimp_session_restarted',
      message: expect.stringContaining('session closed'),
    });
    expect(h.spawnCalls).toHaveLength(1); // no relaunch
  });

  it('call() after shutdown() rejects with gimp_session_restarted "session closed" and never relaunches', async () => {
    const h = harness();
    await h.session.call('ping', {});
    await h.session.shutdown();
    expect(h.session.state).toBe('closed');

    await expect(h.session.call('ping', {})).rejects.toMatchObject({
      code: 'gimp_session_restarted',
      message: expect.stringContaining('session closed'),
    });
    expect(h.spawnCalls).toHaveLength(1); // no relaunch after close
  });

  it('call() issued WHILE shutdown() is in progress rejects with "session closed", spawns nothing new, and leaves no process running', async () => {
    const h = harness(); // respondToShutdown: true (default) -- the stub exits gracefully
    await h.session.call('ping', {});

    const shutdownPromise = h.session.shutdown();
    // Issued in the same tick shutdown() started -- `shuttingDown` is set
    // synchronously before shutdown() awaits anything, so this is a genuine
    // race against an in-progress shutdown, not a call after it's finished.
    const racedCall = h.session.call('ping', {});
    // Attached immediately (synchronously): racedCall can settle before
    // `await shutdownPromise` below ever yields back to it, and Node flags
    // a promise that rejects before anything is listening as "unhandled"
    // even though the `.rejects` assertion further down handles it a tick
    // later -- a second handler on the same promise is fine.
    racedCall.catch(() => {});

    await shutdownPromise;
    await expect(racedCall).rejects.toMatchObject({
      code: 'gimp_session_restarted',
      message: expect.stringContaining('session closed'),
    });
    expect(h.spawnCalls).toHaveLength(1); // the racing call spawned nothing new
    expect(h.session.state).toBe('closed');
  });

  it('orphan sweep removes only dirs that are both dead AND older than 24h', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'em-gimp-session-'));
    const dayMs = 24 * 60 * 60 * 1000;
    const oldTime = new Date(Date.now() - dayMs - 1000);
    const recentTime = new Date();

    // Naming matches the real one: session-<pid>-<mkdtemp random suffix>.
    const deadAndOld = join(rootDir, 'session-999999999-aaaaaa');
    const aliveAndOld = join(rootDir, `session-${process.pid}-bbbbbb`);
    const deadButRecent = join(rootDir, 'session-999999998-cccccc');
    const notOurPattern = join(rootDir, 'unrelated-dir');
    for (const dir of [deadAndOld, aliveAndOld, deadButRecent, notOurPattern]) {
      mkdirSync(dir, { recursive: true });
    }
    utimesSync(deadAndOld, oldTime, oldTime);
    utimesSync(aliveAndOld, oldTime, oldTime);
    utimesSync(deadButRecent, recentTime, recentTime);

    const servers: FakeGimpServer[] = [];
    const spawn: SpawnFn = (_c, _a, options) => {
      const env = options.env as Record<string, string>;
      const { child } = makeStubChild();
      const rpcDir = join(env.EM_GIMP_SESSION, 'rpc');
      writeReady(rpcDir);
      servers.push(new FakeGimpServer(rpcDir, pingOk));
      return child;
    };
    const { session } = buildSession({ rootDir, spawn });
    registerCleanup(rootDir, servers);
    await session.call('open', {});

    expect(existsSync(deadAndOld)).toBe(false); // dead + old -> removed
    expect(existsSync(aliveAndOld)).toBe(true); // alive (our own pid) -> kept regardless of age
    expect(existsSync(deadButRecent)).toBe(true); // dead but not old enough -> kept
    expect(existsSync(notOurPattern)).toBe(true); // doesn't match the naming pattern -> untouched
  });

  describe('#ensureRootDir POSIX ownership/writability check', () => {
    // This dev/CI machine is Windows, where the check is a no-op by design
    // (see the win32-skip test below) — `platform`/`getuid`/`statRootDir`
    // are exactly the seam that lets the POSIX branch run for real anyway,
    // rather than staying reviewed-but-never-executed.
    function posixHarness(opts: {
      platform?: string;
      getuid?: () => number | undefined;
      statRootDir?: (path: string) => { uid: number; mode: number };
    }): {
      session: GimpSession;
      chmodRootDir: ReturnType<typeof vi.fn>;
      getSpawnCalls: () => number;
    } {
      const rootDir = mkdtempSync(join(tmpdir(), 'em-gimp-root-'));
      registerCleanup(rootDir);
      let spawnCalls = 0;
      const spawn: SpawnFn = (_c, _a, options) => {
        spawnCalls++;
        const env = options.env as Record<string, string>;
        const { child } = makeStubChild();
        const rpcDir = join(env.EM_GIMP_SESSION, 'rpc');
        writeReady(rpcDir);
        new FakeGimpServer(rpcDir, pingOk);
        return child;
      };
      const chmodRootDir = vi.fn();
      const { session } = buildSession({
        rootDir,
        spawn,
        platform: opts.platform ?? 'darwin',
        getuid: opts.getuid ?? (() => 1000),
        statRootDir: opts.statRootDir ?? (() => ({ uid: 1000, mode: 0o755 })),
        chmodRootDir,
      });
      return { session, chmodRootDir, getSpawnCalls: () => spawnCalls };
    }

    it('refuses a root owned by a different uid', async () => {
      const h = posixHarness({
        getuid: () => 1000,
        statRootDir: () => ({ uid: 2000, mode: 0o700 }),
      });
      await expect(h.session.call('ping', {})).rejects.toMatchObject({
        code: 'gimp_start_failed',
        message: expect.stringContaining('owned by a different user'),
      });
      expect(h.getSpawnCalls()).toBe(0); // refused before ever spawning GIMP
    });

    it('refuses a group-writable root (mode 0o770)', async () => {
      const h = posixHarness({ statRootDir: () => ({ uid: 1000, mode: 0o770 }) });
      await expect(h.session.call('ping', {})).rejects.toMatchObject({
        code: 'gimp_start_failed',
        message: expect.stringContaining('group- or other-writable'),
      });
      expect(h.getSpawnCalls()).toBe(0);
    });

    it('refuses an other-writable root (mode 0o707)', async () => {
      const h = posixHarness({ statRootDir: () => ({ uid: 1000, mode: 0o707 }) });
      await expect(h.session.call('ping', {})).rejects.toMatchObject({
        code: 'gimp_start_failed',
        message: expect.stringContaining('group- or other-writable'),
      });
      expect(h.getSpawnCalls()).toBe(0);
    });

    it('accepts a root owned by us with mode 0o755, and chmods it to 0o700', async () => {
      const h = posixHarness({ statRootDir: () => ({ uid: 1000, mode: 0o755 }) });
      await h.session.call('ping', {});
      expect(h.session.state).toBe('ready');
      expect(h.chmodRootDir).toHaveBeenCalledWith(expect.any(String), 0o700);
    });

    it('skips the check entirely on win32', async () => {
      const h = posixHarness({
        platform: 'win32',
        getuid: () => {
          throw new Error('getuid must not be called on win32');
        },
        statRootDir: () => {
          throw new Error('statRootDir must not be called on win32');
        },
      });
      await h.session.call('ping', {});
      expect(h.session.state).toBe('ready');
      expect(h.chmodRootDir).not.toHaveBeenCalled();
    });
  });

  describe('#readResponse (the response-file read/parse hardening)', () => {
    it('retries EBUSY on the response read then succeeds', async () => {
      let attempts = 0;
      const readRespFile = vi.fn((path: string) => {
        attempts++;
        if (attempts <= 2) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        return readFileSync(path, 'utf8');
      });
      const h = harness({ extra: { readRespFile } });
      const result = await h.session.call<{ op: string }>('open', {});
      expect(result).toEqual({ op: 'open' });
      expect(attempts).toBeGreaterThanOrEqual(3); // 2 retries + the eventual success
    });

    it('retries EPERM on the response read then succeeds', async () => {
      let attempts = 0;
      const readRespFile = vi.fn((path: string) => {
        attempts++;
        if (attempts <= 2) throw Object.assign(new Error('no access'), { code: 'EPERM' });
        return readFileSync(path, 'utf8');
      });
      const h = harness({ extra: { readRespFile } });
      const result = await h.session.call<{ op: string }>('open', {});
      expect(result).toEqual({ op: 'open' });
      expect(attempts).toBeGreaterThanOrEqual(3); // 2 retries + the eventual success
    });

    it('gives up after exhausting EBUSY retries and throws GimpError gimp_op_failed (not the raw fs error)', async () => {
      const readRespFile = vi.fn(() => {
        throw Object.assign(new Error('busy forever'), { code: 'EBUSY' });
      });
      const h = harness({ extra: { readRespFile } });
      let caught: unknown;
      try {
        await h.session.call('ping', {});
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(GimpError);
      expect((caught as GimpError).code).toBe('gimp_op_failed');
    });

    it('a non-retryable read error becomes GimpError immediately (not the raw fs error, and no retry)', async () => {
      const readRespFile = vi.fn(() => {
        throw Object.assign(new Error('nope'), { code: 'EACCES' });
      });
      const h = harness({ extra: { readRespFile } });
      let caught: unknown;
      try {
        await h.session.call('ping', {});
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(GimpError);
      expect((caught as GimpError).code).toBe('gimp_op_failed');
      expect(readRespFile).toHaveBeenCalledTimes(1);
    });

    it('a response that reads fine but is not valid JSON becomes GimpError gimp_op_failed', async () => {
      const readRespFile = vi.fn(() => '{not json');
      const h = harness({ extra: { readRespFile } });
      await expect(h.session.call('ping', {})).rejects.toMatchObject({ code: 'gimp_op_failed' });
    });

    it('a JSON "null" response becomes GimpError instead of crashing on raw.ok', async () => {
      const readRespFile = vi.fn(() => 'null');
      const h = harness({ extra: { readRespFile } });
      await expect(h.session.call('ping', {})).rejects.toMatchObject({ code: 'gimp_op_failed' });
    });

    it('a JSON array response (well-formed JSON, wrong shape) becomes GimpError gimp_op_failed', async () => {
      const readRespFile = vi.fn(() => '[1,2,3]');
      const h = harness({ extra: { readRespFile } });
      await expect(h.session.call('ping', {})).rejects.toMatchObject({ code: 'gimp_op_failed' });
    });
  });

  describe('copyToLatestPreview', () => {
    it('creates the root via #ensureRootDir (locked to 0o700) and writes the preview via tmp+rename', () => {
      const scratch = mkdtempSync(join(tmpdir(), 'em-gimp-preview-src-'));
      registerCleanup(scratch);
      const rootParent = mkdtempSync(join(tmpdir(), 'em-gimp-preview-root-'));
      registerCleanup(rootParent);
      const rootDir = join(rootParent, 'gimp-root'); // deliberately does not exist yet

      const chmodRootDir = vi.fn();
      const { session } = buildSession({
        rootDir,
        spawn: () => makeStubChild().child,
        platform: 'darwin',
        getuid: () => 1000,
        statRootDir: () => ({ uid: 1000, mode: 0o700 }),
        chmodRootDir,
      });

      const srcFile = join(scratch, 'preview-src.jpg');
      writeFileSync(srcFile, 'fake-jpeg-bytes');

      session.copyToLatestPreview(srcFile);

      expect(existsSync(session.latestPreviewPath())).toBe(true);
      expect(readFileSync(session.latestPreviewPath(), 'utf8')).toBe('fake-jpeg-bytes');
      expect(existsSync(`${session.latestPreviewPath()}.tmp`)).toBe(false); // renamed away, not left behind
      expect(chmodRootDir).toHaveBeenCalledWith(rootDir, 0o700); // went through the checked #ensureRootDir path
    });
  });

  describe('tempPath', () => {
    it('returns a path inside the root dir, ensuring (and locking down) that dir first, even before any session has ever started', () => {
      const rootParent = mkdtempSync(join(tmpdir(), 'em-gimp-temppath-root-'));
      registerCleanup(rootParent);
      const rootDir = join(rootParent, 'gimp-root'); // deliberately does not exist yet

      const chmodRootDir = vi.fn();
      const { session } = buildSession({
        rootDir,
        spawn: () => makeStubChild().child,
        platform: 'darwin',
        getuid: () => 1000,
        statRootDir: () => ({ uid: 1000, mode: 0o700 }),
        chmodRootDir,
      });

      const path = session.tempPath('compare-before-abc123.jpg');

      expect(path).toBe(join(rootDir, 'compare-before-abc123.jpg'));
      expect(existsSync(rootDir)).toBe(true); // #ensureRootDir ran
      expect(chmodRootDir).toHaveBeenCalledWith(rootDir, 0o700);
    });

    it('two different names resolve under the same root, without starting a session', () => {
      const rootParent = mkdtempSync(join(tmpdir(), 'em-gimp-temppath-root2-'));
      registerCleanup(rootParent);
      const rootDir = join(rootParent, 'gimp-root');
      const spawn = vi.fn(() => makeStubChild().child);
      const { session } = buildSession({ rootDir, spawn });

      expect(session.tempPath('a.jpg')).toBe(join(rootDir, 'a.jpg'));
      expect(session.tempPath('b.pgm')).toBe(join(rootDir, 'b.pgm'));
      expect(spawn).not.toHaveBeenCalled(); // building a temp path never starts GIMP
    });
  });

  describe('Flatpak parent-death-check omission', () => {
    const FLATPAK_INSTALL: GimpInstall = {
      source: 'flatpak',
      path: '/var/lib/flatpak/app/org.gimp.GIMP',
      launch: { command: 'flatpak', args: ['run', '--command=gimp-console-3.2', 'org.gimp.GIMP'] },
    };

    it('omits EM_GIMP_PARENT_PID for a Flatpak launch spec', async () => {
      const rootDir = mkdtempSync(join(tmpdir(), 'em-gimp-session-'));
      registerCleanup(rootDir);
      let capturedEnv: Record<string, string | undefined> = {};
      const spawn: SpawnFn = (_c, _a, options) => {
        capturedEnv = options.env as Record<string, string | undefined>;
        const { child } = makeStubChild();
        const rpcDir = join(capturedEnv.EM_GIMP_SESSION!, 'rpc');
        writeReady(rpcDir);
        new FakeGimpServer(rpcDir, pingOk);
        return child;
      };
      const { session } = buildSession({ install: FLATPAK_INSTALL, rootDir, spawn });
      await session.call('ping', {});
      expect(capturedEnv.EM_GIMP_PARENT_PID).toBeUndefined();
      expect(capturedEnv.EM_GIMP_SESSION).toBeDefined(); // sanity: env was actually captured
    });

    it('includes EM_GIMP_PARENT_PID for a non-Flatpak launch spec', async () => {
      const h = harness();
      await h.session.call('ping', {});
      expect(h.spawnCalls[0]!.env.EM_GIMP_PARENT_PID).toBe(String(process.pid));
    });
  });
});
