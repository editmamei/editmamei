/**
 * TelemetryClient — batches content-free events and sends them to the telemetry Worker,
 * consent-gated and fire-and-forget (see docs/privacy.md, "Where it goes").
 *
 * Lifecycle: the server tees every tool call into `recordCall` (and failures into
 * `recordDiagnostic`) from the same `onCall` hook that feeds the session NDJSON. Events
 * batch in memory and flush on a timer / when the batch fills (near-real-time, in-session).
 * End-of-session data goes through the DURABLE OUTBOX (outbox.ts), not an exit-time send:
 * `shutdown` builds the `session_summary` and persists everything still pending to disk
 * synchronously; the NEXT server start uploads it via `flushOutboxOnStartup`. This is what
 * makes delivery survive the host killing the process at session end (the macOS bug).
 *
 * Gating, in two layers:
 *   - **active** — whether the client sends at all. False in the `dev` edition and under
 *     the test runner, so local dev / CI never phones home. (CE/Pro builds are active.)
 *   - **consent** — read live from settings on every record: `telemetry.usage` (Category
 *     A, opt-out) and `telemetry.diagnostics` (Category B, opt-in). When inactive the
 *     client is fully inert — it records nothing, so memory stays flat.
 *
 * Nothing here ever throws into the caller: a send failure drops the in-flight batch and
 * is logged at debug. Telemetry must never break or block a tool call.
 */

import { release } from 'node:os';
import { Logger } from '../utils/logger.js';
import { EDITION } from '../edition.js';
import { VERSION } from '../version.js';
import { resolveInstallChannel } from '../install-channel.js';
import type { Settings } from '../core/settings.js';
import {
  READ_ONLY_TOOLS,
  KEPT_WORK_TOOLS,
  nodeMajor,
  archToken,
  osMajor,
  boundMajor,
} from './activity.js';
import {
  buildClientConnected,
  buildDiagnosticEvent,
  buildModuleStatus,
  buildSessionStart,
  buildSessionSummary,
  buildUsageEvent,
  dayBucket,
  normalizeDayBucket,
  isContentSafe,
  PS_VERSION_UNKNOWN,
  type ModuleStatusInfo,
  type SessionSummaryEvent,
  type TelemetryDimensions,
  type TelemetryEvent,
} from './events.js';
import { sanitizeMessage, sanitizeSnippet, sanitizeStderrTail } from './sanitize.js';
import { httpTransport, resolveEndpoint, type TelemetryTransport } from './transport.js';
import {
  appendOutboxSync,
  clearOutbox,
  clearSessionState,
  readOutbox,
  readSessionState,
  writeSessionStateSync,
  type OutboxOptions,
  type PersistedSessionState,
} from './outbox.js';

/** Matches the server's MAX_EVENTS_PER_BATCH. */
const MAX_BATCH_SIZE = 100;
/** Bound in-memory growth if sends keep failing — drop oldest beyond this. */
const MAX_QUEUE_SIZE = 500;
/** Periodic flush cadence. */
const DEFAULT_FLUSH_INTERVAL_MS = 5 * 60_000;
/** Min wall-clock between session-state persists (cheap, but no need to write every call). */
const SESSION_PERSIST_THROTTLE_MS = 10_000;
/** Cap for `session_summary.duration_s` (7 days) — see the field's doc on the interface. */
const MAX_SESSION_DURATION_S = 604_800;
/** Cap for `session_summary.templates_saved` / `action_sets` — matches the server's field spec. */
const MAX_INSTALL_ASSET_COUNT = 100_000;

export interface RecordedCall {
  tool: string;
  success: boolean;
  duration_ms: number;
  error_class: string | null;
  /** Serialized result size in bytes (see utils/session-log.ts's computeResultBytes). */
  result_bytes?: number;
  /** Same tool + identically-serializing args as the immediately preceding call. Directional,
   *  not exact — see the retry-signal comment in core/server.ts for the two known biases. */
  retry?: boolean;
}

