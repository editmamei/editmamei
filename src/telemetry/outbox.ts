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

/** Keep the outbox bounded — drop oldest beyond this on read/compaction. */
export const MAX_OUTBOX_EVENTS = 1000;
/** Hard byte cap that forces a truncate-to-last-N on append (defense vs. runaway growth). */
const MAX_OUTBOX_BYTES = 2_000_000;

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
export function appendOutboxSync(events: TelemetryEvent[], opts: OutboxOptions = {}): void {
  if (events.length === 0) return;
  const path = outboxPath(opts);
  try {
    ensureDir(path);
    if (existsSync(path) && statSync(path).size > MAX_OUTBOX_BYTES) {
      compactOutbox(opts);
    }
    const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    appendFileSync(path, lines, { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    logger.debug(`outbox append dropped ${events.length} event(s): ${errMsg(err)}`);
  }
}

/** Read + parse every queued event. Malformed lines are skipped. Returns [] on any error. */
export function readOutbox(opts: OutboxOptions = {}): TelemetryEvent[] {
  const path = outboxPath(opts);
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, 'utf8');
    const events: TelemetryEvent[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        events.push(JSON.parse(trimmed) as TelemetryEvent);
      } catch {
        /* skip a corrupt line rather than discard the whole outbox */
      }
    }
    // Bound: keep only the most recent MAX_OUTBOX_EVENTS.
    return events.length > MAX_OUTBOX_EVENTS
      ? events.slice(events.length - MAX_OUTBOX_EVENTS)
      : events;
  } catch (err) {
    logger.debug(`outbox read failed: ${errMsg(err)}`);
    return [];
  }
}

/** Delete the outbox file. Best-effort. */
export function clearOutbox(opts: OutboxOptions = {}): void {
  try {
    rmSync(outboxPath(opts), { force: true });
  } catch (err) {
    logger.debug(`outbox clear failed: ${errMsg(err)}`);
  }
}

/** Rewrite the outbox keeping only the most recent MAX_OUTBOX_EVENTS lines. */
function compactOutbox(opts: OutboxOptions = {}): void {
  const kept = readOutbox(opts);
  const path = outboxPath(opts);
  try {
    if (kept.length === 0) {
      clearOutbox(opts);
      return;
    }
    const tmp = join(dirname(path), `.outbox.${process.pid}.tmp`);
    writeFileSync(tmp, kept.map((e) => JSON.stringify(e)).join('\n') + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(tmp, path);
  } catch (err) {
    logger.debug(`outbox compaction failed: ${errMsg(err)}`);
  }
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
