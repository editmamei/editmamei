/**
 * Small, pure helpers for the telemetry client's wire fields: mapping the connected MCP
 * client's self-reported name to a fixed enum, coercing a semver-ish version string to its
 * leading major, and reading the boot-time platform facts (Node major, CPU arch, OS major).
 * Also the shared tool-activity classification used for `edits_ok` / `kept_work` in the
 * session summary.
 *
 * Content-free by construction: every value here is an enum token or a small integer, never
 * a free-text string.
 *
 * The telemetry server carries an IDENTICAL copy of READ_ONLY_TOOLS / KEPT_WORK_TOOLS in its
 * own `src/activity.ts` for the aggregate rollups; keep the two in sync by hand whenever
 * either changes. Both lists must also be reconciled against `src/core/tool-tiers.ts`
 * whenever the tool roster changes — a tool added there and forgotten here silently falls
 * through to the DEFAULT classification, not a neutral one: READ_ONLY_TOOLS must be
 * EXHAUSTIVE, because any tool absent from it counts as an edit (`edits_ok`) the moment it
 * succeeds, whether or not it actually reads-only.
 */

/**
 * Tools whose successful call reads state without changing the document — used to decide
 * `edits_ok` (a successful call outside this set). See the module doc comment above for the
 * server-sync + exhaustiveness discipline this list is held to.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'ps_ping',
  'ps_overview',
  'ps_list_capabilities',
  'ps_get_preview',
  'ps_get_selection_preview',
  'ps_get_histogram',
  'ps_inspect',
  'ps_read_scene',
  'ps_compare_regions',
  'ps_get_layer_bounds_diff',
  'ps_template_list',
  'ps_template_recall',
  'ps_list_actions',
  'ps_report_problem',
  'ps_detect',
  'ps_detect_landmarks',
  // ps_document — only op=list/activate reach telemetry as this tool name; neither
  // touches pixels (list reads state, activate just switches the active document).
  'ps_document',
  'ps_template_verify',
  'ps_resolve_placement',
]);

/**
 * Tools whose successful call writes the result to disk outside the open document — used to
 * decide `kept_work` (a successful call in this set). Mirrored on the server; keep in sync
 * the same way as READ_ONLY_TOOLS above.
 */
export const KEPT_WORK_TOOLS: ReadonlySet<string> = new Set(['ps_export', 'ps_save_psd']);

/**
 * Map the MCP client's self-reported `name` (from the `initialize` handshake) to a fixed
 * enum. Lowercase substring rules, first match wins — order matters: `claude-code` must be
 * checked before the bare `claude` fallback, or Claude Code would misclassify as Desktop.
 * Calibrated 2026-09 against real `mcp_client` names recorded in this machine's local
 * session NDJSON (`~/.editmamei/sessions/*.ndjson`): Claude Desktop reports `"claude-ai"`
 * (caught by the generic `claude` rule), Claude Code reports `"claude-code"` (caught by the
 * specific rule first) — both map correctly with no adjustment needed.
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

/** The running Node.js major version, from `process.versions.node`. */
export function nodeMajor(): number {
  return parseMajor(process.versions.node) ?? 0;
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
 *   - darwin: `os.release()` is the Darwin kernel version; the marketing macOS major is the
 *     Darwin major minus 9 (24 -> 15, 23 -> 14, 22 -> 13).
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
    return m ? Number(m[1]) - 9 : null;
  }
  const m = /^(\d+)/.exec(release);
  return m ? Number(m[1]) : null;
}