export interface RecordedDiagnostic {
  tool: string;
  error_class: string;
  error_message: string;
  snippet?: string;
  stderr_tail?: string;
  doc_depth?: 8 | 16 | 32;
  doc_mode?: 'rgb' | 'cmyk' | 'lab' | 'grayscale' | 'other';
  ps_locale?: string;
}

export interface TelemetryClientOptions {
  settings: Settings;
  /** Resolved lazily so ps_version is picked up once a ping identifies Photoshop. */
  getPsVersion: () => string | null;
  /**
   * Runtime entitlement ('community' | 'pro'), resolved by the server from
   * `isProEntitled()`. Defaults to the build `EDITION` when omitted (tests). The host
   * is always built `community`, so without this Pro usage is invisible — the server
   * passes the real value so telemetry reflects the loaded module, not the build.
   */
  edition?: string;
  /** Install channel ('npx' | 'npm_global' | 'mcpb' | 'source' | 'dev'). Defaults to
   *  `resolveInstallChannel()`. */
  channel?: string;
  /**
   * Boot-time Pro module outcome, resolved by the server AFTER `loadModules()`. Returns
   * null for a pure-CE install (no license record) → no `module_status` event is emitted.
   * Kept as a getter so it's read at `start()` time, when `loadModules` has settled.
   */
  getModuleStatus?: () => ModuleStatusInfo | null;
  /** Test seams — production uses the defaults. */
  transport?: TelemetryTransport;
  endpoint?: string;
  now?: () => Date;
  flushIntervalMs?: number;
  /** Per-batch cap (tests). Defaults to MAX_BATCH_SIZE (matches the server's limit). */
  maxBatchSize?: number;
  /** Force the active gate (tests). Defaults to: not dev edition and not under a test runner. */
  active?: boolean;
  /** Override the durable-outbox directory (tests). Defaults to `~/.editmamei`. */
  outboxDir?: string;
}

function isTestEnv(): boolean {
  return process.env.VITEST !== undefined || process.env.NODE_ENV === 'test';
}

export class TelemetryClient {
  private readonly logger = new Logger('Telemetry');
  private readonly settings: Settings;
  private readonly dims: TelemetryDimensions;
  private readonly transport: TelemetryTransport;
  private readonly endpoint: string;
  private readonly now: () => Date;
  private readonly flushIntervalMs: number;
  private readonly maxBatchSize: number;
  private readonly active: boolean;
  private readonly outboxOpts: OutboxOptions;
  private readonly getModuleStatus: () => ModuleStatusInfo | null;
  /**
   * Memoized result of `getModuleStatus()` — resolved at most once per session, lazily on
   * first use, rather than re-invoked on every persisted-state write. "Does this install
   * have a license record" doesn't change mid-session, and `persistSessionStateThrottled`
   * can call `summaryFields()` many times over a long session (throttled, but still). A
   * boxed `{ value }` wrapper distinguishes "not yet resolved" from "resolved to null" (a
   * pure-CE install), since `null` is itself a valid resolved value.
   */
  private resolvedModuleStatus: { value: ModuleStatusInfo | null } | null = null;

  private queue: TelemetryEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private shutdownPromise: Promise<void> | null = null;

