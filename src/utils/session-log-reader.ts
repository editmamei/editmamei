import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Logger } from './logger.js';
import type { SessionLogEntry } from './session-log.js';

const SESSION_FILE_SUFFIX = '.ndjson';

/**
 * Reader for the NDJSON tool-call log written by `SessionLog` (the Phase 2
 * telemetry layer). Templates (Phase 3) read this to learn what the LLM
 * actually did during a session — that "intent log" is one of the three
 * evidence layers a template synthesizes from.
 *
 * Missing-file is NOT an error: if the server booted but no tool calls have
 * happened yet, the file doesn't exist and we return [] cleanly. A partially
 * written last line (in flight during a race with appendFile) is skipped
 * with a warning rather than crashing the read.
 */

export interface ReadSessionLogOptions {
  /** Override the default `~/.editmamei/sessions/` directory (used in tests). */
  dir?: string;
}

const logger = new Logger('SessionLogReader');

export async function readSessionLog(
  sessionId: string,
  opts: ReadSessionLogOptions = {}
): Promise<SessionLogEntry[]> {
  const dir = opts.dir ?? join(homedir(), '.editmamei', 'sessions');
  const path = join(dir, `${sessionId}.ndjson`);

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOENT') return [];
    logger.warn(`session-log read failed for ${path}: ${(err as Error).message}`);
    return [];
  }

  if (raw.length === 0) return [];

  const out: SessionLogEntry[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) continue; // trailing newline / empty interior line
    try {
      out.push(JSON.parse(line) as SessionLogEntry);
    } catch {
      // A partially-written line is most likely the last one (writer was
      // mid-append when we read). Skip silently if it's the trailing entry,
      // warn for any interior corruption.
      if (i !== lines.length - 1 && i !== lines.length - 2) {
        logger.warn(`session-log line ${i + 1} unparseable; skipping`);
      }
    }
  }
  return out;
}

/**
 * List the most-recently-modified session ids (newest first), up to `limit`.
 * Used by the diagnostic-bundle collector to attach a content-free summary of
 * recent activity. Missing/unreadable directory → [] (never throws).
 */
export async function listRecentSessionIds(
  limit: number,
  opts: ReadSessionLogOptions = {}
): Promise<string[]> {
  const dir = opts.dir ?? join(homedir(), '.editmamei', 'sessions');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files = names.filter((f) => f.endsWith(SESSION_FILE_SUFFIX));
  const withMtime = await Promise.all(
    files.map(async (f) => {
      try {
        const s = await stat(join(dir, f));
        return { id: f.slice(0, -SESSION_FILE_SUFFIX.length), mtime: s.mtimeMs };
      } catch {
        return null;
      }
    })
  );
  return withMtime
    .filter((x): x is { id: string; mtime: number } => x !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, Math.max(0, limit))
    .map((x) => x.id);
}
