/**
 * Drives one headless `gimp-console` process: a single warm GIMP, started
 * lazily on the first call, serving named operations over JSON request/
 * response files — see `bridge/ops.py`'s file header for the transport this
 * mirrors.
 *
 * Model-supplied values only ever travel inside request/response JSON files;
 * the only text handed to GIMP on its command line is `BATCH_LINE`, a fixed
 * constant that never varies with user input — the two paths GIMP needs
 * (`ops.py`, the session dir) travel through the environment instead
 * (`EM_GIMP_OPS`, `EM_GIMP_SESSION`), which sidesteps ever having to quote a
 * path into a Python string literal (a real Windows username may contain an
 * apostrophe, which breaks naive `'...'`-quoting).
 */

import {
  spawn as nodeSpawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Logger } from '../../utils/logger.js';
import { userOwnedTempRoot } from '../../utils/temp.js';
import { GimpError, GIMP_ERROR_CODES, type GimpErrorCode } from './errors.js';
import type { GimpInstall } from './detect.js';

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess;

export type GimpSessionState = 'idle' | 'starting' | 'ready' | 'dead' | 'closed';

export interface GimpSessionOptions {
  readonly install: GimpInstall;
  /** Parent of every per-process session dir. Default a per-user private cache dir (see `defaultRootDir`). */
  rootDir?: string;
  /** Injected for tests — a fake, EventEmitter-backed `ChildProcess`. */
  spawn?: SpawnFn;
  /**
   * Injected WALL clock (tests) — real epoch ms, the only thing `#sweepOrphans`
   * compares against (a file's real `mtimeMs`). Defaults to `Date.now`. NOT
   * used for any deadline/cap computation — see `nowMonotonic`.
   */
  now?: () => number;
  /**
   * Injected MONOTONIC clock (tests) — backs every deadline/cap computation:
   * `call()`'s `issuedAt`, `#joinOrStart`'s `CALL_READY_WAIT_MS` cap,
   * `#waitForReady`'s `READY_TIMEOUT_MS` deadline, and `#send`'s per-op
   * timeout. Defaults to `performance.now()`, deliberately NOT `Date.now`:
   * a wall clock can jump backward (an NTP correction, a manual clock set),
   * which would make a deadline never trip, and forward by a large amount
   * across a system suspend, which would make one trip instantly on wake
   * and kill a healthy, still-starting GIMP. `performance.now()` is
   * monotonic, so it never runs backward. On macOS and Linux it also stops
   * while the machine is suspended; on Windows it keeps counting through a
   * suspend, so a laptop that sleeps mid-start can still trip the deadline
   * on wake there.
   */
  nowMonotonic?: () => number;
  logger?: Logger;
  /**
   * Injected tree-kill (tests assert it was called rather than exercising a
   * real `taskkill`/`process.kill(-pid, ...)` against a fake pid). Defaults
   * to `defaultTreeKill`.
   */
  killTree?: (proc: ChildProcess) => void;
  /**
   * Injected for tests — the POSIX-only ownership/writability check in
   * `#ensureRootDir` runs on macOS/Linux only, so these seams are what make
   * that branch testable on a Windows machine.
   * Defaults to the real values.
   */
  platform?: string;
  /** Defaults to `() => process.getuid?.()` (always `undefined` on Windows). */
  getuid?: () => number | undefined;
  /** Defaults to a real `fs.statSync`-based `{uid, mode}` lookup. */
  statRootDir?: (path: string) => { uid: number; mode: number };
  /** Defaults to the real `fs.chmodSync`. */
  chmodRootDir?: (path: string, mode: number) => void;
  /** Defaults to a real `fs.readFileSync(path, 'utf8')`. Injected so the response-read retry/error paths are testable without faking OS-level file locks. */
  readRespFile?: (path: string) => string;
  /**
   * The bridge script GIMP runs (`EM_GIMP_OPS`). Defaults to `resolveOpsPyPath()`, the copy next
   * to this module. Tests point it at the built `dist/` copy, or at a wrapper that loads the real
   * bridge and adds test-only ops.
   */
  opsPyPath?: string;
}

interface PingResult {
  major: number;
  minor: number;
  micro: number;
}

/**
 * Overall deadline for ONE start attempt (spawn through ready+ping) — long
 * enough to cover a first-ever launch on a machine doing one-time setup
 * (font cache, plug-in scan, Gatekeeper on macOS can each add tens of
 * seconds). NOT the bound any single MCP call waits on — see
 * `CALL_READY_WAIT_MS` — because an MCP client commonly cuts a request off
 * around 60s, well inside this window.
 */
export const READY_TIMEOUT_MS = 180_000;
/**
 * How long a single call will wait for an in-flight start (fresh or joined)
 * before giving up on THIS call and reporting `gimp_starting` — deliberately
 * shorter than `READY_TIMEOUT_MS` and than a typical MCP client's own request
 * timeout. Rest of a cold `gimp_ping`'s worst case, on top of this wait: up
 * to ~2s of stale-process kill-confirm before a start even begins, and, once
 * ready, the OUTER ping RPC itself — which runs on whatever's left of the
 * calling tool's own budget (`GimpBackend.call()`, `operation-timeouts.ts`),
 * NOT `PING_TIMEOUT_MS` (that only bounds `#startFresh`'s own EARLIER,
 * internal bootstrap ping, a separate RPC). `GimpBackend.call()` also runs
 * its one-time boot-timeout `maybeRedetect()` retry before any of this
 * clock starts ticking, adding a further, one-time cost on top. Still
 * comfortably inside a ~60s client timeout. The start itself is NOT
 * cancelled when this elapses: it keeps running in the background
 * (`#startPromise` stays assigned), so the next call joins the SAME attempt
 * instead of tree-killing a half-started GIMP and throwing away whatever
 * first-launch work it already did.
 */
export const CALL_READY_WAIT_MS = 30_000;
const PING_TIMEOUT_MS = 10_000;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
export const SHUTDOWN_GRACE_MS = 5_000;
/**
 * After a tree-kill during shutdown, how much longer to wait for the actual
 * `exit` event before giving up and removing the session dir anyway. A
 * tree-kill call (real `taskkill`/`process.kill(-pid, ...)`) is
 * fire-and-forget — it does not guarantee the process has exited by the
 * time it returns — so this is what stands between "kill requested" and
 * "safe to delete the directory GIMP might still have files open in."
 */
export const KILL_CONFIRM_MS = 2_000;
/**
 * Pre-ready exit classification normally waits for 'close' (stdio fully
 * flushed) rather than 'exit', so it reads complete output — but a child
 * that survives its parent's exit while still holding the stdio pipes open
 * (e.g. a grandchild process GIMP spawned) means 'close' may never fire at
 * all. This bounds how long 'exit' alone waits for 'close' to show up before
 * classifying with whatever output was captured by then.
 */