  // Session-summary accumulators (Category A).
  private toolCallCount = 0;
  private readonly distinctTools = new Set<string>();
  private anyFailures = false;
  /** ms-epoch of the first / most recent recorded call this session — feeds duration_s. */
  private firstCallAtMs: number | null = null;
  private lastCallAtMs: number | null = null;
  /** Calls whose tool + args matched the immediately preceding call. */
  private retryCount = 0;
  /** The most recently recorded call's success — null until a call has been recorded. */
  private lastCallSuccess: boolean | null = null;
  /** Successful calls outside READ_ONLY_TOOLS / inside KEPT_WORK_TOOLS (activity.ts). */
  private editsOk = 0;
  private keptWork = 0;
  /**
   * Events dropped by `enqueue`'s MAX_QUEUE_SIZE trim this session. This is the IN-MEMORY
   * drop count only — `outbox.ts`'s own bounding (MAX_OUTBOX_EVENTS / MAX_OUTBOX_BYTES,
   * see readOutbox/appendOutboxSync) doesn't return how many lines it discarded, and adding
   * that return value would touch every caller of two already-widely-used functions for a
   * count this field only approximates anyway. Undercounts rather than requires that churn.
   */
  private droppedEvents = 0;
  /** Whether the boot-time update check found a strictly newer published version. null =
   *  never determined this session (check disabled, or it hadn't resolved by shutdown). */
  private behindLatest: boolean | null = null;
  /** Boot-time Pro-module background refresh outcome; only meaningful (and only sent) for
   *  installs with a license record — see doShutdown's getModuleStatus() gate. */
  private moduleUpdate: 'none' | 'updated' | 'failed' = 'none';
  /**
   * On-disk asset counts, read at ps_ping time. Each field is present only once THAT field
   * has actually been observed — merged per field (not replaced wholesale) by
   * setInstallAssets, so a later ping that only re-confirms one field (the other having
   * degraded that round) can't clobber an earlier good reading of the other.
   */
  private installAssets: { templates_saved?: number; action_sets?: number } = {};
  /** Throttle clock for session-state persistence. 0 = never persisted yet. */
  private lastSessionPersistMs = 0;
  /**
   * The day bucket this session is credited to — captured ONCE, on the first recorded call.
   * Both the clean-shutdown summary and the persisted session state reuse it instead of
   * re-deriving `dayBucket(this.now())` at their own call time, so a session crossing UTC
   * midnight lands on the day its first call ran rather than being split across two days.
   *
   * Deliberately NOT claimed in `start()`. An MCP host can stay resident for days, so a
   * server booted Monday and first used Wednesday would otherwise credit its summary to
   * Monday while every usage event landed on Wednesday.
   */
  private startDayBucket: string | null = null;

  constructor(opts: TelemetryClientOptions) {
    this.settings = opts.settings;
    this.transport = opts.transport ?? httpTransport();
    this.endpoint = opts.endpoint ?? resolveEndpoint();
    this.now = opts.now ?? (() => new Date());
    this.flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxBatchSize = opts.maxBatchSize ?? MAX_BATCH_SIZE;
    this.active = opts.active ?? (EDITION !== 'dev' && !isTestEnv());
    this.outboxOpts = opts.outboxDir ? { dir: opts.outboxDir } : {};
    this.getModuleStatus = opts.getModuleStatus ?? (() => null);
    this.dims = {
      install_id: this.settings.telemetry.install_id,
      editmamei_version: VERSION,
      edition: opts.edition ?? EDITION,
      platform: process.platform,
      channel: opts.channel ?? resolveInstallChannel(),
      getPsVersion: opts.getPsVersion,
    };
  }

  /** Whether this client will actually send (edition + environment gate). */
  isActive(): boolean {
    return this.active;
  }

