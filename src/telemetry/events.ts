/**
 * Telemetry event shapes + builders. These mirror the telemetry server's accepted
 * schemas exactly (telemetry-server/src/routes/telemetry.ts, design §4). Every field is
 * content-free by construction: there is no image, path, or PII here. Category A events
 * (usage / session_summary) carry no free text at all; the Category B diagnostic message
 * is sanitized upstream (see sanitize.ts) before it reaches a DiagnosticEvent.
 *
 * Every field added after `v: 2` shipped is OPTIONAL: a builder omits it when the caller
 * doesn't know it, rather than sending `null` — `client_major` on `ClientConnectedEvent` is
 * the one deliberate exception (a connected client with an unparseable version is still a
 * known fact, not an absent one).
 */

import { mapClientName, parseMajor, boundMajor } from './activity.js';

/** Schema version — must match the server's `v` field. */
export const TELEMETRY_SCHEMA_VERSION = 2;

/** Dimensions shared by every event, resolved once at client construction. */
export interface TelemetryDimensions {
  install_id: string;
  editmamei_version: string;
  /**
   * Runtime entitlement, not the build edition. The shipped host is always
   * `EDITION='community'` (Pro is a downloaded module), so this MUST be resolved
   * from `isProEntitled()` at construction — else Pro usage is invisible. The
   * server folds it into `installs_seen.edition` + the per-activity rollups.
   */
  edition: string;
  platform: string;
  /** Install channel: 'npx' | 'npm_global' | 'npm_local' | 'mcpb' | 'source' | 'dev'.
   *  Attached to the boot ping only. */
  channel: string;
  /** Resolved lazily — null until the first PS connection identifies the version. */
  getPsVersion: () => string | null;
}

/**
 * Boot-time outcome of the downloaded Pro module, for the `module_status` event.
 * Content-free by construction: an enum outcome + the module's own version/abi.
 * `null` from the server means "no license record on this machine" → don't emit
 * (a pure-CE install has no module to report on).
 */
export interface ModuleStatusInfo {
  /** Which module — 'pro' today; future-proofed for add-ons. */
  module: string;
  /**
   * loaded — Pro module active this session.
   * absent — entitled, but no module installed yet (awaiting first provision).
   * lapsed — a license record exists but is no longer entitled (grace-expired/revoked).
   * skipped_corrupt — entitled, on-disk module present but unverifiable.
   * skipped_incompatible — entitled, module ABI too old / classification rolled back.
   */
  outcome: string;
  /** The installed module's semver, or null when no readable pointer exists. */
  module_version: string | null;
  /** The installed module's host↔module ABI, or null when unknown. */
  abi: number | null;
}

export interface UsageEvent {
  v: 2;
  type: 'usage';
  install_id: string;
  ts_bucket: string;
  editmamei_version: string;
  edition: string;
  platform: string;
  ps_version: string;
  tool: string;
  success: boolean;
  error_class: string | null;
  duration_ms: number;
  /** Serialized result size in bytes (see utils/session-log.ts's computeResultBytes),
   *  clamped to MAX_RESULT_BYTES. Omitted when the caller doesn't have a result to size. */
  result_bytes?: number;
}

