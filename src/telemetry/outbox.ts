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
 *   2. The running session accumulators are persisted to
 *      `~/.editmamei/telemetry-session.<pid>.json` so the `session_summary` can be
 *      reconstructed on next startup even if the process is hard-killed (SIGKILL) before any
 *      shutdown handler runs at all. A clean shutdown clears this file, so a reconstructed
 *      summary and a clean one can never both be sent.
 *
 * Several server processes can share one home directory (multiple MCP clients, or several
 * windows of one client). Every file here is therefore either owned by one pid or claimed by
 * an atomic rename before it is read: a starting process recovers only the session files of
 * processes that are no longer running, and drains only an outbox it has renamed out of the
 * way first, so it can neither re-report a live sibling's session nor erase a batch a sibling
 * appended while the drain was in flight. Compaction claims the outbox the same way and appends
 * what it keeps back onto the live file, so it never overwrites events a drain has taken.
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
  readdirSync,
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
/**
 * Session file written by versions that kept one file for all processes. Recovered at startup
 * so an upgrade keeps the summary of a session such a version left behind.
 */
const LEGACY_SESSION_STATE_FILENAME = 'telemetry-session.json';
const SESSION_STATE_RE = /^telemetry-session\.(\d+)\.json$/;
/** A session file a startup recovery has claimed: `.session-recover.<pid>.<original name>`. */
const RECOVER_RE = /^\.session-recover\.(\d+)\.(telemetry-session(?:\.\d+)?\.json)$/;
/**
 * An outbox a drain or a compaction has claimed:
 * `telemetry-outbox.<draining|compacting>.<pid>.<seq>.ndjson`. Either kind left behind by a
 * process that died mid-way is picked up by the next startup drain.
 */
const CLAIM_RE = /^telemetry-outbox\.(?:draining|compacting)\.(\d+)\.(\d+)\.ndjson$/;

/**
 * Keep the outbox bounded — drop oldest beyond this on read/compaction.
 *
 * The ceiling has to exceed a whole busy session's events several times over. Overrunning it
 * is not a deferral, it is permanent loss: the drain deletes the file once it has delivered
 * what it read, so anything the bound trimmed is gone with it. A single batch-style session
 * can record several thousand calls.
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
  /** The pid that owns this writer's session file and drain claims. Defaults to `process.pid`. */
  pid?: number;
  /** Liveness check for another process's files. Defaults to `isPidAlive`. */
  isPidAlive?: (pid: number) => boolean;
}

/**
 * Whether a process with this pid is running. Signal 0 checks existence without delivering
 * anything (supported on Windows too); EPERM means it exists but belongs to another user.
 *
 * A recycled pid reads as alive, which only defers recovery of that file until the unrelated
 * process exits — the safe direction, since the alternative is reporting a session twice.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code === 'EPERM';
  }
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
function ownPid(opts: OutboxOptions): number {
  return opts.pid ?? process.pid;
}
/** This process's own session-state file. */
export function sessionStatePath(opts: OutboxOptions = {}): string {
  return join(baseDir(opts), `telemetry-session.${ownPid(opts)}.json`);
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Atomically take a file out of everyone else's reach by renaming it to a name only this
 * process uses. Returns the new path, or null if the file is gone or another process won.
 */
function claim(from: string, to: string): string | null {
  try {
    renameSync(from, to);
    return to;
  } catch {
    return null;
  }
}

/**
 * The first unused claim name of this kind for this pid. A rename replaces an existing target
 * on every platform, and a predecessor sharing this pid may have left claims under it, so a
 * name is only handed out once it is unused.
 */
function freeClaimName(dir: string, kind: 'draining' | 'compacting', pid: number): string {
  for (let seq = 0; ; seq++) {
    const path = join(dir, `telemetry-outbox.${kind}.${pid}.${seq}.ndjson`);
    if (!existsSync(path)) return path;
  }
}

/** A claimed file's complete lines, and the byte offset just past the last of them. */
interface ClaimRead extends OutboxRead {
  bytes: number;
}

/**
 * Read a claimed file up to its last newline. A sibling that opened the file before it was
 * claimed can still be part-way through an append, so a trailing line without its newline is
 * left for `readClaimTail`, which reads it once the write has finished.
 */
function readClaim(path: string): ClaimRead {
  const buf = readFileSync(path);
  const bytes = buf.lastIndexOf(0x0a) + 1;
  return { ...parseOutbox(buf.subarray(0, bytes).toString('utf8')), bytes };
}

/**
 * Everything written to a claimed file past `bytes`. A trailing line that is still incomplete
 * here fails to parse and is counted as a discard.
 */
function readClaimTail(path: string, bytes: number): OutboxRead {
  const buf = readFileSync(path);
  if (buf.length <= bytes) return { events: [], discarded: 0 };
  return parseOutbox(buf.subarray(bytes).toString('utf8'));
}

/**
 * Delete a claimed file whose contents have been handed on. If the delete fails (Windows
 * reports EBUSY or EPERM while another process holds the file open), empty it instead, so a
 * later recovery reads nothing rather than sending the same events again.
 */
function removeClaim(path: string, what: string): void {
  try {
    rmSync(path, { force: true });
    return;
  } catch (err) {
    logger.debug(`${what} delete failed: ${errMsg(err)}`);
  }
  try {
    writeFileSync(path, '');
  } catch (err) {
    logger.debug(`${what} truncate failed: ${errMsg(err)}`);
  }
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
    return boundOutbox(parseOutbox(readFileSync(path, 'utf8')));
  } catch (err) {
    logger.debug(`outbox read failed: ${errMsg(err)}`);
    return { events: [], discarded: 0 };
  }
}

