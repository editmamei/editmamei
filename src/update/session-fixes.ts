/**
 * The previous session's failed tools, for the fix-aware half of the update notice.
 *
 * The notice rides `ps_ping`, which the skill mandates as the FIRST call of a
 * session — at that moment the current session has zero failures by construction,
 * so the only failures worth intersecting against the manifest's fixes map are the
 * PREVIOUS session's: pain the user has already felt. "Last session, ps_delete_layer
 * failed 10 times — that's fixed in the new version" is a reason to update; a bare
 * version delta is a nag.
 *
 * Local NDJSON read only (the `~/.editmamei/sessions/` tree the SessionLog writer
 * owns); nothing leaves the machine. Every path degrades to "no intersect" — a
 * missing directory, an unreadable file, or no prior session must never cost the
 * plain notice, let alone the ping.
 */

import {
  listRecentSessionIds,
  readSessionLog,
  type ReadSessionLogOptions,
} from '../utils/session-log-reader.js';

export interface FixedFailure {
  /** Tool name exactly as the previous session's log recorded it. */
  tool: string;
  /** How many times it failed in that session. */
  failures: number;
}

/**
 * How many recent session ids to scan when looking for "the previous session".
 * The current session's file always exists (the meta line lands at boot), so the
 * previous one is normally index 0 or 1; the margin covers mtime races with other
 * concurrently-running server processes.
 */
const RECENT_SESSION_SCAN_LIMIT = 5;

/**
 * Failure counts per tool from the most recent session that is not the current
 * one AND actually recorded tool calls. A session file with a meta line but no
 * calls is a client start where no work happened (open-and-close, a crashed
 * boot) — treating one as "the previous session" would silently hide the real
 * previous session behind it, so call-less files are skipped, up to the scan
 * limit. Empty map when no qualifying session exists or the log can't be read.
 */
export async function previousSessionFailureCounts(
  currentSessionId: string,
  opts: ReadSessionLogOptions = {}
): Promise<Map<string, number>> {
  const ids = await listRecentSessionIds(RECENT_SESSION_SCAN_LIMIT, opts);
  for (const id of ids) {
    if (id === currentSessionId) continue;
    const entries = await readSessionLog(id, opts);
    const counts = new Map<string, number>();
    let sawCall = false;
    for (const entry of entries) {
      // v2 meta lines carry no tool; v1 lines carry no `type` and are calls
      // (the reader's documented back-compat rule), so gate on the fields.
      if ('type' in entry && entry.type === 'meta') continue;
      const call = entry as { tool?: unknown; success?: unknown };
      if (typeof call.tool !== 'string') continue;
      sawCall = true;
      if (call.success === false) {
        counts.set(call.tool, (counts.get(call.tool) ?? 0) + 1);
      }
    }
    // The first session with any calls IS the previous session — a clean one
    // legitimately answers "no relevant failures"; keep scanning only past
    // files that recorded no work at all.
    if (sawCall) return counts;
  }
  return new Map();
}

/**
 * Intersect the previous session's failures with the tools the pending update
 * fixes — most-failed first, capped so the ping text stays a single sentence.
 */
export function relevantFixes(
  failureCounts: Map<string, number>,
  fixedTools: string[],
  cap = 3
): FixedFailure[] {
  return fixedTools
    .filter((tool) => (failureCounts.get(tool) ?? 0) > 0)
    .map((tool) => ({ tool, failures: failureCounts.get(tool)! }))
    .sort((a, b) => b.failures - a.failures)
    .slice(0, cap);
}