export interface SessionSummaryEvent {
  v: 2;
  type: 'session_summary';
  install_id: string;
  ts_bucket: string;
  editmamei_version: string;
  edition: string;
  platform: string;
  ps_version: string;
  tool_call_count: number;
  distinct_tools: number;
  any_failures: boolean;
  /** Wall-clock from the first recorded call to the last, in seconds. Capped at 604_800
   *  (7 days) — a session left running for weeks shouldn't skew the aggregate. */
  duration_s?: number;
  /** Calls whose tool + args matched the immediately preceding call (compared by a local
   *  hash that is never sent). */
  retry_count?: number;
  /** True when the LAST recorded call of the session failed. */
  ended_after_failure?: boolean;
  /** Successful calls to a tool outside READ_ONLY_TOOLS (core/tool-activity.ts). */
  edits_ok?: number;
  /** Successful calls to a tool in KEPT_WORK_TOOLS (core/tool-activity.ts) — ps_export / ps_save_psd. */
  kept_work?: number;
  /** Whether the boot-time update check found a strictly newer published version. */
  behind_latest?: boolean;
  /** In-memory events dropped by the client's MAX_QUEUE_SIZE trim this session. */
  dropped_events?: number;
  /**
   * Events discarded by the on-disk outbox during this RUN — its MAX_OUTBOX_EVENTS /
   * MAX_OUTBOX_BYTES bound dropping oldest, a corrupt line that would not parse, or an
   * append that failed to write.
   *
   * "Run", not "session": the startup drain is where the bound's discards are observed, and
   * what it discards belongs to a PREVIOUS session's backlog. The same applies to
   * `usage_calls_sent`. These three telescope correctly when summed across sessions, which is
   * how they are meant to be read; a single summary's ratio against its own
   * `tool_call_count` does not mean anything.
   */
  dropped_outbox?: number;
  /** Events discarded by the client's own `isContentSafe` filter during this run. */
  dropped_unsafe?: number;
  /**
   * Tool CALLS this RUN handed to a transport call that returned without throwing —
   * client-believed-delivered, and including calls carried over from an earlier session's
   * outbox backlog (see `dropped_outbox` on why this is a run, not a session).
   * Note the unit: the two `dropped_*` fields above count EVENTS,
   * because that is what the pipeline discards, but `tool_call_count` and the server's
   * `usage_daily.call_count` are both CALL counts — so a denominator comparable to either
   * has to be in calls. Once one event can stand for many calls, an events-based figure here
   * would silently turn the delivery rate into nonsense.
   *
   * These four counters do NOT form a closed identity. They cover client-side discards only;
   * a batch the server rejects, a host killed with a full outbox, or consent revoked between
   * sessions all leave the calls counted as sent with no `dropped_*` moving. The residual is
   * the transport-loss signal, not a bug in the counters.
   */
  usage_calls_sent?: number;
  /** Boot-time Pro-module background refresh outcome. Included only for installs with a
   *  license record (see TelemetryClient.setModuleUpdate) — a pure-CE install sends nothing. */
  module_update?: 'none' | 'updated' | 'failed';
  /** Count of user templates on disk at ps_ping time (see ps_ping's user_templates). */
  templates_saved?: number;
  /** Count of custom action sets at ps_ping time (see ps_ping's custom_action_sets). */
  action_sets?: number;
}

/**
 * Sent once per server boot (Category A, opt-out), before any tool call. This is the only
 * signal that an install exists and is being launched — without it, a fresh install that
 * never drives a tool call (or hasn't yet) is invisible to the server. Content-free: the
 * same dimensions as every other Category A event, no counts, no free text. The server
 * folds it into `installs_seen` (so first-/last-seen + distinct-install tracking light up
 * immediately) without touching the per-activity rollups that `session_summary` owns.
 */
export interface SessionStartEvent {
  v: 2;
  type: 'session_start';
  install_id: string;
  ts_bucket: string;
  editmamei_version: string;
  edition: string;
  platform: string;
  ps_version: string;
  /**
   * Install channel ('npx' | 'npm_global' | 'npm_local' | 'mcpb' | 'source'). Carried on the
   * boot ping only — it's a stable per-install attribute, so the server stores it once in
   * `installs_seen` (no daily rollup), keep-first-known. The dev edition is
   * telemetry-inert, so 'dev' never reaches the wire.
   */
  channel: string;
  /** Node.js major version the server is running under (activity.ts's nodeMajor()), bounded
   *  to 0..999; omitted when unparseable or out of range. */
  node_major?: number;
  /** CPU architecture bucket (activity.ts's archToken()). */
  arch?: 'x64' | 'arm64' | 'other';
  /** Host OS major version (activity.ts's osMajor()), bounded to 0..999; omitted when
   *  unparseable or out of range. */
  os_major?: number;
}

/**
 * Sent once per session, when the MCP client's `initialize` handshake completes
 * (Category A, opt-out) — see `Server.oninitialized` in server.ts. Content-free: the
 * client's self-reported name is mapped to a fixed enum (never the raw string), its
 * version is reduced to a bare major, and the three capability flags are booleans. A
 * client that never initializes (the transport never completes the handshake) sends
 * nothing here — there is no fallback "eventually" send.
 */
export interface ClientConnectedEvent {
  v: 2;
  type: 'client_connected';
  install_id: string;
  ts_bucket: string;
  editmamei_version: string;
  edition: string;
  platform: string;
  /** The connected MCP client's self-reported name, mapped via activity.ts's mapClientName. */
  client: ReturnType<typeof mapClientName>;
  /** Leading major of the client's self-reported version, bounded to 0..9999. Deliberately
   *  nullable — see the module doc comment: this is the one field allowed to carry `null` on
   *  the wire, sent both for an unparseable version and one outside the bound. */
  client_major: number | null;
  cap_sampling?: boolean;
  cap_elicitation?: boolean;
  cap_roots?: boolean;
}

