/**
 * Durable telemetry outbox — disk-backed reliability for events that an in-process,
 * fire-on-exit network send can't guarantee (see docs/privacy.md, "Where it goes").
 *
 * Why this exists: the MCP server sends telemetry itself, and the host (e.g. Claude Desktop
 * on macOS) tears the process down at session end faster than an async POST can complete —
 * so the final batch + the `session_summary` were being lost (observed live, v0.16.2/.3).
 * The fix is to stop relying on delivery-at-exit:
 *
 *   1. End-of-session events are written to `~/.editmamei/telemetry-outbox.ndjson` with a
 *      SYNCHRONOUS append, which completes even as the process is killed (no event loop
 *      needed, unlike fetch). The NEXT server startup flushes the outbox when the loop is
 *      healthy. Delivery shifts from "end of this session" to "start of the next" — for
 *      solo-maintainer analytics that latency is irrelevant; reliability is the point.
 *   2. The running session accumulators are persisted to `~/.editmamei/telemetry-session.json`
 *      so the `session_summary` can be reconstructed on next startup even if the process is
 *      hard-killed (SIGKILL) before any shutdown handler runs at all. A clean shutdown clears
 *      this file, so a reconstructed summary and a clean one can never both be sent.
 *
 * Everything here is content-free by construction — the persisted events are the same
 * content-free events the client would have sent, and the session state holds only counts +
 * dimensions. All operations swallow their own errors: telemetry must never break a boot or
 * a tool call.
 */

import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  appendFileSync,
  statSync,
  rmSync,
} from 'node:fs';
import { Logger } from '../utils/logger.js';
import type { TelemetryEvent } from './events.js';

const logger = new Logger('TelemetryOutbox');

const DIRNAME = '.editmamei';
const OUTBOX_FILENAME = 'telemetry-outbox.ndjson';
const SESSION_STATE_FILENAME = 'telemetry-session.json';

/**
 * Keep the outbox bounded — drop oldest beyond this on read/compaction.
 *
 * The ceiling has to exceed a whole busy session's events several times over. Overrunning it
 * is not a deferral, it is permanent loss: the drain deletes the file once it has delivered
 * what it read, so anything the bound trimmed is gone with it. A single batch-style session
 * can record several thousand calls, which the previous 1,000 did not come close to covering.
 * At a few hundred bytes per content-free event this is on the order of 1.5 MB of NDJSON,
 * well under MAX_OUTBOX_BYTES, and the file is transient.
 */
export const MAX_OUTBOX_EVENTS = 5_000;
/**
 * Hard byte cap that forces a truncate-to-newest on append (defense vs. runaway growth).
 * Exported so a test can drive the compaction path rather than having to synthesize one.
 */
export const MAX_OUTBOX_BYTES = 2_000_000;

export interface OutboxOptions {
  /** Override the default `~/.editmamei` directory (used in tests). */
  dir?: string;
}

/**
 * Running session accumulators, persisted incrementally so a session killed before a clean
 * shutdown can still have its `session_summary` emitted on next startup. Mirrors what
 * `buildSessionSummary` needs.
 */
export interface PersistedSessionState {
  install_id: string;
  ts_bucket: string;
  editmamei_version: string;
  edition: string;
  platform: string;
  ps_version: string;
  tool_call_count: number;
  distinct_tools: number;
  any_failures: boolean;
  // Added after v1.3.0 — all optional so a state file written by an older version (missing
  // these keys) still parses; readSessionState's shape check only requires the fields above.
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
}

function baseDir(opts: OutboxOptions): string {
  return opts.dir ?? join(homedir(), DIRNAME);
}
export function outboxPath(opts: OutboxOptions = {}): string {
  return join(baseDir(opts), OUTBOX_FILENAME);
}
export function sessionStatePath(opts: OutboxOptions = {}): string {
  return join(baseDir(opts), SESSION_STATE_FILENAME);
}

function ensureDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
}

/**
 * Append events to the outbox with a SYNCHRONOUS write. Safe to call from a shutdown /
 * exit handler — it does not depend on the event loop surviving. Best-effort: any error is
 * logged and swallowed. Forces a compaction if the file has grown past the byte cap.
 */
export function appendOutboxSync(events: TelemetryEvent[], opts: OutboxOptions = {}): number {
  if (events.length === 0) return 0;
  const path = outboxPath(opts);
  let discarded = 0;
  try {
    ensureDir(path);
    if (existsSync(path) && statSync(path).size > MAX_OUTBOX_BYTES) {
      discarded += compactOutbox(opts);
    }
    const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    appendFileSync(path, lines, { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    logger.debug(`outbox append dropped ${events.length} event(s): ${errMsg(err)}`);
    // The append is the last line of defence — if it throws, these events are simply gone.
    discarded += events.length;
  }
  return discarded;
}

/** What a read of the outbox produced, and what it threw away getting there. */
export interface OutboxRead {
  events: TelemetryEvent[];
  /**
   * Events this read discarded and did NOT return: the MAX_OUTBOX_EVENTS bound dropping
   * oldest, plus corrupt lines that failed to parse. The caller deletes the file once the
   * returned events are delivered, so anything counted here is gone for good — which is
   * exactly why it has to be reported rather than silently swallowed.
   */
  discarded: number;
}

/**
 * Read + parse every queued event, reporting what the bound discarded. Malformed lines are
 * skipped (and counted). Returns no events on any error.
 */
export function readOutboxWithDiscards(opts: OutboxOptions = {}): OutboxRead {
  const path = outboxPath(opts);
  if (!existsSync(path)) return { events: [], discarded: 0 };
  try {
    const raw = readFileSync(path, 'utf8');
    const events: TelemetryEvent[] = [];
    let discarded = 0;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        events.push(JSON.parse(trimmed) as TelemetryEvent);
      } catch {
        /* skip a corrupt line rather than discard the whole outbox */
        discarded += 1;
      }
    }
    // Bound: keep only the most recent MAX_OUTBOX_EVENTS.
    if (events.length > MAX_OUTBOX_EVENTS) {
      const over = events.length - MAX_OUTBOX_EVENTS;
      return { events: events.slice(over), discarded: discarded + over };
    }
    return { events, discarded };
  } catch (err) {
    logger.debug(`outbox read failed: ${errMsg(err)}`);
    return { events: [], discarded: 0 };
  }
}

