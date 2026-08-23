/**
 * Boot-time update check — "is a newer Editmamei published?"
 *
 * Why this exists: an MCP stdio server's stderr is swallowed by the client, so a
 * logged "update available" never reaches the user. The only reliable user-visible
 * channel is a tool result, so the result of this check rides `ps_ping`'s
 * output (`src/core/server.ts`), which the skill mandates as the first call of a
 * session. This module is the pure, testable core: fetch the `latest` version
 * manifest from npm, compare to the running version, and — if behind — produce an
 * install-channel-aware remediation message plus the list of tools whose recorded
 * failures the newer versions fix (see `fixesByVersion` below).
 *
 * Contract: **fail-silent**. Any error (offline, timeout, non-2xx, malformed body)
 * resolves to `null`. The check is a fire-and-forget GET to the public npm registry
 * — anonymous, content-free, no usage data — gated behind the `update_check` setting
 * (opt-out) so it never runs against the user's wishes or under the test runner.
 */

import { VERSION } from '../version.js';
import { resolveInstallChannel, type InstallChannel } from '../install-channel.js';

export interface UpdateInfo {
  /** The version currently running. */
  current: string;
  /** The newest version published to npm. */
  latest: string;
  /** How this host was installed — selects the remediation wording. */
  channel: InstallChannel;
  /** Plain-language "here's how to update" for this channel. */
  how_to_update: string;
  /**
   * Tools whose recorded failures are fixed in a version newer than the one
   * running — the manifest's `fixesByVersion` map flattened over `(current, latest]`.
   * Empty when the publish carries no map or nothing in that window applies.
   */
  fixed_tools: string[];
}

/**
 * npm version-manifest endpoint. The `latest` tag resolves server-side and the
 * response is that version's `package.json` manifest, custom fields included — so
 * ONE request carries both the version string and the release-metadata map below.
 * Same host and same request count as the dist-tags endpoint this replaced, which
 * keeps docs/privacy.md's "one request, to the public npm registry" literally true.
 */
const DEFAULT_LATEST_MANIFEST_URL = 'https://registry.npmjs.org/editmamei/latest';

/** What the fetch yields from the version manifest. */
export interface LatestManifest {
  /** The version the `latest` tag points at. */
  version: string;
  /**
   * The curated fixes map published under the `editmamei.fixesByVersion` key of
   * `package.json`: version → tools whose RECORDED FAILURES that version fixes.
   * Curation rules (enforced editorially at cut time, not by code): list a tool
   * only when failures a user actually logged are fixed — not message-quality or
   * internal changes — and list it under the name the FAILING version's session
   * log records (for a tool renamed since, that is the old name). Each cut keeps
   * a window of recent versions so a straggler several releases behind still
   * sees the fixes that landed in between.
   */
  fixesByVersion: Record<string, string[]>;
}

/**
 * Where users download the one-click bundle.
 *
 * Deliberately a URL we own and can redirect, not a direct link to whichever
 * repository currently hosts releases. This string is baked into every shipped
 * copy and cannot be changed retroactively, so pointing it at a specific host
 * makes that host permanent for every install of this era. Behind the redirect,
 * the release surface can move without stranding anyone.
 */
const RELEASES_URL = 'https://editmamei.com/download';

/** Endpoint override (tests / future custom registry). Mirrors the telemetry transport. */
export function resolveUpdateCheckUrl(
  env: Record<string, string | undefined> = process.env
): string {
  const override = env.EDITMAMEI_UPDATE_CHECK_URL;
  return override && override.length > 0 ? override : DEFAULT_LATEST_MANIFEST_URL;
}

/** Fetches the `latest` version manifest, or null on any failure. Injectable for tests. */
export type FetchLatestManifest = (
  url: string,
  timeoutMs: number
) => Promise<LatestManifest | null>;

/**
 * Caps on the parsed fixes map. The registry response is remote input that ends up
 * in the ping's structuredContent, so bound everything: a hijacked publish must not
 * be able to flood the model's context through this side door. Generous vs. real
 * use (a curated window of a few versions, a handful of tools each).
 */
const MAX_FIX_VERSIONS = 16;
const MAX_TOOLS_PER_VERSION = 16;
const MAX_TOOL_NAME_LENGTH = 64;

/**
 * Defensive parse of the manifest's `editmamei.fixesByVersion` field. The registry
 * response is remote input: keep only well-formed entries (semver key, array value,
 * bounded string members), cap the totals, and drop everything else silently — a
 * malformed map must degrade to a plain version notice, never break the check.
 * (Semver-anchored keys also mean `__proto__` and friends can never become keys.)
 */