  /** Start the periodic flush timer and emit a one-time boot ping. No-op when inactive. */
  start(): void {
    if (!this.active || this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.flushIntervalMs);
    // Don't keep the process alive solely for telemetry.
    this.timer.unref?.();
    // Boot ping (Category A, opt-out): the only signal a fresh install emits before any tool
    // call — without it an install that hasn't been used yet is invisible to the server. Flush
    // promptly so an install shows up without waiting out the periodic interval; a failed send
    // falls through to the outbox like any other batch.
    if (this.settings.telemetry.usage) {
      // Bounded to the server's field range (0..999 for both) — an out-of-range or
      // unparseable reading is omitted rather than risking a 400 on the whole batch.
      const hostNodeMajor = boundMajor(nodeMajor(), 999);
      const hostOsMajor = boundMajor(osMajor(process.platform, release()), 999);
      this.enqueue(
        buildSessionStart(this.dims, this.now(), {
          ...(hostNodeMajor !== null ? { node_major: hostNodeMajor } : {}),
          arch: archToken(),
          ...(hostOsMajor !== null ? { os_major: hostOsMajor } : {}),
        })
      );
      // Pro module boot outcome, alongside the ping — emitted only for installs with a
      // license record (moduleStatus() returns null otherwise), so a pure-CE host stays
      // silent. This is the signal that answers "did the subscriber's module actually load?".
      const moduleStatus = this.moduleStatus();
      if (moduleStatus) this.enqueue(buildModuleStatus(this.dims, moduleStatus, this.now()));
      void this.flush();
    }
  }

  /**
   * Record the connected MCP client's identity + capabilities (Category A, opt-out), once
   * per session from `Server.oninitialized` (see server.ts). Deliberately does NOT force its
   * own flush — it rides whichever of the boot flush, the periodic timer, the next batch-fill
   * flush, or (on a hard exit) the durable outbox gets to it first, the same as any other
   * enqueued event.
   */
  recordClientConnected(info: {
    clientName: string | undefined;
    clientVersion: string | undefined;
    capSampling: boolean;
    capElicitation: boolean;
    capRoots: boolean;
  }): void {
    if (!this.active || !this.settings.telemetry.usage) return;
    this.enqueue(buildClientConnected(this.dims, info, this.now()));
  }

  /** Record one tool call (Category A, opt-out). */
  recordCall(call: RecordedCall): void {
    if (!this.active || !this.settings.telemetry.usage) return;
    this.ensureStartDayBucket();
    const nowDate = this.now();
    const nowMs = nowDate.getTime();
    this.toolCallCount += 1;
    this.distinctTools.add(call.tool);
    if (!call.success) this.anyFailures = true;
    this.lastCallSuccess = call.success;
    if (call.retry) this.retryCount += 1;
    if (call.success) {
      if (!READ_ONLY_TOOLS.has(call.tool)) this.editsOk += 1;
      if (KEPT_WORK_TOOLS.has(call.tool)) this.keptWork += 1;
    }
    if (this.firstCallAtMs === null) this.firstCallAtMs = nowMs;
    this.lastCallAtMs = nowMs;
    this.enqueue(buildUsageEvent(this.dims, call, nowDate));
    this.persistSessionStateThrottled();
  }

  /** Whether the boot-time update check found a strictly newer published version. */
  setBehindLatest(value: boolean): void {
    this.behindLatest = value;
  }

  /** Record the boot-time Pro-module background refresh outcome (self-heal / freshness
   *  check in kernel/module-lifecycle.ts). */
  setModuleUpdate(outcome: 'updated' | 'failed'): void {
    this.moduleUpdate = outcome;
  }

  /**
   * Record the install's on-disk asset counts, read at ps_ping time. Merges per field
   * (rather than replacing the object) — pass only the fields this ping actually observed,
   * so a degraded field on one ping doesn't erase a good value an earlier ping recorded this
   * session. Each value is clamped to MAX_INSTALL_ASSET_COUNT before being kept, matching the
   * server's field bound.
   */
  setInstallAssets(assets: { templates_saved?: number; action_sets?: number }): void {
    this.installAssets = {
      ...this.installAssets,
      ...(assets.templates_saved !== undefined
        ? { templates_saved: clampCount(assets.templates_saved) }
        : {}),
      ...(assets.action_sets !== undefined ? { action_sets: clampCount(assets.action_sets) } : {}),
    };
  }

  /** Resolves + memoizes `getModuleStatus()` — see `resolvedModuleStatus`'s field doc. */
  private moduleStatus(): ModuleStatusInfo | null {
    if (this.resolvedModuleStatus === null) {
      this.resolvedModuleStatus = { value: this.getModuleStatus() };
    }
    return this.resolvedModuleStatus.value;
  }

