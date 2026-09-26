/**
 * The registry-facing wrapper around `GimpSession` — what tool handlers see
 * as `host.gimp`. Mirrors how every `ps_*` tool file only ever sees a
 * `PhotoshopConnection`, never the platform runner underneath it: `gimp_*`
 * tool files construct nothing session-shaped themselves, they only call
 * `gimp.call(op, args)`.
 *
 * Owns the LAZY session (constructed on first `call()`, not at boot — the
 * boot-ordering invariant the rest of the host keeps: nothing that talks to
 * an editor runs before `server.connect()`, and `gimpModule.register` never
 * calls anything on this class besides handing it to tool factories).
 */

import { GimpSession, type GimpSessionOptions } from './session.js';
import { detectGimp, type GimpInstall } from './detect.js';
import { GimpError } from './errors.js';
import { currentToolBudget } from '../../utils/tool-budget-context.js';

export interface GimpBackendOptions {
  /** Injected for tests — constructs the session. Defaults to `new GimpSession(...)`. */
  sessionFactory?: (opts: GimpSessionOptions) => GimpSession;
  /** Extra `GimpSessionOptions` passed straight through (rootDir/spawn/clock/etc.) — tests only. */
  sessionOptions?: Omit<GimpSessionOptions, 'install'>;
  /**
   * True when boot's `detectEditors()` probe hit its time box rather than
   * genuinely finding nothing, on a boot pinned to 'gimp' (the one case that
   * registers gimp_* tools with a `null` install — see `resolveEditorRegistration`).
   * A rushed 750ms probe timing out is not the same fact as "no GIMP on this
   * machine", so a `null` install paired with this flag gets ONE unhurried
   * `detectGimp()` retry on first use instead of being treated as permanent.
   */
  gimpDetectionTimedOut?: boolean;
  /** Injected for tests — re-runs detection after a boot timeout. Defaults to the real `detectGimp`. */
  detectGimpFn?: () => Promise<GimpInstall | null>;
  /**
   * The configured GIMP path (see `EditorRegistrationDecision.gimpPathOverride`). The default
   * post-timeout retry detects with it, the same way boot detection did.
   */
  gimpPath?: string;
}

export class GimpBackend {
  private installInfo: GimpInstall | null;
  private readonly sessionFactory: (opts: GimpSessionOptions) => GimpSession;
  private readonly sessionOptions: Omit<GimpSessionOptions, 'install'>;
  private readonly detectGimpFn: () => Promise<GimpInstall | null>;
  /**
   * True until the one post-boot-timeout redetect has been attempted (win or
   * lose). Never re-armed — a genuine second miss after an unhurried,
   * non-time-boxed search is a real answer, not a rushed one, so it's safe to
   * report `gimp_not_installed` from then on without retrying every call.
   */
  private redetectPending: boolean;
  private session: GimpSession | undefined;
  /**
   * Set once `shutdown()` has been called, even if no session was ever
   * started — without this, calling `shutdown()` before the first `call()`
   * (e.g. a client that disconnects immediately after boot) is a silent
   * no-op, and a LATER `call()` would happily start a brand new GIMP
   * process behind a backend the host already considers shut down.
   */
  private closed = false;

  constructor(install: GimpInstall | null, opts: GimpBackendOptions = {}) {
    this.installInfo = install;
    this.sessionFactory = opts.sessionFactory ?? ((o) => new GimpSession(o));
    this.sessionOptions = opts.sessionOptions ?? {};
    const gimpPath = opts.gimpPath;
    this.detectGimpFn =
      opts.detectGimpFn ??
      (gimpPath
        ? () => detectGimp({ env: { ...process.env, EDITMAMEI_GIMP_PATH: gimpPath } })
        : () => detectGimp());
    this.redetectPending = opts.gimpDetectionTimedOut === true && install === null;
  }

  /** Whether a GIMP install was actually resolved (vs. registered anyway — a 'gimp' pin with none found, even after the post-timeout redetect). */
  get installed(): boolean {
    return this.installInfo !== null;
  }

  /** The resolved install (path + launch spec), or `null` when this backend was registered with none. */
  get install(): GimpInstall | null {
    return this.installInfo;
  }

  get gimpVersion(): string | undefined {
    return this.session?.gimpVersion;
  }

  get state(): string {
    return this.session?.state ?? 'idle';
  }

  /** See `GimpSession.lastStartOrigin`'s doc comment — undefined before any start has ever begun. */
  get startOrigin(): 'cold' | 'restarted' | undefined {
    return this.session?.lastStartOrigin;
  }