const CLOSE_AFTER_EXIT_GRACE_MS = 500;
const ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 2;
const MAX_CAPTURED_OUTPUT = 8 * 1024;
const RESP_READ_RETRY_ATTEMPTS = 5;
const RESP_READ_RETRY_DELAY_MS = 20;

const KNOWN_ERROR_CODES = new Set<GimpErrorCode>(GIMP_ERROR_CODES);

const LOST_WORK =
  'every open image and unsaved filter is gone — reopen the file with gimp_open_document';
const RESTARTED_MESSAGE = `GIMP stopped; ${LOST_WORK}`;

/**
 * True once `proc` has exited for any reason. Node leaves `exitCode` null when the child was
 * killed by a signal (a crash handler, an OOM kill) and sets `signalCode` instead, so checking
 * `exitCode` alone misses exactly the crashes a POSIX host sees.
 */
export function hasExited(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null;
}

/**
 * The ONE string ever passed to `-b`. It carries no path, no username, no
 * anything model- or user-supplied — it just reads two env vars and hands
 * off to the bridge's `serve()`, which loops until told to stop. Because this
 * is a constant, there is no quoting rule to get wrong; the two real paths
 * (`ops.py`, the session dir) travel via `env` below instead. Env vars set
 * on the child process do reach `python-fu-eval`, including values that
 * contain apostrophes.
 */
export const BATCH_LINE =
  "import os; g = {}; exec(open(os.environ['EM_GIMP_OPS'], encoding='utf-8').read(), g); g['serve'](os.environ['EM_GIMP_SESSION'])";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the bridge's `ops.py`. `scripts/copy-gimp-bridge.ts` stages
 * `src/backends/gimp/bridge/*.py` to `dist/backends/gimp/bridge/*.py` — the
 * same relative offset from THIS module's own directory in both places
 * (`src/backends/gimp/` under vitest, `dist/backends/gimp/` at runtime), so a
 * single `join(HERE, 'bridge', 'ops.py')` resolves correctly either way with
 * no dev/prod branch.
 */
export function resolveOpsPyPath(): string {
  return join(HERE, 'bridge', 'ops.py');
}