  /** Wall-clock from the first recorded call to the last, in seconds, clamped to
   *  [0, MAX_SESSION_DURATION_S] — the lower bound guards a backward-stepping clock (a
   *  system clock adjustment mid-session) from sending a negative duration. undefined until
   *  a call has been recorded. */
  private durationS(): number | undefined {
    if (this.firstCallAtMs === null || this.lastCallAtMs === null) return undefined;
    return Math.min(
      Math.max(0, Math.floor((this.lastCallAtMs - this.firstCallAtMs) / 1000)),
      MAX_SESSION_DURATION_S
    );
  }

  /**
   * The new accumulator fields, shared verbatim by the persisted session state (so a
   * hard-killed session reconstructs the same summary a clean shutdown would have produced)
   * and the session_summary event itself. Each field is omitted rather than sent as
   * `unknown` when this session never learned it — see the module doc comment on events.ts.
   */
  private summaryFields(): {
    duration_s?: number;
    retry_count: number;
    ended_after_failure?: boolean;
    edits_ok: number;
    kept_work: number;
    behind_latest?: boolean;
    dropped_events: number;
    module_update?: 'none' | 'updated' | 'failed';
    templates_saved?: number;
    action_sets?: number;
  } {
    const duration = this.durationS();
    // module_update is sent ONLY for installs with a license record — a pure-CE install has
    // no module to report freshness on, so moduleStatus() returning null here means
    // "not applicable", not "unknown".
    const moduleStatus = this.moduleStatus();
    return {
      ...(duration !== undefined ? { duration_s: duration } : {}),
      retry_count: this.retryCount,
      ...(this.lastCallSuccess !== null ? { ended_after_failure: !this.lastCallSuccess } : {}),
      edits_ok: this.editsOk,
      kept_work: this.keptWork,
      ...(this.behindLatest !== null ? { behind_latest: this.behindLatest } : {}),
      dropped_events: this.droppedEvents,
      ...(moduleStatus !== null ? { module_update: this.moduleUpdate } : {}),
      ...(this.installAssets.templates_saved !== undefined
        ? { templates_saved: this.installAssets.templates_saved }
        : {}),
      ...(this.installAssets.action_sets !== undefined
        ? { action_sets: this.installAssets.action_sets }
        : {}),
    };
  }

  /** Current ps_version token, mirroring events.ts (placeholder until the first ping). */
  private psVersion(): string {
    const v = this.dims.getPsVersion();
    return v && v.length > 0 ? v : PS_VERSION_UNKNOWN;
  }

  /** The session's start-day bucket, captured on first use — see the field doc. */
  private ensureStartDayBucket(): string {
    if (this.startDayBucket === null) this.startDayBucket = dayBucket(this.now());
    return this.startDayBucket;
  }

  /**
   * Persist the running session accumulators so a process killed before any shutdown handler
   * runs can still have its session_summary reconstructed on next startup. Throttled: the
   * first call writes immediately (covers very short sessions), then at most once per
   * SESSION_PERSIST_THROTTLE_MS. Synchronous + best-effort (never throws into the caller).
   */
  private persistSessionStateThrottled(): void {
    const nowMs = this.now().getTime();
    if (
      this.lastSessionPersistMs !== 0 &&
      nowMs - this.lastSessionPersistMs < SESSION_PERSIST_THROTTLE_MS
    ) {
      return;
    }
    this.lastSessionPersistMs = nowMs;
    const state: PersistedSessionState = {
      install_id: this.dims.install_id,
      // The session's START bucket, not "now" — see startDayBucket's field doc. This is
      // what makes a hard-killed session's reconstructed summary (summaryFromState) agree
      // with what a clean shutdown would have produced for the same session.
      ts_bucket: this.ensureStartDayBucket(),
      editmamei_version: this.dims.editmamei_version,
      edition: this.dims.edition,
      platform: this.dims.platform,
      ps_version: this.psVersion(),
      tool_call_count: this.toolCallCount,
      distinct_tools: this.distinctTools.size,
      any_failures: this.anyFailures,
      ...this.summaryFields(),
    };
    writeSessionStateSync(state, this.outboxOpts);
  }