  private ensureSession(): GimpSession {
    if (this.closed) {
      // Same code + wording GimpSession itself uses when a call reaches it
      // after shutdown() has already run — a caller can't tell (and
      // shouldn't need to) whether the shutdown happened before or after a
      // session existed.
      throw new GimpError('gimp_session_restarted', 'session closed');
    }
    if (!this.installInfo) {
      // The registration matrix can register gimp_* tools with NO resolved
      // install (an `EDITMAMEI_EDITOR=gimp` pin on a machine with no GIMP, or
      // one where boot's time-boxed probe hadn't found it yet — see
      // `maybeRedetect`, already attempted by the time `call()` reaches
      // here) — every call fails with this one clear, actionable error
      // instead of the surface silently not existing.
      throw new GimpError(
        'gimp_not_installed',
        'no GIMP install was found on this machine. Install GIMP 3.2 or newer, or point at a ' +
          'gimp-console binary with the EDITMAMEI_GIMP_PATH environment variable, or by running ' +
          '`editmamei config set gimp_path <path>` (the gimp_path key in settings.json).'
      );
    }
    if (!this.session) {
      this.session = this.sessionFactory({ install: this.installInfo, ...this.sessionOptions });
    }
    return this.session;
  }

  /**
   * Runs the one post-boot-timeout `detectGimp()` retry, if one is still
   * owed (see `redetectPending`'s doc comment). A no-op on every other call —
   * both the already-resolved case and the already-attempted case return
   * immediately without touching the filesystem again.
   */
  private async maybeRedetect(): Promise<void> {
    if (!this.redetectPending) return;
    this.redetectPending = false;
    if (this.installInfo !== null) return;
    const found = await this.detectGimpFn();
    if (found) this.installInfo = found;
  }

  /**
   * Dispatch one bridge op. `timeoutMs`, when omitted, falls back to the
   * enclosing MCP tool call's remaining budget — the SAME mechanism
   * `runScript()` uses for Photoshop (`tool-budget-context.ts`, populated by
   * `ToolRegistry.execute` from `operation-timeouts.ts`'s per-tool table) —
   * so a `gimp_*` handler that runs several ops spends its tool's budget
   * once across all of them rather than getting it fresh per op.
   */
  async call<T = unknown>(
    op: string,
    args: Record<string, unknown> = {},
    timeoutMs?: number
  ): Promise<T> {
    await this.maybeRedetect();
    let effectiveTimeoutMs = timeoutMs;
    if (effectiveTimeoutMs === undefined) {
      const budget = currentToolBudget();
      if (budget) {
        const remaining = budget.deadline - Date.now();
        if (remaining <= 0) {
          throw new GimpError(
            'gimp_timeout',
            `Tool '${budget.toolName}' exceeded its ${budget.budgetMs}ms budget before ${op} could run.`
          );
        }
        effectiveTimeoutMs = remaining;
      }
    }
    return this.ensureSession().call<T>(op, args, { timeoutMs: effectiveTimeoutMs });
  }

  /**
   * Runs any detection retry the boot-time time box left owed, so the synchronous path helpers
   * below see an install found late. `call()` does this itself; a handler that needs a session
   * path BEFORE its first `call()` awaits this first.
   */
  async prepare(): Promise<void> {
    await this.maybeRedetect();
  }

  /** `<session root>/latest-preview.jpg` — the session's own helper; never build this path yourself. */
  latestPreviewPath(): string {
    return this.ensureSession().latestPreviewPath();
  }

  /** Atomically refresh the well-known preview path from a just-rendered file. */
  copyToLatestPreview(src: string): void {
    this.ensureSession().copyToLatestPreview(src);
  }

  /**
   * Absolute path for an internal temp output inside the session's root dir
   * — for a tool handler that needs to hand the bridge a filesystem path
   * without ever accepting one from the caller (e.g. `gimp_compare`'s
   * optional before/after preview exports).
   */
  tempPath(name: string): string {
    return this.ensureSession().tempPath(name);
  }

  /**
   * Shut down the underlying session, if one was ever started, and mark this
   * backend closed either way — a later `call()` (or any method that reaches
   * `ensureSession()`) always rejects afterward, even when no session had
   * been started yet. Idempotent (delegates to GimpSession's own memoized
   * shutdown when a session exists).
   */
  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.session) await this.session.shutdown();
  }
}
