/**
 * Telemetry event shapes + builders. These mirror the telemetry server's accepted
 * schemas exactly (telemetry-server/src/routes/telemetry.ts, design §4). Every field is
 * content-free by construction: there is no image, path, or PII here. Category A events
 * (usage / session_summary) carry no free text at all; the Category B diagnostic message
 * is sanitized upstream (see sanitize.ts) before it reaches a DiagnosticEvent.
 */

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
  /** Install channel: 'npm' | 'mcpb' | 'dev'. Attached to the boot ping only. */
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
   * Install channel ('npm' | 'mcpb'). Carried on the boot ping only — it's a stable
   * per-install attribute, so the server stores it once in `installs_seen` (no daily
   * rollup), keep-first-known. The dev edition is telemetry-inert, so 'dev' never
   * reaches the wire.
   */
  channel: string;
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
}

export type TelemetryEvent =
  UsageEvent | SessionSummaryEvent | SessionStartEvent | ModuleStatusEvent | DiagnosticEvent;

/**
 * ps_version is `null` until the first ping identifies Photoshop, but the server requires
 * a non-null token. Send a content-free placeholder in that window (the server's
 * PS_VERSION pattern accepts lowercase letters specifically so this passes).
 */
export const PS_VERSION_UNKNOWN = 'unknown';

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

function psVersionOf(dims: TelemetryDimensions): string {
  const v = dims.getPsVersion();
  return v && v.length > 0 ? v : PS_VERSION_UNKNOWN;
}

export function buildUsageEvent(
  dims: TelemetryDimensions,
  call: { tool: string; success: boolean; duration_ms: number; error_class: string | null },
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
  };
}

export function buildSessionSummary(
  dims: TelemetryDimensions,
  summary: { tool_call_count: number; distinct_tools: number; any_failures: boolean },
  now: Date
): SessionSummaryEvent {
  return {
    v: TELEMETRY_SCHEMA_VERSION,
    type: 'session_summary',
    install_id: dims.install_id,
    ts_bucket: dayBucket(now),
    editmamei_version: dims.editmamei_version,
    edition: dims.edition,
    platform: dims.platform,
    ps_version: psVersionOf(dims),
    tool_call_count: summary.tool_call_count,
    distinct_tools: summary.distinct_tools,
    any_failures: summary.any_failures,
  };
}

export function buildSessionStart(dims: TelemetryDimensions, now: Date): SessionStartEvent {
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