/**
 * Sent once per server boot (Category A, opt-out) for installs that HAVE a license
 * record — i.e. current or lapsed Pro. It answers "did this subscriber's Pro module
 * actually load?", which the `edition` dimension alone can't: a subscriber whose
 * module failed to verify/download still reports usage as community, indistinguishable
 * from a free user. Content-free: an enum outcome + the module's own version/abi. A
 * pure-CE install (no license) emits nothing here.
 */
export interface ModuleStatusEvent {
  v: 2;
  type: 'module_status';
  install_id: string;
  ts_bucket: string;
  editmamei_version: string;
  edition: string;
  platform: string;
  module: string;
  outcome: string;
  module_version: string | null;
  abi: number | null;
}

export interface DiagnosticEvent {
  v: 2;
  type: 'diagnostic';
  install_id: string;
  ts_bucket: string;
  editmamei_version: string;
  platform: string;
  ps_version: string;
  tool: string;
  error_class: string;
  error_message: string;
  snippet?: string;
  stderr_tail?: string;
  /** Active document's bit depth at the last successful ping. */
  doc_depth?: 8 | 16 | 32;
  /** Active document's color mode at the last successful ping. */
  doc_mode?: 'rgb' | 'cmyk' | 'lab' | 'grayscale' | 'other';
  /** Photoshop's UI locale (`app.locale`, e.g. "en_US") from the last successful ping. Only
   *  ever sent when it matches the server's `^[a-z]{2,3}_[A-Z]{2}$` token shape. */
  ps_locale?: string;
}

export type TelemetryEvent =
  | UsageEvent
  | SessionSummaryEvent
  | SessionStartEvent
  | ClientConnectedEvent
  | ModuleStatusEvent
  | DiagnosticEvent;

/**
 * ps_version is `null` until the first ping identifies Photoshop, but the server requires
 * a non-null token. Send a content-free placeholder in that window (the server's
 * PS_VERSION pattern accepts lowercase letters specifically so this passes).
 */
export const PS_VERSION_UNKNOWN = 'unknown';

/** Clamp for `UsageEvent.result_bytes` (16 MiB) — a pathological result must not inflate
 *  the wire payload or the server's stored aggregates without bound. */
export const MAX_RESULT_BYTES = 16_777_216;

/** Photoshop UI-locale token shape the server accepts (e.g. "en_US"). */
const PS_LOCALE_RE = /^[a-z]{2,3}_[A-Z]{2}$/;

/** Day-granularity bucket (`YYYY-MM-DD`) — never a precise timestamp (design §4). */
export function dayBucket(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Force an error-class string into the server's token shape (`^[a-z0-9_]{1,48}$`). The
 * source is `classifyError()`, whose current outputs already conform — but one bad event
 * 400s the WHOLE batch on the server, so we clamp defensively rather than trust the
 * upstream table to never grow a non-conforming class. Empty result → 'other'.
 */
export function normalizeErrorClass(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .slice(0, 48);
  return cleaned.length > 0 ? cleaned : 'other';
}

/**
 * Force a day bucket into the server's `^\d{4}-\d{2}-\d{2}$` shape. Every in-tree caller
 * passes a `dayBucket()` result, which conforms by construction — but this value now
 * arrives as a string rather than being derived here, and one malformed event 400s the
 * WHOLE batch on the server. Same defensive reasoning as `normalizeErrorClass`. A value
 * that does not conform falls back to the current UTC day.
 */
export function normalizeDayBucket(value: string, now: Date): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : dayBucket(now);
}

function psVersionOf(dims: TelemetryDimensions): string {
  const v = dims.getPsVersion();
  return v && v.length > 0 ? v : PS_VERSION_UNKNOWN;
}

export function buildUsageEvent(
  dims: TelemetryDimensions,
  call: {
    tool: string;
    success: boolean;
    duration_ms: number;
    error_class: string | null;
    result_bytes?: number;
  },
  now: Date
): UsageEvent {
  return {
    v: TELEMETRY_SCHEMA_VERSION,
    type: 'usage',
    install_id: dims.install_id,
    ts_bucket: dayBucket(now),
    editmamei_version: dims.editmamei_version,
    edition: dims.edition,
    platform: dims.platform,
    ps_version: psVersionOf(dims),
    tool: call.tool,
    success: call.success,
    error_class: call.error_class === null ? null : normalizeErrorClass(call.error_class),
    duration_ms: call.duration_ms,
    ...(call.result_bytes !== undefined
      ? { result_bytes: Math.min(call.result_bytes, MAX_RESULT_BYTES) }
      : {}),
  };
}

