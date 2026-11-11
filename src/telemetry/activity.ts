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

export {
  READ_ONLY_TOOLS,
  KEPT_WORK_TOOLS,
  MUTATING_TOOLS,
  RECIPE_TOOLS,
  MAX_CALL_ITEMS,
  itemsFromResult,
} from '../core/tool-activity.js';

/**
 * The MCP clients telemetry can name. The server accepts exactly this list (the telemetry Worker's
 * `CLIENTS`), so a value is added there and deployed before a release sends it.
 */
export const CLIENTS = [
  'claude_desktop',
  'claude_code',
  'cursor',
  'windsurf',
  'vscode',
  'visual_studio',
  'jetbrains',
  'xcode_copilot',
  'copilot_cli',
  'codex',
  'gemini_cli',
  'cline',
  'roo_code',
  'kilo_code',
  'continue',
  'zed',
  'goose',
  'opencode',
  'crush',
  'amp',
  'factory',
  'amazon_q',
  'kiro',
  'antigravity',
  'warp',
  'lm_studio',
  'cherry_studio',
  'raycast',
  'librechat',
  'jan',
  'lobehub',
  'chatgpt',
  'other',
] as const;

export type ClientToken = (typeof CLIENTS)[number];

const has =
  (...parts: string[]) =>
  (n: string): boolean =>
    parts.some((p) => n.includes(p));
/** A whole word: not inside a longer run of letters or digits. */
const word =
  (...words: string[]) =>
  (n: string): boolean =>
    words.some((w) => new RegExp(`(^|[^a-z0-9])${w}([^a-z0-9]|$)`).test(n));
/** The name's first word. */
const first =
  (w: string) =>
  (n: string): boolean =>
    new RegExp(`^${w}([^a-z0-9]|$)`).test(n);

/**
 * Ordered rules, first match wins. The order resolves names that contain another client's:
 * `claude-code` before `claude`, `cursor-vscode` before `vscode`, the JetBrains and Xcode Copilot
 * names before the Copilot CLI's, `roo-cline` before `cline`, `opencode` and `Kilo-Code` before any
 * `code` rule. No rule matches a bare `code` or `cli`, which too many names contain. Short names
 * match as whole words, or only as the name's first word.
 */
const CLIENT_RULES: readonly (readonly [ClientToken, (n: string) => boolean])[] = [
  ['claude_code', has('claude-code', 'claude_code', 'claudecode')],
  ['claude_desktop', has('claude')],
  ['cursor', has('cursor')],
  ['windsurf', has('windsurf')],
  ['jetbrains', has('jetbrains', 'junie')],
  ['xcode_copilot', has('xcode')],
  [
    'copilot_cli',
    (n) => has('github-copilot-developer')(n) || word('copilot-cli', 'copilot cli')(n),
  ],
  ['kilo_code', has('kilo')],
  ['roo_code', has('roo-code', 'roo code', 'roocode', 'roo-cline')],
  ['cline', has('cline')],
  ['codex', has('codex')],
  ['gemini_cli', has('gemini')],
  ['amazon_q', has('q-dev-cli', 'amazon q', 'amazon-q', 'amazonq')],
  ['kiro', word('kiro')],
  ['continue', word('continue')],
  ['opencode', has('opencode')],
  ['antigravity', has('antigravity')],
  [
    'vscode',
    (n) =>
      has(
        'vscode',
        'visual studio code',
        'visual-studio-code',
        'visual_studio_code',
        'visualstudiocode',
        'code-oss'
      )(n) || word('vs code')(n),
  ],
  ['visual_studio', has('visual studio', 'visual-studio', 'visualstudio')],
  ['zed', word('zed')],
  ['goose', word('goose')],
  ['amp', (n) => has('amp-mcp-client', 'sourcegraph')(n) || first('amp')(n)],
  ['crush', word('crush')],
  ['factory', (n) => word('factory-cli', 'factory droid')(n) || first('factory')(n)],
  ['warp', word('warp')],
  ['lm_studio', has('lm studio', 'lm-studio', 'lmstudio')],
  ['cherry_studio', has('cherry')],
  ['raycast', has('raycast')],
  ['librechat', has('librechat')],
  ['jan', first('jan')],
  ['lobehub', has('lobehub', 'lobe-chat', 'lobechat')],
  ['chatgpt', has('chatgpt')],
];

/**
 * Map the MCP client's self-reported `name` (from the `initialize` handshake, or a 2026-07-28
 * request's client info) to the fixed list above, never the raw string. Calibrated against the
 * names clients report, among them `claude-ai` (Claude Desktop), `claude-code`, `cursor-vscode`,
 * `Visual Studio Code`, `codex-mcp-client`, `gemini-cli-mcp-client`, `Cline` and `@cline/core`.
 */
export function mapClientName(name: string | undefined): ClientToken {
  if (name === undefined) return 'other';
  const n = name.toLowerCase();
  for (const [client, matches] of CLIENT_RULES) if (matches(n)) return client;
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
