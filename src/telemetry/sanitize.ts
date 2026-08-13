/**
 * Category-B diagnostic message sanitizer.
 *
 * The privacy hard line (see docs/privacy.md, "Sanitization"): no full filesystem paths, no
 * PII, ever — basenames only. Category A carries no free text so it needs nothing here;
 * Category B carries a sanitized error message, failing-snippet name, and stderr tail.
 * This collapses any path to its basename, redacts the running user's home directory, and
 * neutralizes Windows separators so the result passes the server's path guard (a message
 * that still looked path-shaped would get the whole batch rejected).
 *
 * Reuses `redactHomedirIn` from the session-log sanitizer so the two stay consistent.
 */

import { homedir } from 'node:os';
import { realpathSync } from 'node:fs';
import { redactHomedirIn } from '../utils/session-log.js';

/** Cap a sanitized message below the server's 2048-char limit with headroom. */
export const MAX_MESSAGE_LEN = 2000;
/** Cap for the optional stderr tail (server limit 4096). */
export const MAX_STDERR_TAIL_LEN = 4000;
/** Cap for the optional snippet/descriptor name (server limit 128). */
export const MAX_SNIPPET_LEN = 128;

function homedirPrefixes(): string[] {
  const home = homedir();
  if (!home) return [];
  const set = new Set<string>([home]);
  try {
    const real = realpathSync(home);
    if (real && real !== home) set.add(real);
  } catch {
    /* defensive */
  }
  if (process.platform === 'win32') {
    for (const v of [...set]) set.add(v.replace(/\\/g, '/'));
  }
  return [...set];
}

/**
 * Collapse absolute path tokens to their basename so intermediate directory names (which
 * can carry PII — client names, project codenames) never ship. Matches, in order:
 *   - Windows drive paths: `C:\a\b`, `C:/a/b`
 *   - UNC paths: `\\server\share\a\b` (no drive letter — these would otherwise survive the
 *     later backslash→slash pass with their directory names intact)
 *   - `file://` URLs: `file:///Users/me/a.psd`
 *   - multi-segment POSIX paths: `/a/b/c`
 *   - single-segment POSIX paths anchored to start-of-string or whitespace: `/ClientCodename`.
 *     These would otherwise survive (the later leading-`/` strip exposes the bare name, which
 *     can itself be PII — a client/project codename). A NON-anchored `/word` (the `/O` in
 *     "I/O", the `/write` in "read/write") is deliberately untouched: it is not a path token,
 *     just punctuation between words. Anchoring on `(?:^|\s)` is what preserves "I/O".
 * Multi-segment / drive / UNC / file matches reduce to their final segment; an anchored
 * single-segment POSIX token reduces to a `/…` redaction marker (no real basename to keep —
 * the lone segment IS the name we must drop).
 */
const SINGLE_SEG_POSIX = /(^|\s)\/[^\s"'/]+(?=$|\s)/;
function basenamePaths(s: string): string {
  return s.replace(
    /[A-Za-z]:[\\/][^\s"']*|\\\\[^\s"']+|file:\/\/[^\s"']*|(?:\/[^\s"'/]+){2,}\/?|(?:^|\s)\/[^\s"'/]+(?=$|\s)/gi,
    (m) => {
      // Anchored single-segment POSIX token (`/ClientCodename`) → drop the name entirely;
      // basenaming it would just re-expose the codename. Preserve the leading space the
      // anchor consumed so surrounding text stays intact.
      const single = SINGLE_SEG_POSIX.exec(m);
      if (single) return `${single[1]}/…`;
      return m.split(/[\\/]/).filter(Boolean).pop() ?? '';
    }
  );
}

/**
 * Generic username fallback for home-dir representations `homedir()` doesn't return verbatim.
 * `homedirPrefixes()` covers the literal `os.homedir()` + its realpath (+ win slash-flip), but
 * a DOS 8.3 short name (`C:\Users\ALICE~1\...`), a junction, or a path resolved through a
 * different mount can carry the username under a `Users/<name>` (Windows) or `home/<name>`
 * (POSIX) parent that the literal-prefix scan never sees. Collapse the segment right after a
 * `Users`/`home` separator to `~`, so the username is scrubbed before `basenamePaths` reduces
 * the token (a bare directory path like `C:\Users\ALICE~1` would otherwise basename to the
 * username itself). Conservative: only fires inside a recognized `Users`/`home` parent, leaving
 * unrelated text untouched.
 */
function redactGenericUserDirs(s: string): string {
  let out = s.replace(/\bUsers([\\/])[^\\/\s"']+/g, 'Users$1~');
  if (process.platform !== 'win32') {
    out = out.replace(/\bhome([\\/])[^\\/\s"']+/g, 'home$1~');
  }
  return out;
}

/**
 * Full sanitization pass for a free-text diagnostic value: home redaction → generic
 * user-dir redaction → path basenaming → backslash neutralization → strip leading
 * separators → length cap. The order matters: home redaction first (so `C:\Users\me\...`
 * becomes `~\...` before basenaming), the generic `Users/<name>` fallback next (catches
 * non-`homedir()` representations before basenaming would expose a bare username), backslash
 * cleanup last so nothing path-shaped survives for the server.
 */
export function sanitizeMessage(input: string, maxLen: number = MAX_MESSAGE_LEN): string {
  let out = input;
  for (const prefix of homedirPrefixes()) {
    out = redactHomedirIn(out, prefix);
  }
  out = redactGenericUserDirs(out);
  out = basenamePaths(out);
  // Everything after a "not found:" marker is user content: the requested
  // name (a tool argument — the privacy doc promises arguments never ship)
  // and the "Have:" / "(have: …)" inventories of OTHER layer/group/channel
  // names off the user's canvas. One rule drops all of it to end-of-line.
  // Per-line on purpose: a multi-line stderr tail keeps its later lines
  // (the error number and stack are why the tail exists), and a name cannot
  // smuggle a newline past the redaction — the enriched messages
  // \uXXXX-escape control characters before they ever reach this function.
  // An earlier two-rule version scoped to the inventories alone
  // under-redacted: its channel rule stopped at the first ')' inside a
  // name. The local session NDJSON keeps the full text.
  out = out.replace(/\bnot found: [^\n]*/gi, 'not found: [redacted]');
  // Any backslash left (the server rejects them) → forward slash.
  out = out.replace(/\\/g, '/');
  // The server rejects a value that starts with a separator.
  out = out.replace(/^[/]+/, '');
  if (out.length > maxLen) out = out.slice(0, maxLen);
  return out;
}

/** Snippet/descriptor names should already be bare identifiers; clamp length defensively. */
export function sanitizeSnippet(input: string): string {
  return sanitizeMessage(input, MAX_SNIPPET_LEN);
}

export function sanitizeStderrTail(input: string): string {
  return sanitizeMessage(input, MAX_STDERR_TAIL_LEN);
}