/**
 * `tsBucket` is the SESSION'S START day, not "now" — a session spanning UTC midnight is
 * credited to the day its first call ran, rather than being split across two days. Callers
 * capture it once, on the first recorded call, and both the clean-shutdown summary and the
 * persisted crash-recovery state replay that same value — see `TelemetryClient`'s
 * `startDayBucket`. Clamped on the way out because the shape is no longer derived here.
 */
export function buildSessionSummary(
  dims: TelemetryDimensions,
  summary: {
    tool_call_count: number;
    distinct_tools: number;
    any_failures: boolean;
    duration_s?: number;
    retry_count?: number;
    ended_after_failure?: boolean;
    edits_ok?: number;
    kept_work?: number;
    behind_latest?: boolean;
    dropped_events?: number;
    dropped_outbox?: number;
    dropped_unsafe?: number;
    usage_calls_sent?: number;
    module_update?: 'none' | 'updated' | 'failed';
    templates_saved?: number;
    action_sets?: number;
  },
  tsBucket: string,
  now: Date
): SessionSummaryEvent {
  return {
    v: TELEMETRY_SCHEMA_VERSION,
    type: 'session_summary',
    install_id: dims.install_id,
    ts_bucket: normalizeDayBucket(tsBucket, now),
    editmamei_version: dims.editmamei_version,
    edition: dims.edition,
    platform: dims.platform,
    ps_version: psVersionOf(dims),
    tool_call_count: summary.tool_call_count,
    distinct_tools: summary.distinct_tools,
    any_failures: summary.any_failures,
    ...(summary.duration_s !== undefined ? { duration_s: summary.duration_s } : {}),
    ...(summary.retry_count !== undefined ? { retry_count: summary.retry_count } : {}),
    ...(summary.ended_after_failure !== undefined
      ? { ended_after_failure: summary.ended_after_failure }
      : {}),
    ...(summary.edits_ok !== undefined ? { edits_ok: summary.edits_ok } : {}),
    ...(summary.kept_work !== undefined ? { kept_work: summary.kept_work } : {}),
    ...(summary.behind_latest !== undefined ? { behind_latest: summary.behind_latest } : {}),
    ...(summary.dropped_events !== undefined ? { dropped_events: summary.dropped_events } : {}),
    ...(summary.dropped_outbox !== undefined ? { dropped_outbox: summary.dropped_outbox } : {}),
    ...(summary.dropped_unsafe !== undefined ? { dropped_unsafe: summary.dropped_unsafe } : {}),
    ...(summary.usage_calls_sent !== undefined
      ? { usage_calls_sent: summary.usage_calls_sent }
      : {}),
    ...(summary.module_update !== undefined ? { module_update: summary.module_update } : {}),
    ...(summary.templates_saved !== undefined ? { templates_saved: summary.templates_saved } : {}),
    ...(summary.action_sets !== undefined ? { action_sets: summary.action_sets } : {}),
  };
}

export function buildSessionStart(
  dims: TelemetryDimensions,
  now: Date,
  facts: { node_major?: number; arch?: 'x64' | 'arm64' | 'other'; os_major?: number } = {}
): SessionStartEvent {
  return {
    v: TELEMETRY_SCHEMA_VERSION,
    type: 'session_start',
    install_id: dims.install_id,
    ts_bucket: dayBucket(now),
    editmamei_version: dims.editmamei_version,
    edition: dims.edition,
    platform: dims.platform,
    ps_version: psVersionOf(dims),
    channel: dims.channel,
    ...(facts.node_major !== undefined ? { node_major: facts.node_major } : {}),
    ...(facts.arch !== undefined ? { arch: facts.arch } : {}),
    ...(facts.os_major !== undefined ? { os_major: facts.os_major } : {}),
  };
}

/**
 * Sent once per session from `Server.oninitialized` (see server.ts's comment on WHY that
 * hook, not connect(), is the right point) — no ps_version dimension exists here (unlike
 * usage/session_summary/session_start/diagnostic), and `restampPsVersion` in client.ts
 * tolerates that the same way it already tolerates `module_status`: via `'ps_version' in
 * event`, which is simply false for this type.
 */