  /**
   * Refresh the persisted session-state snapshot when the first ping resolves the PS version.
   * Without this, a session whose tool calls all ran before the ping (so the snapshot was
   * stamped with the `unknown` placeholder) would, if later hard-killed, reconstruct its
   * summary with `ps_version: 'unknown'`. Re-persisting once the version is known fixes that
   * dimension. No-op until a call has been recorded (a 0-call session reconstructs nothing).
   */
  onPsVersionResolved(): void {
    if (!this.active || !this.settings.telemetry.usage || this.toolCallCount === 0) return;
    this.lastSessionPersistMs = 0; // bypass the throttle for this one-time refresh
    this.persistSessionStateThrottled();
  }

  /** Record one failure's diagnostic detail (Category B, opt-in). Message is sanitized. */
  recordDiagnostic(diag: RecordedDiagnostic): void {
    if (!this.active || !this.settings.telemetry.diagnostics) return;
    this.enqueue(
      buildDiagnosticEvent(
        this.dims,
        {
          tool: diag.tool,
          error_class: diag.error_class,
          error_message: sanitizeMessage(diag.error_message),
          ...(diag.snippet ? { snippet: sanitizeSnippet(diag.snippet) } : {}),
          ...(diag.stderr_tail ? { stderr_tail: sanitizeStderrTail(diag.stderr_tail) } : {}),
          ...(diag.doc_depth !== undefined ? { doc_depth: diag.doc_depth } : {}),
          ...(diag.doc_mode !== undefined ? { doc_mode: diag.doc_mode } : {}),
          ...(diag.ps_locale !== undefined ? { ps_locale: diag.ps_locale } : {}),
        },
        this.now()
      )
    );
  }

  /**
   * Stamp the resolved PS version onto queued events that were built before the first ping
   * identified Photoshop. Events carry their dimensions from `recordCall` time, but a batch
   * does not leave until the flush timer fires (5 min) or 100 events accumulate — so a
   * session that drives tools during startup splits across two `ps_version` dimensions, and
   * every per-version breakdown of one user's day reads as two.
   *
   * Only `PS_VERSION_UNKNOWN` is overwritten: a real version already on an event is the one
   * that was true when it was recorded, and re-stamping it would launder a genuine mid-session
   * change. When the version is still unresolved, `unknown` is the honest answer and stays.
   *
   * **In-memory events only, before serialization.** The durable outbox holds batches from a
   * PREVIOUS process, whose `unknown` events belong to a Photoshop session this one knows
   * nothing about — `flushOutboxOnStartup` deliberately does not come through here. Mutates
   * in place; the caller has already detached the batch from the queue.
   *
   * Scope is every queued event carrying a `ps_version` dimension — usage, and in principle
   * session_start/diagnostic too (session_start flushes at boot before a ping can resolve,
   * so its `unknown` genuinely means "not yet detected at boot" and in practice never waits
   * long enough to be re-stamped).
   */
  private restampPsVersion(events: TelemetryEvent[]): TelemetryEvent[] {
    const resolved = this.dims.getPsVersion();
    if (!resolved) return events;
    for (const event of events) {
      // module_status is the one event with no ps_version dimension, and
      // session_summary stamps its own dims at build time — it rides the
      // same queue at shutdown but is deliberately out of re-stamp scope,
      // so a future change that builds it earlier can't launder its version.
      if (event.type === 'session_summary') continue;
      if ('ps_version' in event && event.ps_version === PS_VERSION_UNKNOWN) {
        event.ps_version = resolved;
      }
    }
    return events;
  }