/** Parse NDJSON, skipping (and counting) corrupt lines rather than discarding the whole file. */
function parseOutbox(raw: string): OutboxRead {
  const events: TelemetryEvent[] = [];
  let discarded = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      events.push(JSON.parse(trimmed) as TelemetryEvent);
    } catch {
      discarded += 1;
    }
  }
  return { events, discarded };
}

/** Keep only the most recent MAX_OUTBOX_EVENTS, counting what the bound dropped. */
function boundOutbox({ events, discarded }: OutboxRead): OutboxRead {
  if (events.length <= MAX_OUTBOX_EVENTS) return { events, discarded };
  const over = events.length - MAX_OUTBOX_EVENTS;
  return { events: events.slice(over), discarded: discarded + over };
}

/** A backlog a startup drain has claimed, and the way to hand back what it could not send. */
export interface ClaimedOutbox extends OutboxRead {
  /**
   * Finish the drain: append `undelivered` back onto the live outbox, where the next startup
   * will find it, then delete the claimed files. Appending (rather than rewriting the outbox)
   * keeps any batch a sibling wrote during the drain. Returns the events this step discarded.
   * Only the first call has any effect.
   */
  release(undelivered: TelemetryEvent[]): number;
}

/**
 * Claim the outbox for a startup drain. The live file is renamed to a name only this process
 * uses before it is read, so appends that arrive while the drain is on the network land in a
 * fresh outbox instead of being overwritten, and a sibling starting at the same moment cannot
 * read (and send) the same events. Claims left behind by a drain whose process died mid-way are
 * picked up too, once their pid is no longer running.
 *
 * Call once per process, at startup. A claim carrying this process's own pid is then either a
 * predecessor's that happened to share it, or a compaction this process already finished
 * (compaction is synchronous), so taking it in place is safe either way.
 */
