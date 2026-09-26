/**
 * Small, pure helpers for the telemetry client's wire fields: mapping the connected MCP
 * client's self-reported name to a fixed enum, coercing a semver-ish version string to its
 * leading major, bounding a parsed major to a wire-safe range, and reading the boot-time
 * platform facts (Node major, CPU arch, OS major).
 *
 * Content-free by construction: every value here is an enum token or a small integer, never
 * a free-text string.
 *
 * The tool-activity classification used for `edits_ok` / `kept_work` lives in
 * `src/core/tool-activity.ts` (it names every tool, Pro tools included, so it sits with the
 * other tool inventories that the CE build's Pro-name scan exempts) and is re-exported here
 * for the telemetry client. Its sync and exhaustiveness rules are documented there.
 */

export { READ_ONLY_TOOLS, KEPT_WORK_TOOLS, MUTATING_TOOLS } from '../core/tool-activity.js';

/**
 * Map the MCP client's self-reported `name` (from the `initialize` handshake) to a fixed
 * enum. Lowercase substring rules, first match wins — order matters: `claude-code` must be
 * checked before the bare `claude` fallback, or Claude Code would misclassify as Desktop.
 * Calibrated against the `mcp_client` names these clients actually report: Claude Desktop
 * sends `"claude-ai"` (caught by the generic `claude` rule) and Claude Code sends
 * `"claude-code"` (caught by the specific rule first).
 */
export function mapClientName(
  name: string | undefined
): 'claude_desktop' | 'claude_code' | 'cursor' | 'windsurf' | 'vscode' | 'other' {
  if (name === undefined) return 'other';
  const n = name.toLowerCase();
  if (n.includes('claude-code') || n.includes('claude_code') || n.includes('claudecode')) {
    return 'claude_code';
  }
  if (n.includes('claude')) return 'claude_desktop';
  if (n.includes('cursor')) return 'cursor';
  if (n.includes('windsurf')) return 'windsurf';
  if (n.includes('vscode') || n.includes('visual studio') || n.includes('code-oss')) {
    return 'vscode';
  }
  return 'other';
}

/** The leading integer of a semver-ish string ("2.1.170" -> 2), or null when unparseable. */
export function parseMajor(version: string | undefined): number | null {
  if (version === undefined) return null;
  const m = /^(\d+)/.exec(version.trim());
  return m ? Number(m[1]) : null;
}

/**
 * Clamp a parsed major version to a plausible, wire-safe range, discarding anything outside
 * it. The server's field specs (NODE_MAJOR/OS_MAJOR: 0..999; CLIENT_MAJOR: 0..9999) reject an
 * out-of-range int outright and 400 the whole batch — a garbled or hostile input must never
 * reach the wire as a huge or negative integer that could take a batch down with it. Returns
 * null when `n` is null or falls outside `[0, max]`.
 */
export function boundMajor(n: number | null, max: number): number | null {
  return n !== null && Number.isFinite(n) && n >= 0 && n <= max ? n : null;
}

/** The running Node.js major version, from `process.versions.node`, or `null` when unparseable. */
export function nodeMajor(): number | null {
  return parseMajor(process.versions.node);
}

/** `process.arch`, narrowed to the three buckets telemetry cares about. */
export function archToken(): 'x64' | 'arm64' | 'other' {
  if (process.arch === 'x64') return 'x64';
  if (process.arch === 'arm64') return 'arm64';
  return 'other';
}

/**
 * Coerce a platform + `os.release()` string to a human OS major version. `platform` and
 * `release` are passed in (rather than read from `node:os` directly) so tests can inject
 * both without depending on the test host's real OS.
 *
 *   - win32: `os.release()` is `<major>.<minor>.<build>` (e.g. "10.0.22631"). Windows 11
 *     reports the SAME major.minor as Windows 10 and is distinguished only by build number
 *     — build >= 22000 means 11, otherwise the leading major (10) stands.
 *   - darwin: `os.release()` is the Darwin kernel version. Through Darwin 24 (macOS 13-15)
 *     the marketing major is the Darwin major minus 9 (24 -> 15, 23 -> 14, 22 -> 13); Apple
 *     broke that mapping at Darwin 25 (macOS 26 "Tahoe"), so from there it's Darwin major
 *     plus 1 instead (25 -> 26).
 *   - other: the leading integer of `release` (e.g. a Linux kernel version).
 *
 * Returns null when `release` doesn't parse.
 */
export function osMajor(platform: string, release: string): number | null {
  if (platform === 'win32') {
    const parts = release.split('.');
    const major = Number(parts[0]);
    if (!Number.isFinite(major)) return null;
    const build = Number(parts[2]);
    return Number.isFinite(build) && build >= 22000 ? 11 : major;
  }
  if (platform === 'darwin') {
    const m = /^(\d+)/.exec(release);
    if (!m) return null;
    const darwinMajor = Number(m[1]);
    return darwinMajor <= 24 ? darwinMajor - 9 : darwinMajor + 1;
  }
  const m = /^(\d+)/.exec(release);
  return m ? Number(m[1]) : null;
}
