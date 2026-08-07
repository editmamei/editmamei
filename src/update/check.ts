/**
 * Boot-time update check — "is a newer Editmamei published?"
 *
 * Why this exists: an MCP stdio server's stderr is swallowed by the client, so a
 * logged "update available" never reaches the user. The only reliable user-visible
 * channel is a tool result, so the result of this check rides `ps_ping`'s
 * output (`src/core/server.ts`), which the skill mandates as the first call of a
 * session. This module is the pure, testable core: fetch npm's `latest` dist-tag,
 * compare to the running version, and — if behind — produce an install-channel-aware
 * remediation message.
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
}

/** npm dist-tags endpoint — tiny JSON (`{"latest":"x.y.z",...}`), no full packument. */
const DEFAULT_DIST_TAGS_URL = 'https://registry.npmjs.org/-/package/editmamei/dist-tags';

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
  return override && override.length > 0 ? override : DEFAULT_DIST_TAGS_URL;
}

/** Fetches the `latest` dist-tag string, or null on any failure. Injectable for tests. */
export type FetchLatest = (url: string, timeoutMs: number) => Promise<string | null>;

export function httpFetchLatest(): FetchLatest {
  return async (url, timeoutMs) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { latest?: unknown };
      return typeof data.latest === 'string' ? data.latest : null;
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
  fetchLatest?: FetchLatest;
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
    const latest = await fetchLatest(resolveUpdateCheckUrl(env), opts.timeoutMs ?? 4000);
    if (!latest || !parseSemver(latest)) return null;
    if (!isNewer(latest, current)) return null;
    return { current, latest, channel, how_to_update: updateMessage(channel, latest) };
  } catch {
    return null;
  }
}