export function claimOutboxForDrain(opts: OutboxOptions = {}): ClaimedOutbox {
  const dir = baseDir(opts);
  const me = ownPid(opts);
  const alive = opts.isPidAlive ?? isPidAlive;
  const claimed: string[] = [];
  const nextName = (): string => freeClaimName(dir, 'draining', me);

  // Abandoned claims first, ahead of the live outbox, whose events are newer. A live sibling's
  // compaction claim is skipped like its drain claim: that sibling appends what it keeps back.
  const abandoned = listDir(dir)
    .flatMap((name) => {
      const m = CLAIM_RE.exec(name);
      return m ? [{ name, pid: Number(m[1]), seq: Number(m[2]) }] : [];
    })
    .filter((c) => c.pid === me || !alive(c.pid))
    .sort((a, b) => a.pid - b.pid || a.seq - b.seq || a.name.localeCompare(b.name));
  for (const c of abandoned) {
    const from = join(dir, c.name);
    // Already under this pid's name: nobody else can take it, so use it where it is.
    const got = c.pid === me ? from : claim(from, nextName());
    if (got) claimed.push(got);
  }
  const live = claim(outboxPath(opts), nextName());
  if (live) claimed.push(live);

  // Only files that were actually read are deleted on release. One that failed to read keeps
  // this pid's claim name, so a later startup picks it up once this process has exited.
  const consumed: Array<{ path: string; bytes: number }> = [];
  let read: OutboxRead = { events: [], discarded: 0 };
  for (const path of claimed) {
    try {
      const part = readClaim(path);
      read = {
        events: read.events.concat(part.events),
        discarded: read.discarded + part.discarded,
      };
      consumed.push({ path, bytes: part.bytes });
    } catch (err) {
      logger.debug(`claimed outbox read failed: ${errMsg(err)}`);
    }
  }
  const { events, discarded } = boundOutbox(read);

  let released = false;
  return {
    events,
    discarded,
    release(undelivered) {
      if (released) return 0;
      released = true;
      // A sibling that opened the outbox just before the rename writes into the claimed file,
      // possibly after it was read. Whatever lies past the complete lines that were read is
      // carried over instead of being deleted with the claim.
      const late: TelemetryEvent[] = [];
      let lost = 0;
      for (const { path, bytes } of consumed) {
        try {
          const tail = readClaimTail(path, bytes);
          late.push(...tail.events);
          lost += tail.discarded;
        } catch (err) {
          logger.debug(`claimed outbox re-read failed: ${errMsg(err)}`);
        }
      }
      // Append before deleting: if this process dies between the two, the claim is
      // re-drained (a duplicate) rather than the remainder being lost.
      lost += appendOutboxSync(undelivered.concat(late), opts);
      for (const { path } of consumed) removeClaim(path, 'claimed outbox');
      return lost;
    },
  };
}

/**
 * The events only.
 *
 * **Tests and assertions only.** This wrapper throws the discard count away, and a caller
 * that deletes the file afterwards loses the only record that the discarded events existed.
 * Production reads go through `claimOutboxForDrain` or `readOutboxWithDiscards`.
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
 * Not for use while other processes share the outbox: the rename replaces whatever is there,
 * including a sibling's append or a file a drain has claimed and re-created in the meantime.
 * Compaction does not go through here; see `compactOutbox`.
 */