  private enqueue(event: TelemetryEvent): void {
    this.queue.push(event);
    if (this.queue.length > MAX_QUEUE_SIZE) {
      // Drop oldest — newer signal is more useful, and we must stay bounded.
      const excess = this.queue.length - MAX_QUEUE_SIZE;
      this.queue.splice(0, excess);
      this.droppedEvents += excess;
    }
    if (this.queue.length >= this.maxBatchSize) void this.flush();
  }

  /**
   * Send one batch (up to MAX_BATCH_SIZE). Content-unsafe events are dropped (never sent
   * dirty) so one path-leaking value can't get the whole batch rejected. On send failure the
   * batch is persisted to the durable outbox for a retry on next startup (was: dropped).
   * Never throws.
   */
  async flush(): Promise<void> {
    if (!this.active || this.queue.length === 0) return;
    const batch = this.restampPsVersion(this.queue.splice(0, this.maxBatchSize)).filter(
      isContentSafe
    );
    if (batch.length === 0) return;
    try {
      await this.transport(this.endpoint, JSON.stringify({ events: batch }));
    } catch (err) {
      this.logger.debug(
        `telemetry flush failed, persisting ${batch.length} event(s) to outbox: ${errMsg(err)}`
      );
      appendOutboxSync(batch, this.outboxOpts);
    }
  }

  /**
   * Session end: build the summary and persist everything still pending to the durable
   * outbox with a SYNCHRONOUS write, then clear the session-state marker. Called on
   * server/transport close AND the SIGINT/SIGTERM handler in index.ts.
   *
   * **We deliberately do NOT network-send here.** An exit-time async POST can't be relied on
   * — the host (Claude Desktop on macOS) tears the process down before it completes, so the
   * final batch + session_summary were being lost (v0.16.2/.3). Instead we hand the data to
   * the outbox, which the NEXT startup delivers. The sync write completes even as the process
   * is killed; the async fetch did not.
   *
   * **Memoized** so the two shutdown paths (onclose + a following SIGTERM) don't both write
   * the queue — the first call owns the drain, later callers await the same resolved promise.
   * Clearing the session state here is what guarantees a clean session and a hard-killed one
   * can't BOTH produce a summary (a clean shutdown removes the marker the startup path reads).
   */
  shutdown(): Promise<void> {
    if (!this.shutdownPromise) this.shutdownPromise = this.doShutdown();
    return this.shutdownPromise;
  }

  private async doShutdown(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (!this.active) return;
    if (this.settings.telemetry.usage && this.toolCallCount > 0) {
      this.enqueue(
        buildSessionSummary(
          this.dims,
          {
            tool_call_count: this.toolCallCount,
            distinct_tools: this.distinctTools.size,
            any_failures: this.anyFailures,
            ...this.summaryFields(),
          },
          // Start-day bucket, not the shutdown-time day — see startDayBucket's field doc.
          // toolCallCount > 0 guarantees recordCall already ran, so this is never the
          // first-ever call of ensureStartDayBucket() at shutdown time.
          this.ensureStartDayBucket(),
          this.now()
        )
      );
    }
    if (this.queue.length > 0) {
      appendOutboxSync(
        this.restampPsVersion(this.queue.splice(0)).filter(isContentSafe),
        this.outboxOpts
      );
    }
    // Clean end — drop the marker so the startup path won't reconstruct a duplicate summary.
    clearSessionState(this.outboxOpts);
  }