export function parseFixesByVersion(raw: unknown): Record<string, string[]> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string[]> = {};
  let versions = 0;
  for (const [version, tools] of Object.entries(raw as Record<string, unknown>)) {
    if (versions >= MAX_FIX_VERSIONS) break;
    if (!parseSemver(version) || !Array.isArray(tools)) continue;
    const names = tools
      .filter(
        (t): t is string =>
          typeof t === 'string' && t.length > 0 && t.length <= MAX_TOOL_NAME_LENGTH
      )
      .slice(0, MAX_TOOLS_PER_VERSION);
    if (names.length > 0) {
      out[version] = names;
      versions++;
    }
  }
  return out;
}

export function httpFetchLatest(): FetchLatestManifest {
  return async (url, timeoutMs) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        version?: unknown;
        editmamei?: { fixesByVersion?: unknown };
      };
      if (typeof data.version !== 'string') return null;
      return {
        version: data.version,
        fixesByVersion: parseFixesByVersion(data.editmamei?.fixesByVersion),
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}

function parseSemver(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True iff `latest` is a strictly higher X.Y.Z than `current`. Host versions are plain
 * semver with no prerelease tags, so a numeric major/minor/patch compare is sufficient. */
export function isNewer(latest: string, current: string): boolean {
  const a = parseSemver(latest);
  const b = parseSemver(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/**
 * Flatten the fixes map over the versions the user would gain by updating —
 * strictly newer than `current`, up to and including `latest`. Entries at or below
 * the running version are already installed; entries above `latest` should not
 * exist in a sane publish, but a manifest is remote input, so exclude them rather
 * than promise fixes the `latest` install doesn't contain. Deduplicated, ordered
 * oldest version first so the earliest fix of a tool wins the (stable) position.
 */
export function fixedToolsSince(
  fixesByVersion: Record<string, string[]>,
  current: string,
  latest: string
): string[] {
  const versions = Object.keys(fixesByVersion)
    .filter((v) => isNewer(v, current) && !isNewer(v, latest))
    .sort((a, b) => {
      const pa = parseSemver(a)!;
      const pb = parseSemver(b)!;
      for (let i = 0; i < 3; i++) {
        if (pa[i] !== pb[i]) return pa[i] - pb[i];
      }
      return 0;
    });
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of versions) {
    for (const tool of fixesByVersion[v]) {
      if (!seen.has(tool)) {
        seen.add(tool);
        out.push(tool);
      }
    }
  }
  return out;
}

/** Channel-specific remediation. The ping text states the version delta; this is the
 * "what to do about it." */
export function updateMessage(channel: InstallChannel, latest: string): string {
  switch (channel) {
    case 'mcpb':
      // The release asset uses a STABLE, versionless filename so the website's
      // permanent download URL never 404s (see release.yml); the version is
      // surfaced in parentheses here for clarity.
      return `Download editmamei.mcpb (v${latest}) from ${RELEASES_URL} and reinstall the Claude Desktop extension.`;
    case 'dev':
      return `You're on a local dev build — pull the latest source and rebuild.`;
    case 'npm':
    default:
      return `Run: npm install -g editmamei@latest (then restart your MCP client).`;
  }
}

/** Whether the boot check should run at all. Opt-out via the `update_check` setting; never
 * under the test runner (so the suite makes no network calls). */
export function shouldCheckForUpdate(
  updateCheckEnabled: boolean,
  env: Record<string, string | undefined> = process.env
): boolean {
  const inTest = env.VITEST !== undefined || env.NODE_ENV === 'test';
  return updateCheckEnabled === true && !inTest;
}

export interface CheckOptions {
  env?: Record<string, string | undefined>;
  /** Override the running version (tests). Defaults to the baked `VERSION`. */
  current?: string;
  /** Override the network fetch (tests). Defaults to the real npm-registry GET. */
  fetchLatest?: FetchLatestManifest;
  timeoutMs?: number;
}

/**
 * Check npm for a newer version. Resolves to an `UpdateInfo` when one exists, else `null`
 * (already current, or any failure — this never throws).
 */
export async function checkForUpdate(opts: CheckOptions = {}): Promise<UpdateInfo | null> {
  try {
    const env = opts.env ?? process.env;
    const current = opts.current ?? VERSION;
    const channel = resolveInstallChannel(env);
    const fetchLatest = opts.fetchLatest ?? httpFetchLatest();
    const manifest = await fetchLatest(resolveUpdateCheckUrl(env), opts.timeoutMs ?? 4000);
    if (!manifest || !parseSemver(manifest.version)) return null;
    const latest = manifest.version;
    if (!isNewer(latest, current)) return null;
    return {
      current,
      latest,
      channel,
      how_to_update: updateMessage(channel, latest),
      fixed_tools: fixedToolsSince(manifest.fixesByVersion, current, latest),
    };
  } catch {
    return null;
  }
}