export function buildClientConnected(
  dims: TelemetryDimensions,
  info: {
    clientName: string | undefined;
    clientVersion: string | undefined;
    capSampling: boolean;
    capElicitation: boolean;
    capRoots: boolean;
  },
  now: Date
): ClientConnectedEvent {
  return {
    v: TELEMETRY_SCHEMA_VERSION,
    type: 'client_connected',
    install_id: dims.install_id,
    ts_bucket: dayBucket(now),
    editmamei_version: dims.editmamei_version,
    edition: dims.edition,
    platform: dims.platform,
    client: mapClientName(info.clientName),
    // Bounded to the server's CLIENT_MAJOR range (0..9999) — an out-of-range parse (a
    // garbled or hostile version string) degrades to null, the same value space as an
    // unparseable one, rather than 400ing the whole batch.
    client_major: boundMajor(parseMajor(info.clientVersion), 9999),
    cap_sampling: info.capSampling,
    cap_elicitation: info.capElicitation,
    cap_roots: info.capRoots,
  };
}

export function buildModuleStatus(
  dims: TelemetryDimensions,
  status: ModuleStatusInfo,
  now: Date
): ModuleStatusEvent {
  return {
    v: TELEMETRY_SCHEMA_VERSION,
    type: 'module_status',
    install_id: dims.install_id,
    ts_bucket: dayBucket(now),
    editmamei_version: dims.editmamei_version,
    edition: dims.edition,
    platform: dims.platform,
    module: status.module,
    outcome: status.outcome,
    module_version: status.module_version,
    abi: status.abi,
  };
}

export function buildDiagnosticEvent(
  dims: TelemetryDimensions,
  diag: {
    tool: string;
    error_class: string;
    error_message: string;
    snippet?: string;
    stderr_tail?: string;
    doc_depth?: 8 | 16 | 32;
    doc_mode?: 'rgb' | 'cmyk' | 'lab' | 'grayscale' | 'other';
    /** Filtered against PS_LOCALE_RE below — a non-conforming value is silently omitted
     *  rather than sent, the same "degrade, never break the batch" discipline as
     *  normalizeErrorClass. */
    ps_locale?: string;
  },
  now: Date
): DiagnosticEvent {
  return {
    v: TELEMETRY_SCHEMA_VERSION,
    type: 'diagnostic',
    install_id: dims.install_id,
    ts_bucket: dayBucket(now),
    editmamei_version: dims.editmamei_version,
    platform: dims.platform,
    ps_version: psVersionOf(dims),
    tool: diag.tool,
    error_class: normalizeErrorClass(diag.error_class),
    error_message: diag.error_message,
    ...(diag.snippet ? { snippet: diag.snippet } : {}),
    ...(diag.stderr_tail ? { stderr_tail: diag.stderr_tail } : {}),
    ...(diag.doc_depth !== undefined ? { doc_depth: diag.doc_depth } : {}),
    ...(diag.doc_mode !== undefined ? { doc_mode: diag.doc_mode } : {}),
    ...(diag.ps_locale !== undefined && PS_LOCALE_RE.test(diag.ps_locale)
      ? { ps_locale: diag.ps_locale }
      : {}),
  };
}

/**
 * Client-side mirror of the server's absolute-path guard. We pre-filter every event with
 * this before batching so a single path-leaking value can never poison the whole batch
 * (the server rejects the entire request on one bad event). Defense-in-depth behind the
 * sanitizer — a filtered event is dropped, never sent dirty.
 */
export function looksLikeAbsolutePath(value: string): boolean {
  return (
    /^[A-Za-z]:[\\/]/.test(value) ||
    /^[\\/]/.test(value) ||
    value.includes('\\') ||
    /^file:\/\//i.test(value) ||
    // Mid-string multi-segment POSIX path. sanitizeMessage strips the LEADING
    // separator, so a residual absolute path (`/Users/alice/x.psd`) is mid-string
    // by guard time and the leading-`/` clause above misses it. Two-or-more
    // `/segment` runs read as a real path; a single `/word` (`I/O`, `read/write`,
    // or a `http://x` token whose `//` yields one segment) is left alone.
    /(?:\/[^\s/]+){2,}/.test(value)
  );
}

/** True when no string field in the event looks like a filesystem path. */
export function isContentSafe(event: TelemetryEvent): boolean {
  for (const value of Object.values(event)) {
    if (typeof value === 'string' && looksLikeAbsolutePath(value)) return false;
  }
  return true;
}