  /**
   * Deliver anything the previous run(s) left behind. Runs once at server start, when the
   * event loop is healthy (the conditions an exit-time send lacks):
   *   1. If a session-state marker survives, the previous session was killed before a clean
   *      shutdown — reconstruct its summary and add it to the outbox.
   *   2. Drain the outbox to the server in batches; clear it only if every batch is accepted.
   * Respects CURRENT consent: if usage telemetry is now off, the backlog is dropped unsent.
   * Best-effort and fire-and-forget — never throws, never blocks boot.
   */
  async flushOutboxOnStartup(): Promise<void> {
    if (!this.active) return;
    try {
      const stale = readSessionState(this.outboxOpts);
      if (stale && this.settings.telemetry.usage && stale.tool_call_count > 0) {
        appendOutboxSync([summaryFromState(stale)], this.outboxOpts);
      }
      clearSessionState(this.outboxOpts);

      const pending = readOutbox(this.outboxOpts);
      if (pending.length === 0) {
        clearOutbox(this.outboxOpts);
        return;
      }
      // Consent is read live: a user who turned usage off between sessions doesn't want the
      // backlog sent. (Everything in the outbox was consented when recorded, but respect now.)
      if (!this.settings.telemetry.usage) {
        clearOutbox(this.outboxOpts);
        return;
      }
      let allAccepted = true;
      for (let i = 0; i < pending.length; i += this.maxBatchSize) {
        const batch = pending.slice(i, i + this.maxBatchSize).filter(isContentSafe);
        if (batch.length === 0) continue;
        try {
          await this.transport(this.endpoint, JSON.stringify({ events: batch }));
        } catch (err) {
          this.logger.debug(`startup outbox flush failed: ${errMsg(err)}`);
          allAccepted = false;
          break; // keep the remainder for the next startup
        }
      }
      if (allAccepted) clearOutbox(this.outboxOpts);
    } catch (err) {
      this.logger.debug(`startup outbox flush error: ${errMsg(err)}`);
    }
  }

  /** @internal test accessor */
  pendingCount(): number {
    return this.queue.length;
  }
}

/**
 * Reconstruct a session_summary event from persisted state (a killed-session recovery).
 * Every new accumulator is optional on PersistedSessionState (backward-compat with a state
 * file written by an older version), so each is carried through only when present rather
 * than reconstructed as a false zero/false.
 */
function summaryFromState(s: PersistedSessionState): SessionSummaryEvent {
  return {
    v: 2,
    type: 'session_summary',
    install_id: s.install_id,
    // Same clamp the clean path gets: this value came off disk, where a truncated or
    // hand-edited file can hold anything, and one bad bucket rejects the whole batch.
    ts_bucket: normalizeDayBucket(s.ts_bucket, new Date()),
    editmamei_version: s.editmamei_version,
    edition: s.edition,
    platform: s.platform,
    ps_version: s.ps_version,
    tool_call_count: s.tool_call_count,
    distinct_tools: s.distinct_tools,
    any_failures: s.any_failures,
    ...(s.duration_s !== undefined ? { duration_s: s.duration_s } : {}),
    ...(s.retry_count !== undefined ? { retry_count: s.retry_count } : {}),
    ...(s.ended_after_failure !== undefined ? { ended_after_failure: s.ended_after_failure } : {}),
    ...(s.edits_ok !== undefined ? { edits_ok: s.edits_ok } : {}),
    ...(s.kept_work !== undefined ? { kept_work: s.kept_work } : {}),
    ...(s.behind_latest !== undefined ? { behind_latest: s.behind_latest } : {}),
    ...(s.dropped_events !== undefined ? { dropped_events: s.dropped_events } : {}),
    ...(s.module_update !== undefined ? { module_update: s.module_update } : {}),
    ...(s.templates_saved !== undefined ? { templates_saved: s.templates_saved } : {}),
    ...(s.action_sets !== undefined ? { action_sets: s.action_sets } : {}),
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Clamp an install-asset count to [0, MAX_INSTALL_ASSET_COUNT] — matches the server's field
 *  bound on `templates_saved` / `action_sets`. */
function clampCount(n: number): number {
  return Math.min(Math.max(0, n), MAX_INSTALL_ASSET_COUNT);
}