/** `<per-user private cache dir>/gimp` — never `os.tmpdir()`, which is world-readable/writable on POSIX. */
export function defaultRootDir(): string {
  return join(userOwnedTempRoot(), 'gimp');
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isEnoentError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

function isRetryableReadError(err: unknown): boolean {
  const code =
    typeof err === 'object' && err !== null ? (err as { code?: string }).code : undefined;
  return code === 'EBUSY' || code === 'EPERM';
}

/**
 * GIMP's batch-interpreter SELECTION failing outright (Python support isn't
 * compiled into this GIMP build at all, so the "python-fu-eval" interpreter
 * is never registered) is the ONLY signal that should classify as
 * gimp_python_missing. GIMP's generic per-call wrapper — "procedure
 * execution of python-fu-eval failed: <any exception from OUR bridge
 * code>" — means the interpreter DOES exist and something else went wrong (a
 * bug in ops.py, a bad batch line, ...); that must NOT be sticky, since
 * fixing the underlying cause (or just retrying) can succeed against the
 * exact same install.
 *
 * These three strings are GIMP's real wording, extracted from
 * `gimp-console-3.exe` 3.2.6 (with `%s` substituted for `python-fu-eval`,
 * the only interpreter this bridge ever selects):
 *   "The batch interpreter '%s' is not available. Batch mode disabled."
 *   "No batch interpreters are available. Batch mode disabled."
 *   "The procedure '%s' is not a valid batch interpreter."
 * Not exercised against an actual Python-less GIMP build (every install
 * reachable while building this bundled its own Python) — the strings
 * themselves come straight from the binary, not from documentation.
 */
const PYTHON_INTERPRETER_MISSING_RE =
  /The batch interpreter '[^']*' is not available\. Batch mode disabled\.|No batch interpreters are available\. Batch mode disabled\.|The procedure '[^']*' is not a valid batch interpreter\./;

/**
 * The real tree-kill: Windows `taskkill /PID <pid> /T /F` (kills the whole
 * process tree — GIMP starts a script-fu extension child of its own);
 * POSIX `process.kill(-pid, 'SIGKILL')` against the process GROUP (the
 * session is spawned `detached: true` there for exactly this), falling back
 * to killing just the one process if group-kill isn't available.
 */
export function defaultTreeKill(proc: ChildProcess): void {
  if (hasExited(proc) || proc.pid === undefined) return; // already exited
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try {
    process.kill(-proc.pid, 'SIGKILL');
  } catch {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

export class GimpSession {
  private readonly install: GimpInstall;
  private readonly rootDir: string;
  private readonly spawnFn: SpawnFn;
  /** Wall clock — `#sweepOrphans` only. See the `now` option's doc comment. */
  private readonly clock: () => number;
  /** Monotonic clock — every deadline/cap computation. See the `nowMonotonic` option's doc comment. */
  private readonly monotonicClock: () => number;
  private readonly logger: Logger;
  private readonly killTreeFn: (proc: ChildProcess) => void;
  private readonly platform: string;
  private readonly getuid: () => number | undefined;
  private readonly statRootDir: (path: string) => { uid: number; mode: number };
  private readonly chmodRootDir: (path: string, mode: number) => void;
  private readonly readRespFile: (path: string) => string;
  private readonly opsPyPath: string;

  private sessionState: GimpSessionState = 'idle';
  private version: string | undefined;

  private proc: ChildProcess | undefined;
  private sessionDir: string | undefined;
  private rpcDir: string | undefined;
  private output = '';
  private nextId = 1;
  private queue: Promise<void> = Promise.resolve();
  /** Bumped every time a running session dies unexpectedly (crash or our own timeout kill). */
  private deadGeneration = 0;
  private sweepDone = false;
  /**
   * The currently in-flight `#startFresh()` attempt, if one is running —
   * `#joinOrStart` is the ONLY place this is set or read. A call that finds
   * one already here JOINS it (awaits the same promise, capped at
   * `CALL_READY_WAIT_MS`) instead of starting a second, competing attempt.
   * Cleared once the attempt it points at settles, whichever way, so the
   * NEXT start begins a fresh attempt rather than reusing a stale one.
   */
  private startPromise: Promise<void> | undefined;
  /**
   * Set once this session ever reaches 'ready', and never unset — what
   * `startOrigin` is actually derived from. `sessionState` alone can't tell
   * "first launch" apart from "recovering from a crash": a first launch that
   * hit the 180s deadline (or crashed before ever becoming ready) leaves
   * `sessionState` at 'dead'/'starting' exactly the same way a crash AFTER
   * a successful launch does. Whether this instance was EVER ready is the
   * one fact that actually distinguishes them.
   */
  private everReady = false;
  /**
   * How this current (or most recently settled) start attempt began: 'cold'
   * when this session has never reached 'ready' before (including a first
   * launch that is merely slow, or one that failed outright before ever
   * connecting); 'restarted' once it has (recovering from a crash, a
   * timeout kill, or simply restarting a previously-'ready' session). Set
   * at the very top of `#startFresh` from `everReady`, before anything else
   * in that attempt can run. Read via `lastStartOrigin` by `gimp_ping`
   * (through `GimpBackend.startOrigin`) so a caller capped at
   * `gimp_starting` — or one that just watched a `starting` session finish
   * becoming ready again — can tell "first launch" apart from "recovering
   * from a crash".
   */
  private startOrigin: 'cold' | 'restarted' | undefined;
  /**
   * A start-attempt failure nobody was actually watching when it happened —
   * every call that had been waiting on it had already given up with its
   * own `gimp_starting` (see `activeWaiters`), so nobody ever saw the REAL
   * cause. Stashed here so the NEXT call surfaces it once, instead of
   * quietly kicking off (and likely re-timing-out on) a brand new attempt
   * that would just report `gimp_starting` all over again, forever, with
   * the actual cause (a crash, the 180s deadline, ...) never reaching
   * anyone. Cleared the instant a call reads it.
   */
  private unobservedStartFailure: GimpError | undefined;
  /**
   * How many calls are CURRENTLY inside `#joinOrStart`'s own race against
   * the in-flight attempt, waiting to see whether IT resolves first or
   * their own `CALL_READY_WAIT_MS` cap does. Read by the attempt's
   * rejection handler (registered before any waiter's own race arm — see
   * the ordering comment in `#joinOrStart`) to decide whether a failure was
   * actually seen by somebody, or needs to be stashed in
   * `unobservedStartFailure` instead.
   */
  private activeWaiters = 0;
  /**
   * Set when a session that was once ready comes back up after dying (a crash or a timeout
   * kill), until the caller has been told or has opened an image again. Image ids belong to the
   * GIMP process, so every id the caller holds died with it; without this, the first call after
   * the restart fails with a bare "no open image with id N" that says nothing about why.
   */
  private restartNoticePending = false;
  private shutdownPromise: Promise<void> | undefined;
  private shuttingDown = false;
  /**
   * Set once for a failure class that will never resolve itself by
   * relaunching (an unsupported GIMP version; the configured binary not
   * existing at all). Every call after that fails fast with the SAME error
   * instead of paying a ~5s cold-start attempt that is certain to repeat it.
   * A readiness timeout is deliberately NOT sticky — that can be transient
   * host load, so the next call is allowed to try again.
   */
  private stickyError: GimpError | undefined;
  /**
   * The real cause of the most recent death, whatever it was. Read by
   * `#dispatch` for a call that's stale-generation (in-flight or queued
   * behind the death, per the generation comment on `call()` above): a
   * failure during a START (never reached 'ready') sets this to the SPECIFIC
   * classified error (python missing, exited before ready, ready-timeout,
   * ...) so those calls get the real cause instead of the generic
   * "session restarted" wording, which is reserved for a session that WAS
   * ready and then died mid-flight (set with no argument to `#markDead`).
   */
  private lastFailure: GimpError = new GimpError('gimp_session_restarted', RESTARTED_MESSAGE);

  constructor(opts: GimpSessionOptions) {
    this.install = opts.install;
    this.rootDir = opts.rootDir ?? defaultRootDir();
    this.spawnFn = opts.spawn ?? (nodeSpawn as SpawnFn);
    this.clock = opts.now ?? Date.now;
    this.monotonicClock = opts.nowMonotonic ?? (() => performance.now());
    this.logger = opts.logger ?? new Logger('GimpSession');
    this.killTreeFn = opts.killTree ?? defaultTreeKill;
    this.platform = opts.platform ?? process.platform;
    this.getuid = opts.getuid ?? (() => process.getuid?.());
    this.statRootDir =
      opts.statRootDir ??
      ((path) => {
        const st = statSync(path);
        return { uid: st.uid, mode: st.mode };
      });
    this.chmodRootDir = opts.chmodRootDir ?? chmodSync;
    this.readRespFile = opts.readRespFile ?? ((path) => readFileSync(path, 'utf8'));
    this.opsPyPath = opts.opsPyPath ?? resolveOpsPyPath();
  }

  get state(): GimpSessionState {
    return this.sessionState;
  }

  get gimpVersion(): string | undefined {
    return this.version;
  }

  /** See the `startOrigin` field doc comment above. */
  get lastStartOrigin(): 'cold' | 'restarted' | undefined {
    return this.startOrigin;
  }

  /**
   * How many times `#markDead` has run — 0 until the first confirmed failure, then bumped once
   * per occurrence for the rest of this session's life. That covers more than "a session that
   * reached ready and then died": every path that ends a launch attempt without ever reaching
   * 'ready' — a failure preparing the session directory, a spawn error, a readiness timeout, an
   * unexpected process exit, an unsupported GIMP version — calls `#markDead` too, so this can
   * bump before generation 0 ever saw a single successful ping. What it guarantees either way: a
   * call issued while generation G is current and one issued once it has become G' > G are
   * provably talking to DIFFERENT GIMP processes, even when they reference the exact same low
   * integer image id — GIMP's own per-process id counter restarts at 1 after every relaunch, so
   * "same id" alone can never tell that apart. Read via `GimpBackend.generation`; `gimp_checkpoint`'s
   * `restore` is the first caller (stamps a checkpoint with the generation current at `create`
   * time, and refuses to `close` an id whose generation has since moved on, since that id may now
   * belong to a completely unrelated image in the new process).
   */
  get generation(): number {
    return this.deadGeneration;
  }

  /** Where the human-follows-along preview lives; refreshed by `copyToLatestPreview`. */
  latestPreviewPath(): string {
    return join(this.rootDir, 'latest-preview.jpg');
  }

  /**
   * Absolute path for an internal temp output inside this session's root dir
   * — used by tool handlers that need a filesystem path to hand the bridge
   * (e.g. `gimp_compare`'s optional before/after preview exports) without
   * ever accepting a caller-supplied path for it: internal temp outputs are
   * always paths the tool layer generates inside the session dir. Routed
   * through the same checked/locked-down root-dir creation every session
   * dir goes through, so it's safe to call before any session has ever
   * started.
   */
  tempPath(name: string): string {
    this.#ensureRootDir();
    return join(this.rootDir, name);
  }

  /** Copy a rendered preview to the well-known path a person can keep open, atomically (write-then-rename). */
  copyToLatestPreview(src: string): void {
    // Routed through the same checked/locked-down root-dir creation every
    // session dir goes through — this can run before any session has ever
    // started (a caller might just want the preview path), so it can't rely
    // on `#startFresh` having already called it.
    this.#ensureRootDir();
    const dest = this.latestPreviewPath();
    // A per-call temp name: two sessions for one user share this folder, and a fixed name would
    // let one's rename race the other's write.
    const tmp = `${dest}.${process.pid}-${randomUUID()}.tmp`;
    copyFileSync(src, tmp);
    renameSync(tmp, dest);
  }

  /**
   * Dispatch one operation. Calls are strictly serialized — one GIMP, one
   * request in flight at a time — so `queue` is a plain promise chain rather
   * than anything more elaborate. Because it's serial, exactly one
   * `#dispatch` ever executes concurrently, which is what makes the
   * generation check below sufficient without extra locking.
   */
  async call<T = unknown>(
    op: string,
    args: Record<string, unknown> = {},
    callOpts: { timeoutMs?: number } = {}
  ): Promise<T> {
    // Captured NOW, synchronously, before this call waits its turn: it
    // records "how many crashes had already happened when the caller issued
    // this call." A call issued before a crash that hasn't been restarted
    // from yet — i.e. one that was already in flight or sitting in the
    // queue when the session died — carries a strictly older generation
    // than a call issued afterward (even one issued moments later, once the
    // caller has seen the failure or simply tries again). That's exactly the
    // in-flight/queued vs. next-call distinction the lifecycle contract
    // wants, and it falls out of a single counter with no extra bookkeeping.
    const myGeneration = this.deadGeneration;
    // Captured NOW too, alongside myGeneration: several calls issued
    // together (before any of them has reached its turn on `queue`) must
    // each measure their OWN CALL_READY_WAIT_MS cap from the moment THEY
    // were issued, not from whenever they happen to reach the front of the
    // serialized queue — otherwise a second call queued behind a first
    // that's already mid-wait would answer at ~2x CALL_READY_WAIT_MS
    // instead of alongside the first.
    const issuedAt = this.monotonicClock();
    const run = this.queue.then(() =>
      this.#dispatch<T>(
        op,
        args,
        callOpts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
        myGeneration,
        issuedAt
      )
    );
    // The shared queue itself must never end up permanently rejected, or
    // every call after the first failure would hang forever waiting its turn.
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /** Graceful `rpc/shutdown` → wait → tree-kill on timeout → remove the session dir. Idempotent and memoised. */
  async shutdown(): Promise<void> {
    if (!this.shutdownPromise) this.shutdownPromise = this.#shutdownOnce();
    return this.shutdownPromise;
  }

  // ---- lifecycle ------------------------------------------------------------

  async #dispatch<T>(
    op: string,
    args: Record<string, unknown>,
    timeoutMs: number,
    myGeneration: number,
    issuedAt: number
  ): Promise<T> {
    this.#assertOpen();
    if (this.stickyError) {
      throw this.stickyError;
    }
    if (this.sessionState === 'dead' && myGeneration < this.deadGeneration) {
      throw this.lastFailure;
    }
    if (this.sessionState !== 'ready') {
      await this.#joinOrStart(issuedAt);
      // #joinOrStart can await for up to ~2s (the stale-process kill-confirm
      // wait) before ever spawning anything, and again while waiting for
      // readiness (capped at CALL_READY_WAIT_MS) — shutdown() can land in
      // any of those gaps. Re-checking here, AFTER the await returns, is
      // what stops a call from proceeding to #send against a session that
      // finished closing while this call was waiting its turn.
      this.#assertOpen();
    }
    return this.#send<T>(op, args, timeoutMs);
  }

  /**
   * Ensures a start attempt is running — joining one already in flight
   * rather than starting a second, competing one — and waits for THIS call's
   * turn on it, capped at `CALL_READY_WAIT_MS` measured from `issuedAt`
   * (when the CALLER issued this call — see the comment on `call()` — not
   * whenever it happens to reach this method). If that cap elapses first,
   * throws `gimp_starting` and returns control to the caller WITHOUT
   * touching the attempt itself: it keeps running under `#startPromise`, so
   * the next call to reach here (queued behind this one, or issued later)
   * joins the exact same attempt instead of `#startFresh()` tree-killing a
   * half-started GIMP and re-paying its first-launch cost.
   *
   * If a start attempt already failed for real while nobody was watching
   * (see `unobservedStartFailure`'s doc comment), that's surfaced here
   * FIRST, before starting anything new — otherwise every following call
   * would just kick off (and likely re-time-out on) a fresh attempt and
   * report `gimp_starting` forever, with the real cause (a crash, the 180s
   * deadline, a spawn error, ...) never reaching anyone.
   */
  async #joinOrStart(issuedAt: number): Promise<void> {
    if (!this.startPromise) {
      if (this.unobservedStartFailure) {
        const err = this.unobservedStartFailure;
        this.unobservedStartFailure = undefined;
        throw err;
      }
      const newAttempt = this.#startFresh();
      // Registered BEFORE `this.startPromise` is even assigned — and
      // therefore before any waiter's own `Promise.race` arm further below
      // can attach ITS reaction to this same promise. Reactions on one
      // promise fire in registration order, so THIS handler always runs
      // FIRST when `newAttempt` rejects, before any currently-waiting call
      // has had a chance to decrement `activeWaiters` in its own `finally`.
      // That ordering is what makes `activeWaiters` a trustworthy "was
      // anyone actually watching, right now, at the instant of failure"
      // check, rather than a race against it.
      newAttempt.catch((err: unknown) => {
        if (this.activeWaiters > 0) return; // a waiter is mid-race and will see this rejection itself
        this.unobservedStartFailure =
          err instanceof GimpError ? err : new GimpError('gimp_start_failed', String(err));
      });
      this.startPromise = newAttempt;
      const clearIfCurrent = () => {
        if (this.startPromise === newAttempt) this.startPromise = undefined;
      };
      newAttempt.then(clearIfCurrent, clearIfCurrent);
    }
    const attempt = this.startPromise;

    // Clamped on BOTH ends, not just floored at 0: the monotonic clock is not
    // expected to jump backward in real use, but if it somehow did (or a test
    // clock is misbehaving), an unclamped upper bound would let `remaining`
    // balloon past CALL_READY_WAIT_MS — silently recreating the exact
    // "gimp_starting forever" bug this cap exists to prevent.
    const remaining = Math.min(
      CALL_READY_WAIT_MS,
      Math.max(0, issuedAt + CALL_READY_WAIT_MS - this.monotonicClock())
    );
    this.activeWaiters++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<true>((resolve) => {
      timer = setTimeout(() => resolve(true), remaining);
    });
    try {
      const raced = await Promise.race([attempt.then(() => false as const), timedOut]);
      if (raced === true) {
        // Worded from `startOrigin` (set at the top of `#startFresh`, well
        // before this cap could ever fire) so a caller recovering from a
        // crash doesn't hear "first launch" — it isn't one.
        const restarting = this.startOrigin === 'restarted';
        throw new GimpError(
          'gimp_starting',
          restarting
            ? 'GIMP is restarting after stopping unexpectedly. Call gimp_ping again in about 30 seconds.'
            : 'GIMP is still starting. The first launch on a machine can take a few minutes while ' +
                'GIMP builds its caches. Call gimp_ping again in about 30 seconds.'
        );
      }
    } finally {
      clearTimeout(timer);
      this.activeWaiters--;
    }
  }

  /**
   * Throws `GimpError('gimp_session_restarted', 'session closed')` if
   * `shutdown()` has started (or finished) since the last check — the ONE
   * place that question is asked, so every `await` inside `#dispatch` and
   * `#startFresh` that could straddle a shutdown re-checks through this
   * rather than re-deriving the condition ad hoc at each call site. Most
   * critically, this is what stops `#startFresh`'s stale-process
   * kill-and-confirm wait (up to `KILL_CONFIRM_MS`) from resurrecting a
   * session that finished closing while that wait was in flight: without
   * this check, the code that runs right after it — sweeping the old dir,
   * flipping state to `'starting'`, spawning a brand new GIMP — would run
   * unconditionally, leaving a fresh process nobody will ever manage or kill
   * (`shutdown()` only ever runs once, and by then it's already returned).
   * `procToKillIfTripped`, when given, is tree-killed before throwing — for
   * a call site where a process was already spawned by the time this runs.
   */
  #assertOpen(procToKillIfTripped?: ChildProcess): void {
    if (!this.shuttingDown && this.sessionState !== 'closed') return;
    if (procToKillIfTripped) this.killTreeFn(procToKillIfTripped);
    throw new GimpError('gimp_session_restarted', 'session closed');
  }

  async #startFresh(): Promise<void> {
    this.#assertOpen();
    // Recorded HERE, before anything else in this attempt can move
    // `sessionState` on, and derived from `everReady` — NOT `sessionState`:
    // 'dead'/'starting' looks identical whether this is a first launch that
    // simply hit the 180s deadline (or crashed before ever connecting) or a
    // real restart after a session that WAS ready. Only `everReady`
    // actually distinguishes them.
    this.startOrigin = this.everReady ? 'restarted' : 'cold';
    // A previous process may still be alive (e.g. this restart was
    // triggered by a timeout whose kill hasn't actually reaped it yet, or
    // by a crash we detected before the OS finished tearing it down).
    // Tree-kill it and WAIT for it to actually confirm exit (bounded) before
    // dropping its directory — otherwise its stale `exit`/`error` listeners
    // would fire later, and removing the directory while GIMP might still
    // have it open would be the exact race #shutdownOnce also guards against.
    const staleProc = this.proc;
    const staleDir = this.sessionDir;
    if (staleProc && !hasExited(staleProc)) {
      await this.#killAndConfirmExit(staleProc);
      // This wait can take up to KILL_CONFIRM_MS (2s) — long enough for a
      // shutdown() to start AND finish while it was running. Nothing of
      // ours is spawned yet, so there's nothing to kill; just don't go on
      // to sweep the (already-removed-by-shutdown, or about-to-be) stale
      // dir, flip state back to 'starting', and spawn a brand new,
      // unmanaged GIMP behind shutdown()'s back.
      this.#assertOpen();
    }
    if (staleDir) {
      this.#removeSessionDir(staleDir);
    }

    this.sessionState = 'starting';
    // Everything here is synchronous (no `await` until the spawn below), so
    // a failure — a locked-down/foreign-owned root dir, a full disk, a
    // permissions error creating the session dir — must be caught and
    // classified right here: nothing else ever will be. Left uncaught,
    // `sessionState` would stay 'starting' forever (no process was ever
    // spawned, so there's nothing for any exit/error listener to react to
    // and call `#markDead`), and every later `gimp_ping` would keep
    // reporting a session stuck mid-launch instead of the real, likely
    // persistent cause.
    let sessionDir: string;
    let rpcDir: string;
    try {
      this.#ensureRootDir();
      if (!this.sweepDone) {
        this.sweepDone = true;
        this.#sweepOrphans();
      }

      sessionDir = mkdtempSync(join(this.rootDir, `session-${process.pid}-`));
      rpcDir = join(sessionDir, 'rpc');
      mkdirSync(rpcDir, { recursive: true });
      this.sessionDir = sessionDir;
      this.rpcDir = rpcDir;
      this.nextId = 1;
      this.output = '';
    } catch (err) {
      const gimpErr =
        err instanceof GimpError
          ? err
          : new GimpError(
              'gimp_start_failed',
              `could not prepare the GIMP session directory: ${this.#redact(err instanceof Error ? err.message : String(err))}`
            );
      this.#markDead(gimpErr);
      throw gimpErr;
    }

    // GIMP and its plug-ins get the user's environment minus Editmamei's own settings
    // (EDITMAMEI_*, which can carry credentials), none of which the bridge reads.
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('EDITMAMEI_'))
    );
    const env: Record<string, string | undefined> = {
      ...inherited,
      EM_GIMP_OPS: this.opsPyPath,
      EM_GIMP_SESSION: sessionDir,
    };
    // GIMP under Flatpak runs in its own pid namespace, so the host's
    // parent pid isn't visible inside the sandbox — the bridge's
    // is_process_alive check would see it as already gone and exit the
    // session about a second after it becomes ready. Flatpak installs skip
    // the parent-death check entirely: a crashed driver can orphan a
    // Flatpak GIMP process until the next session's stale-dir cleanup runs
    // (that cleanup removes the old session DIRECTORY; the orphaned process
    // itself keeps running until the user closes it or reboots).
    if (this.install.launch.command !== 'flatpak') {
      env.EM_GIMP_PARENT_PID = String(process.pid);
    }
    const { command, args } = this.install.launch;
    const fullArgs = [
      ...args,
      '-i',
      '--batch-interpreter=python-fu-eval',
      '-b',
      BATCH_LINE,
      '--quit',
    ];

    let proc: ChildProcess;
    try {
      proc = this.spawnFn(command, fullArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // POSIX: a process group of its own, so defaultTreeKill's group kill reaches GIMP's children.
        detached: this.platform !== 'win32',
        env,
      });
    } catch (err) {
      const gimpErr = this.#classifySpawnFailure(err);
      this.#markDead(gimpErr);
      throw gimpErr;
    }
    this.proc = proc;
    proc.stdout?.on('data', (d) => {
      this.output = (this.output + String(d)).slice(-MAX_CAPTURED_OUTPUT);
    });
    proc.stderr?.on('data', (d) => {
      this.output = (this.output + String(d)).slice(-MAX_CAPTURED_OUTPUT);
    });

    let spawnError: unknown;
    // Set on 'close' (stdio streams fully flushed), NOT 'exit' — 'exit' can
    // fire before all buffered stdout/stderr has actually been delivered
    // via the 'data' events above, so classifying on it risks reading
    // `this.output` before the very message that would classify it (e.g.
    // the python-fu-eval diagnostic) has arrived. #waitForReady's poll loop
    // is the ONE place that reacts to this, so there is normally exactly one
    // classification per start attempt, not a race between two.
    let preReadyCloseCode: number | null | undefined;
    let closeGraceTimer: ReturnType<typeof setTimeout> | undefined;
    proc.on('exit', (code, signal) => {
      // A listener from an already-superseded process (this session moved
      // on to a newer `this.proc` since this one was spawned) — ignore it,
      // or its late 'exit' would mark a perfectly healthy new session dead.
      if (proc !== this.proc) return;
      // Our own timeout-kill path already marked the session dead before
      // killing it; a deliberate shutdown() sets `shuttingDown` before
      // writing rpc/shutdown, BEFORE this event can fire — either way,
      // this is the "nobody expected it" branch, not those two.
      if (this.sessionState === 'dead' || this.sessionState === 'closed') return;
      if (this.shuttingDown) {
        this.sessionState = 'closed';
        return;
      }
      if (this.sessionState === 'starting') {
        // Normally classified on 'close' below, once stdio is flushed — but
        // a surviving child holding the stdio pipes open (e.g. a grandchild
        // GIMP spawned) can mean 'close' never fires at all. Give it a
        // bounded head start; if it hasn't shown up by then, classify with
        // whatever output was actually captured rather than hang the rest
        // of READY_TIMEOUT_MS waiting for an event that isn't coming.
        closeGraceTimer = setTimeout(() => {
          if (preReadyCloseCode === undefined) preReadyCloseCode = code;
        }, CLOSE_AFTER_EXIT_GRACE_MS);
        closeGraceTimer.unref?.();
        return;
      }
      this.logger.warn('GIMP process exited unexpectedly', { code, signal });
      this.#markDead();
    });
    proc.on('close', (code) => {
      if (proc !== this.proc) return;
      if (this.sessionState !== 'starting') return;
      clearTimeout(closeGraceTimer);
      preReadyCloseCode = code;
    });
    proc.on('error', (err) => {
      if (proc !== this.proc) return;
      spawnError = err;
      if (this.sessionState !== 'dead' && this.sessionState !== 'closed') {
        this.logger.error('GIMP process error', err);
        // Classified even here (not just below, in #waitForReady's own
        // catch): an 'error' event can arrive well after readiness too, and
        // this is the only listener that would ever see it in that case.
        this.#markDead(this.#classifySpawnFailure(err));
      }
    });

    try {
      await this.#waitForReady(
        rpcDir,
        () => spawnError,
        () => preReadyCloseCode
      );
    } catch (err) {
      // #assertOpen FIRST: if this failed because #waitForReady's own abort
      // check tripped (shutdown() landed while we were waiting), that's
      // shutdown()'s error to report, not a fresh 'dead' classification —
      // and shutdown() already owns killing this exact process (`this.proc`
      // was assigned before this await started), so no extra kill is passed
      // in here.
      this.#assertOpen();
      const gimpErr = err as GimpError;
      this.#markDead(gimpErr);
      this.killTreeFn(proc);
      throw gimpErr;
    }
    // Reached readiness, but shutdown() may have landed in the gap between
    // the event that satisfied #waitForReady and this line running.
    this.#assertOpen(proc);

    let ping: PingResult;
    try {
      ping = await this.#send<PingResult>('ping', {}, PING_TIMEOUT_MS);
    } catch (err) {
      this.#assertOpen();
      const gimpErr = err as GimpError;
      this.#markDead(gimpErr);
      this.killTreeFn(proc);
      throw gimpErr;
    }
    this.#assertOpen(proc);
    this.version = `${ping.major}.${ping.minor}.${ping.micro}`;
    if (ping.major !== 3 || ping.minor < 2) {
      const err = new GimpError(
        'gimp_version_unsupported',
        `Editmamei needs GIMP 3.2 or newer; found ${this.version}`
      );
      this.stickyError = err; // this install will never report a different version
      this.#markDead(err);
      this.killTreeFn(proc);
      throw err;
    }
    if (ping.minor > 2) {
      this.logger.warn(
        `GIMP ${this.version} is newer than the tested 3.2.x line; continuing untested`
      );
    }

    this.#assertOpen(proc);
    this.sessionState = 'ready';
    if (this.startOrigin === 'restarted') this.restartNoticePending = true;
    this.everReady = true;
  }

  /**
   * Validate (and, on first creation, lock down) the root directory every
   * session dir lives under. Never `os.tmpdir()` — that's world-writable on
   * most POSIX systems, so anything living directly under it is guessable
   * and, if the parent allows it, tamperable by another local user.
   */
  #ensureRootDir(): void {
    mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    if (this.platform === 'win32') return;

    const st = this.statRootDir(this.rootDir);
    const uid = this.getuid();
    if (uid !== undefined && st.uid !== uid) {
      throw new GimpError(
        'gimp_start_failed',
        `refusing to use the GIMP session folder: owned by a different user (uid ${st.uid})`
      );
    }
    if ((st.mode & 0o022) !== 0) {
      throw new GimpError(
        'gimp_start_failed',
        `refusing to use the GIMP session folder: group- or other-writable (mode ${(st.mode & 0o777).toString(8)})`
      );
    }
    // Correct any drift from a prior run (e.g. an umask that widened it) now
    // that we know it's ours.
    this.chmodRootDir(this.rootDir, 0o700);
  }

  #classifySpawnFailure(err: unknown): GimpError {
    // These messages reach the model, and a full install path carries the username, so they
    // name the binary only. The full path is in the debug log.
    const command = this.install.launch.command;
    const binary = basename(command);
    this.logger.debug('GIMP spawn failed', { command, err });
    if (isEnoentError(err)) {
      const gimpErr = new GimpError(
        'gimp_start_failed',
        `GIMP not found at "${binary}" (ENOENT) — check the install path`
      );
      this.stickyError = gimpErr; // the configured binary does not exist; relaunching won't help
      return gimpErr;
    }
    const message = (err instanceof Error ? err.message : String(err)).split(command).join(binary);
    return new GimpError('gimp_start_failed', `could not start GIMP at "${binary}": ${message}`);
  }

  async #waitForReady(
    rpcDir: string,
    getSpawnError: () => unknown,
    getPreReadyCloseCode: () => number | null | undefined
  ): Promise<void> {
    const readyPath = join(rpcDir, 'ready');
    const deadline = this.monotonicClock() + READY_TIMEOUT_MS;
    while (!existsSync(readyPath)) {
      // Observed FIRST, every iteration: without this, a shutdown() issued
      // while still 'starting' would otherwise sit here polling a directory
      // that shutdown() may already have removed for up to the full
      // READY_TIMEOUT_MS (180s) before ever noticing — this is what makes a
      // shutdown mid-start reject almost immediately (within one
      // POLL_INTERVAL_MS) instead.
      this.#assertOpen();
      // Checked BEFORE exitCode: Node commonly reports a spawn failure like
      // ENOENT via the async 'error' event without ever setting a
      // meaningful exitCode (or sets one that reads as an ordinary crash,
      // e.g. -2) — that must classify as "GIMP not found", not "GIMP exited
      // before it became ready".
      const spawnErr = getSpawnError();
      if (spawnErr) throw this.#classifySpawnFailure(spawnErr);
      // 'close' (stdio fully flushed), not exitCode/'exit': see the comment
      // where preReadyCloseCode is set, in #startFresh.
      const closeCode = getPreReadyCloseCode();
      if (closeCode !== undefined) throw this.#classifyPreReadyExit(closeCode);
      if (this.monotonicClock() > deadline) {
        // Deliberately NOT sticky: a slow/loaded host is a plausible,
        // transient cause, so the next call gets to try again.
        throw new GimpError(
          'gimp_start_failed',
          `GIMP did not become ready within ${READY_TIMEOUT_MS}ms`
        );
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  #classifyPreReadyExit(exitCode: number | null): GimpError {
    this.logger.debug('GIMP exited before ready', { exitCode, tail: this.output.slice(-500) });
    if (PYTHON_INTERPRETER_MISSING_RE.test(this.output)) {
      const gimpErr = new GimpError(
        'gimp_python_missing',
        'this GIMP install has no Python support (python-fu-eval is missing) — reinstall GIMP with Python support enabled'
      );
      this.stickyError = gimpErr; // this install's GIMP binary will never suddenly grow Python support
      return gimpErr;
    }
    return new GimpError(
      'gimp_start_failed',
      `GIMP exited (code ${exitCode}) before it became ready`
    );
  }

  async #send<T>(op: string, args: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const proc = this.proc;
    const rpcDir = this.rpcDir;
    if (!proc || !rpcDir) {
      throw new GimpError('gimp_start_failed', 'GIMP session has no active process');
    }

    const id = this.nextId++;
    const reqPath = join(rpcDir, `req-${id}.json`);
    const respPath = join(rpcDir, `resp-${id}.json`);
    // `resp` is deliberately NOT part of the request body — the bridge
    // derives the response path itself from the id, so a malformed or
    // tampered request can't steer a write anywhere else on disk.
    writeFileSync(`${reqPath}.tmp`, JSON.stringify({ id, op, args }));
    renameSync(`${reqPath}.tmp`, reqPath);

    const deadline = this.monotonicClock() + timeoutMs;
    while (!existsSync(respPath)) {
      // `sessionState === 'dead'` too, not just the process's own exit status: the 'error'
      // listener marks the session dead on a process error that may never produce an exit
      // (and a stub or future path may mark it dead before exitCode/signalCode are set).
      if (hasExited(proc) || this.sessionState === 'dead') {
        // A graceful shutdown() kills this same process, so this branch is
        // also how an in-flight call notices one landing underneath it.
        // #markDead is skipped in that case — shutdown() alone owns the
        // 'closed' transition, and a call reaching here after it already
        // ran must not resurrect a 'closed' session back to 'dead'.
        if (!this.shuttingDown) this.#markDead();
        throw new GimpError('gimp_session_restarted', RESTARTED_MESSAGE);
      }
      if (this.monotonicClock() > deadline) {
        if (!this.shuttingDown) this.#markDead();
        this.killTreeFn(proc);
        throw new GimpError(
          'gimp_timeout',
          `${op} did not respond within ${timeoutMs}ms, so the GIMP session was stopped: ${LOST_WORK}`
        );
      }
      await sleep(POLL_INTERVAL_MS);
    }

    const raw = await this.#readResponse(respPath, op);
    try {
      unlinkSync(respPath);
    } catch {
      /* best effort */
    }

    if (!raw.ok) {
      const code: GimpErrorCode =
        raw.code && KNOWN_ERROR_CODES.has(raw.code as GimpErrorCode)
          ? (raw.code as GimpErrorCode)
          : 'gimp_op_failed';
      this.logger.debug('GIMP op failed', op, raw.error, raw.trace);
      if (
        this.restartNoticePending &&
        code === 'invalid_argument' &&
        /no open image with id/.test(raw.error ?? '')
      ) {
        this.restartNoticePending = false;
        throw new GimpError(
          'gimp_session_restarted',
          `that image id is not open. The GIMP session restarted, so ${LOST_WORK}`
        );
      }
      // Bridge exception text can name a render path under the session folder.
      throw new GimpError(code, this.#redact(raw.error ?? `${op} failed`));
    }
    // A fresh open means the caller holds a valid id again; a later "no open image" is its own
    // mistake, not the restart's.
    if (op === 'open') this.restartNoticePending = false;
    return raw.result as T;
  }

  /**
   * Read + parse a response file. Retries briefly on EBUSY/EPERM (an
   * anti-virus or file-indexer lock momentarily holding a just-renamed file
   * on Windows) — mirrors the same hardening on the bridge's own read of
   * request files (`lib.read_request`). A body that reads fine but isn't
   * valid JSON becomes a `gimp_op_failed` GimpError rather than an
   * uncaught SyntaxError.
   */
  async #readResponse<T>(
    respPath: string,
    op: string
  ): Promise<{ ok: boolean; result?: T; error?: string; code?: string; trace?: string }> {
    let raw: string | undefined;
    let lastErr: unknown;
    for (let attempt = 0; attempt < RESP_READ_RETRY_ATTEMPTS; attempt++) {
      try {
        raw = this.readRespFile(respPath);
        break;
      } catch (err) {
        lastErr = err;
        if (!isRetryableReadError(err)) {
          // Never the raw fs error: a caller matching on GimpError.code
          // (every other failure path in this class throws one) would
          // otherwise have to special-case this one spot.
          throw new GimpError(
            'gimp_op_failed',
            `${op}: could not read the response file (${this.#redact((err as Error).message)})`
          );
        }
        await sleep(RESP_READ_RETRY_DELAY_MS);
      }
    }
    if (raw === undefined) {
      const message = lastErr instanceof Error ? lastErr.message : String(lastErr);
      throw new GimpError(
        'gimp_op_failed',
        `${op}: could not read the response file after ${RESP_READ_RETRY_ATTEMPTS} attempts (${this.#redact(message)})`
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new GimpError(
        'gimp_op_failed',
        `${op}: response was not valid JSON (${(err as Error).message})`
      );
    }
    // A bridge response is always a JSON OBJECT with at least a boolean
    // `ok` — reject anything else (null, an array, a bare number) here
    // rather than let the caller's `if (!raw.ok)` throw a TypeError on it.
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { ok?: unknown }).ok !== 'boolean'
    ) {
      throw new GimpError('gimp_op_failed', `${op}: response was not a well-formed object`);
    }
    return parsed as { ok: boolean; result?: T; error?: string; code?: string; trace?: string };
  }

  async #shutdownOnce(): Promise<void> {
    // Set FIRST, unconditionally, in every branch below — #dispatch's
    // race-guard (`this.shuttingDown`) must already be true before this
    // method does anything else observable, or a call() reaching #dispatch
    // in the gap could still try to send against — or relaunch behind — a
    // session in the middle of shutting down.
    this.shuttingDown = true;
    const proc = this.proc;

    if (!proc) {
      this.sessionState = 'closed';
      if (this.sessionDir) this.#removeSessionDir(this.sessionDir);
      return;
    }
    if (hasExited(proc)) {
      // Already gone — nothing to kill or wait for.
      this.sessionState = 'closed';
      if (this.sessionDir) this.#removeSessionDir(this.sessionDir);
      return;
    }
    if (this.sessionState === 'dead') {
      // A prior crash/timeout marked this dead, but that alone does NOT
      // guarantee the OLD process has actually exited — a timeout's own
      // tree-kill is fire-and-forget. Kill it (harmless if it's already on
      // its way out) and wait for confirmation before touching its
      // directory, same as the graceful path below.
      await this.#killAndConfirmExit(proc);
      this.sessionState = 'closed';
      if (this.sessionDir) this.#removeSessionDir(this.sessionDir);
      return;
    }

    // 'starting' or 'ready', process looks alive: the graceful path.
    try {
      writeFileSync(join(this.rpcDir!, 'shutdown'), '');
    } catch {
      /* process may already be on its way out */
    }

    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const graceExpired = new Promise<boolean>((resolve) => {
      graceTimer = setTimeout(() => resolve(true), SHUTDOWN_GRACE_MS);
    });
    // `.once`, not `.on`: this same unresolved promise is handed to
    // #killAndConfirmExit below, so it must still be armed at that point.
    const exited = new Promise<boolean>((resolve) => proc.once('exit', () => resolve(false)));
    const timedOut = await Promise.race([exited, graceExpired]);
    clearTimeout(graceTimer);
    if (timedOut) {
      await this.#killAndConfirmExit(proc, exited);
    }

    this.sessionState = 'closed';
    if (this.sessionDir) this.#removeSessionDir(this.sessionDir);
  }

  /**
   * Tree-kill `proc` and wait for it to actually confirm exit, bounded by
   * `KILL_CONFIRM_MS`, before returning — a tree-kill call (real
   * `taskkill`/`process.kill(-pid, ...)`) is fire-and-forget, so it does not
   * itself guarantee the process has exited by the time it returns, and
   * removing a session dir GIMP might still have files open in would be
   * exactly the race this closes. Logs (never throws) if the process never
   * confirms within the bound — the caller proceeds either way, since
   * hanging forever on a truly wedged process is worse than the residual
   * risk.
   *
   * `existingExited`, when given, is an ALREADY-ARMED `.once('exit', ...)`
   * promise the caller set up earlier (so the kill can't be issued before
   * anything is listening); otherwise one is created fresh.
   */
  async #killAndConfirmExit(proc: ChildProcess, existingExited?: Promise<boolean>): Promise<void> {
    this.killTreeFn(proc);
    const exited =
      existingExited ?? new Promise<boolean>((resolve) => proc.once('exit', () => resolve(false)));
    let confirmTimer: ReturnType<typeof setTimeout> | undefined;
    const confirmTimedOut = new Promise<boolean>((resolve) => {
      confirmTimer = setTimeout(() => resolve(true), KILL_CONFIRM_MS);
    });
    const stillRunning = await Promise.race([exited.then(() => false), confirmTimedOut]);
    clearTimeout(confirmTimer);
    if (stillRunning) {
      this.logger.warn('GIMP process did not confirm exit after tree-kill; proceeding anyway', {
        sessionDir: this.sessionDir,
      });
    }
  }

  /**
   * `err`, when given, is the SPECIFIC classified cause (a start failure) —
   * recorded so calls already queued behind this generation get told the
   * real reason instead of a generic "restarted" message. Omitted for a
   * mid-session death (the session WAS ready and something killed it), where
   * the generic message is the honest one: nothing about the crash is
   * specific to any one queued call.
   */
  #markDead(err?: GimpError): void {
    // A 'closed' session already finished shutting down — nothing should
    // ever move it back to 'dead' (a late event from the OLD process
    // racing shutdown(), for instance). 'closed' is terminal.
    if (this.sessionState === 'dead' || this.sessionState === 'closed') return;
    this.sessionState = 'dead';
    this.deadGeneration++;
    this.lastFailure = err ?? new GimpError('gimp_session_restarted', RESTARTED_MESSAGE);
  }

  /**
   * `text` with the session root folder cut out: error messages reach the model, and the root
   * lives under the user's home folder, so its full path carries the username. Python's OSError
   * text quotes a path in repr form, which doubles every Windows backslash, and GIMP may print it
   * with forward slashes, so those spellings are cut too (longest first).
   */
  #redact(text: string): string {
    const spellings = [
      ...new Set([
        this.rootDir.replace(/\\/g, '\\\\'),
        this.rootDir,
        this.rootDir.replace(/\\/g, '/'),
      ]),
    ].sort((a, b) => b.length - a.length);
    return spellings.reduce((out, s) => out.split(s).join('<GIMP session folder>'), text);
  }

  #removeSessionDir(dir: string): void {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      this.logger.warn('Could not remove GIMP session dir', dir, err);
    }
  }

  /**
   * Once per instance, on the first start: remove sibling `session-*` dirs
   * under `rootDir` whose embedded pid is no longer alive AND whose mtime is
   * older than 24h. Never touches the dir this instance is about to create,
   * nor anything not matching the naming pattern.
   */
  #sweepOrphans(): void {
    let entries: string[];
    try {
      entries = readdirSync(this.rootDir);
    } catch {
      return;
    }
    const cutoff = this.clock() - ORPHAN_MAX_AGE_MS;
    for (const name of entries) {
      const match = /^session-(\d+)-/.exec(name);
      if (!match) continue;
      const pid = Number(match[1]);
      const dir = join(this.rootDir, name);
      let mtimeMs: number;
      try {
        mtimeMs = statSync(dir).mtimeMs;
      } catch {
        continue;
      }
      if (mtimeMs >= cutoff) continue;
      if (this.#isPidAlive(pid)) continue;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        this.logger.warn('Could not remove orphaned GIMP session dir', dir, err);
      }
    }
  }

  /** `process.kill(pid, 0)` sends no signal — it only probes whether the pid exists and is signalable. */
  #isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // ESRCH: no such process — safe to reclaim. Anything else (e.g. EPERM,
      // meaning it exists but we lack permission to signal it) is treated as
      // alive: sweeping is a cleanup convenience, never worth a false
      // positive against a process that's actually still running.
      return (err as { code?: string }).code !== 'ESRCH';
    }
  }
}