export function rewriteOutbox(events: TelemetryEvent[], opts: OutboxOptions = {}): void {
  if (events.length === 0) {
    clearOutbox(opts);
    return;
  }
  const path = outboxPath(opts);
  try {
    ensureDir(path);
    const tmp = join(dirname(path), `.outbox.${ownPid(opts)}.tmp`);
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
 * Trim the outbox to the most recent events that fit BOTH bounds.
 * Returns how many events that threw away, for the caller's discard accounting.
 *
 * Concurrency: the outbox is claimed by a rename to a compaction claim, the same way a drain
 * claims it, and the kept events are APPENDED back onto the live outbox, never written over
 * it. A drain that claims the outbox first leaves nothing here to compact; a drain that comes
 * second finds no live outbox (or only appends made since) and skips the claim while this
 * process is running. Either way each event sits in one file, except between the append-back
 * and the claim's removal: a crash there re-sends the kept events, which favors a duplicate over
 * a loss in the same way the drain does. A sibling append that
 * lands in the claim after it was read is carried over with the kept events. If this process
 * dies part-way, or the append-back fails, the claim stays under this pid's name and a later
 * startup drain recovers it once the pid is gone.
 *
 * The byte bound has to be enforced here, not just by the event bound: the count bound alone
 * lets any event fatter than MAX_OUTBOX_BYTES/MAX_OUTBOX_EVENTS keep the file over the byte cap
 * while under the event cap, and a compaction that discards nothing would put the identical
 * bytes back, leaving the caller to pay a full read+write on every subsequent append while the
 * file keeps growing. Diagnostic events are exactly that shape (a sanitized message plus a
 * stderr tail is ~6 KB, twenty times a usage event), so this is the
 * opt-in-diagnostics-plus-broken-network path, not a hypothetical.
 */
function compactOutbox(opts: OutboxOptions = {}): number {
  const path = claim(outboxPath(opts), freeClaimName(baseDir(opts), 'compacting', ownPid(opts)));
  // Gone, or a sibling claimed it first: what was over the cap is no longer in the outbox.
  if (!path) return 0;
  let read: ClaimRead;
  try {
    read = readClaim(path);
  } catch (err) {
    logger.debug(`compaction read failed, leaving the claim for recovery: ${errMsg(err)}`);
    return 0;
  }
  const { events, discarded } = boundOutbox(read);
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
  let late: OutboxRead = { events: [], discarded: 0 };
  try {
    late = readClaimTail(path, read.bytes);
  } catch (err) {
    logger.debug(`compaction re-read failed: ${errMsg(err)}`);
  }
  const back = kept.concat(late.events);
  if (back.length > 0) {
    try {
      appendFileSync(outboxPath(opts), back.map((e) => JSON.stringify(e)).join('\n') + '\n', {
        encoding: 'utf8',
        mode: 0o600,
      });
    } catch (err) {
      logger.debug(`compaction write-back failed, leaving the claim for recovery: ${errMsg(err)}`);
      return 0;
    }
  }
  removeClaim(path, 'compaction claim');
  return discarded + (events.length - kept.length) + late.discarded;
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
    const tmp = join(dirname(path), `.session.${ownPid(opts)}.tmp`);
    writeFileSync(tmp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    logger.debug(`session-state write failed: ${errMsg(err)}`);
  }
}

/** Read this process's persisted session state, or null if absent/corrupt. */
export function readSessionState(opts: OutboxOptions = {}): PersistedSessionState | null {
  return readSessionStateAt(sessionStatePath(opts));
}

/** Session states a startup recovery has claimed, and the way to dispose of their files. */
export interface ClaimedSessionStates {
  states: PersistedSessionState[];
  /**
   * Delete the claimed files. Call once the reconstructed summaries are in the outbox, so a
   * process killed in between leaves the claim for a later startup instead of losing it.
   */
  release(): void;
}

/**
 * Claim the session-state files of sessions that ended without a clean shutdown, so each is
 * reconstructed exactly once. A file whose pid is still running belongs to a live sibling and
 * is left alone: reporting it here would count that session's running totals again on top of
 * its own shutdown summary. Each file is renamed before it is read, so two siblings booting
 * together cannot both reconstruct it, and a recovery interrupted before it finished is
 * resumed once its process has exited.
 *
 * `includeOwn` covers a file carrying this process's own pid. At startup, before this process
 * has written its state, such a file can only be a dead predecessor's (pids are recycled); once
 * this process has persisted, it is live state and must not be taken.
 *
 * The legacy single file has no pid, so it is always taken. An older version still running
 * alongside therefore has its live session reported early, and once more at its own shutdown.
 */
export function claimOrphanedSessionStates(
  opts: OutboxOptions = {},
  { includeOwn }: { includeOwn: boolean }
): ClaimedSessionStates {
  const dir = baseDir(opts);
  const me = ownPid(opts);
  const alive = opts.isPidAlive ?? isPidAlive;
  const takeable = (pid: number): boolean => (pid === me ? includeOwn : !alive(pid));
  const claimed: string[] = [];
  for (const name of listDir(dir)) {
    let original: string;
    const r = RECOVER_RE.exec(name);
    if (r) {
      const pid = Number(r[1]);
      if (!takeable(pid)) continue;
      if (pid === me) {
        claimed.push(join(dir, name));
        continue;
      }
      original = r[2]!;
    } else if (name === LEGACY_SESSION_STATE_FILENAME) {
      original = name;
    } else {
      const m = SESSION_STATE_RE.exec(name);
      if (!m || !takeable(Number(m[1]))) continue;
      original = name;
    }
    // A rename replaces an existing target; leave a name clash for a later startup.
    const target = join(dir, `.session-recover.${me}.${original}`);
    if (existsSync(target)) continue;
    const got = claim(join(dir, name), target);
    if (got) claimed.push(got);
  }

  const states: PersistedSessionState[] = [];
  for (const path of claimed) {
    const state = readSessionStateAt(path);
    if (state) states.push(state);
  }
  let released = false;
  return {
    states,
    release() {
      if (released) return;
      released = true;
      // An emptied file reads as no state, so the truncate fallback is never reported again.
      for (const path of claimed) removeClaim(path, 'session-state recover');
    },
  };
}

function readSessionStateAt(path: string): PersistedSessionState | null {
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