/**
 * The events only.
 *
 * **Tests and assertions only — production code must call `readOutboxWithDiscards`.** This
 * wrapper throws the discard count away, and since the caller typically deletes the file
 * straight afterwards, that count is the only record the discarded events ever existed.
 * Losing it silently is the bug this module was changed to stop having; the shorter name is
 * kept purely so the existing test call sites did not all have to churn.
 */
export function readOutbox(opts: OutboxOptions = {}): TelemetryEvent[] {
  return readOutboxWithDiscards(opts).events;
}

/** Delete the outbox file. Best-effort. */
export function clearOutbox(opts: OutboxOptions = {}): void {
  try {
    rmSync(outboxPath(opts), { force: true });
  } catch (err) {
    logger.debug(`outbox clear failed: ${errMsg(err)}`);
  }
}

/**
 * Replace the outbox with exactly these events (atomic tmp+rename). Best-effort.
 *
 * This is what lets a PARTIAL drain keep only what it hasn't delivered. The startup drain
 * used to clear the file only when every batch succeeded, which meant a failure midway left
 * the already-delivered batches on disk for the next startup to send a second time — double
 * counting, the mirror image of the loss this accounting exists to find.
 */
export function rewriteOutbox(events: TelemetryEvent[], opts: OutboxOptions = {}): void {
  if (events.length === 0) {
    clearOutbox(opts);
    return;
  }
  const path = outboxPath(opts);
  try {
    ensureDir(path);
    const tmp = join(dirname(path), `.outbox.${process.pid}.tmp`);
    writeFileSync(tmp, events.map((e) => JSON.stringify(e)).join('\n') + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(tmp, path);
  } catch (err) {
    logger.debug(`outbox rewrite failed: ${errMsg(err)}`);
  }
}

/**
 * Rewrite the outbox keeping only the most recent events that fit BOTH bounds.
 * Returns how many events that threw away, for the caller's discard accounting.
 *
 * The byte bound has to be enforced here, not just by the event bound: `readOutboxWithDiscards`
 * trims by COUNT, so for any event fatter than MAX_OUTBOX_BYTES/MAX_OUTBOX_EVENTS the file can
 * sit over the byte cap while under the event cap — and a compaction that discards nothing
 * rewrites the identical bytes back, leaving the caller to pay a full read+write on every
 * subsequent append while the file keeps growing. Diagnostic events are exactly that shape
 * (a sanitized message plus a stderr tail is ~6 KB, twenty times a usage event), so this is
 * the opt-in-diagnostics-plus-broken-network path, not a hypothetical.
 */
function compactOutbox(opts: OutboxOptions = {}): number {
  const { events, discarded } = readOutboxWithDiscards(opts);
  // Target half the cap so compaction is amortized — trimming to exactly the cap would
  // re-compact on the very next append.
  const target = MAX_OUTBOX_BYTES / 2;
  let bytes = 0;
  // Walk newest-first, keeping what fits; newer signal is more useful than older. Start at
  // the last index rather than events.length so a single event fatter than the whole target
  // still keeps ONE — otherwise the slice comes back empty and compaction deletes the entire
  // backlog to make room for nothing.
  let firstKept = Math.max(events.length - 1, 0);
  for (let i = events.length - 1; i >= 0; i--) {
    // Byte length, not string length: a non-ASCII payload is more bytes than UTF-16 units,
    // and undercounting here is what lets the file stay over the cap it just compacted for.
    bytes += Buffer.byteLength(JSON.stringify(events[i]), 'utf8') + 1;
    if (bytes > target) break;
    firstKept = i;
  }
  const kept = events.slice(firstKept);
  rewriteOutbox(kept, opts);
  return discarded + (events.length - kept.length);
}

/**
 * Persist the running session accumulators (atomic tmp+rename). Called throttled during the
 * session so a hard-killed process leaves a near-current snapshot behind. Best-effort.
 */
export function writeSessionStateSync(
  state: PersistedSessionState,
  opts: OutboxOptions = {}
): void {
  const path = sessionStatePath(opts);
  try {
    ensureDir(path);
    const tmp = join(dirname(path), `.session.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    logger.debug(`session-state write failed: ${errMsg(err)}`);
  }
}

/** Read the persisted session state, or null if absent/corrupt. */
export function readSessionState(opts: OutboxOptions = {}): PersistedSessionState | null {
  const path = sessionStatePath(opts);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<PersistedSessionState>;
    if (
      typeof parsed.install_id === 'string' &&
      typeof parsed.ts_bucket === 'string' &&
      typeof parsed.tool_call_count === 'number'
    ) {
      return parsed as PersistedSessionState;
    }
    return null;
  } catch (err) {
    logger.debug(`session-state read failed: ${errMsg(err)}`);
    return null;
  }
}

/** Delete the persisted session state (called on clean shutdown). Best-effort. */
export function clearSessionState(opts: OutboxOptions = {}): void {
  try {
    rmSync(sessionStatePath(opts), { force: true });
  } catch (err) {
    logger.debug(`session-state clear failed: ${errMsg(err)}`);
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
