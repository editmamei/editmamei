/**
 * How this host was installed — drives the *remediation* text in the
 * boot-time update check (see `src/update/check.ts`) and the telemetry `channel`
 * dimension. Each channel updates differently (npx re-fetches on next launch, a global
 * npm install needs `npm install -g`, the one-click `.mcpb` bundle needs a re-download +
 * reinstall, a source checkout needs a pull + rebuild, a project-local install needs the
 * hosting project's own dependency updated), so the "a new version is available" message
 * has to say the right thing for the channel the user is actually on.
 *
 * Why an env var for mcpb, not a build-edition stamp: the `.mcpb` bundle is compiled by
 * the SAME `runBuild('community', …)` path as the npm CE tarball (`scripts/build-mcpb.ts`),
 * so `src/edition.ts` can't tell them apart. The `.mcpb` manifest already injects env
 * hints into the spawned server (the telemetry toggles), so it also sets
 * `EDITMAMEI_INSTALL_CHANNEL=mcpb` (`buildMcpbManifest`).
 *
 * The remaining channels are told apart from the entry script's own path (`process.argv[1]`
 * — the file Node was invoked with), REALPATH-RESOLVED first: a global npm/nvm/Homebrew
 * install runs through a symlinked bin shim (`/usr/local/bin/editmamei`, an nvm shim under
 * `.../bin/`), and `argv[1]` is set by `path.resolve`, not `realpath` — the shim's path has
 * no `node_modules` segment at all, so without resolving the symlink first every one of
 * those installs would misclassify as a source checkout. `process.execPath` is resolved
 * through that SAME realpath before the exec-dir prefix compare (the npm_global rule that
 * looks for `node_modules` sitting alongside the node binary itself): on nvm-windows or
 * fnm, the directory node.exe appears to live in (e.g. `C:\Program Files\nodejs`) is itself
 * a symlink to the real version directory, while the entry path resolves the same symlink
 * away — comparing an unresolved execPath against a resolved argv1 would put the two sides
 * in different path spaces and the prefix match would silently fail. Resolving both leaves
 * version-manager symlinks on either platform comparing consistently. The resolved path is
 * then matched by PATH SEGMENT (split on `/` and `\`, compared CASE-INSENSITIVELY — a
 * Windows path can arrive in whatever case the launcher or an MCP config used), never by
 * substring — a checkout living under a directory that merely CONTAINS the text
 * `node_modules` (e.g. `node_modules_backup/`) is not a `node_modules` segment and must not
 * be misread as an install:
 *
 *   - **npx** — a one-off run through npm's `_npx` cache dir (e.g.
 *     `~/.npm/_npx/<hash>/node_modules/editmamei/dist/index.js` on POSIX,
 *     `%LocalAppData%\npm-cache\_npx\<hash>\...` on Windows) — the path has an `_npx`
 *     segment.
 *   - **npm_global** — a `node_modules` segment that is either preceded by a `lib` segment
 *     (the POSIX/nvm/volta convention: `.../lib/node_modules/editmamei/...`), preceded by
 *     an `npm` segment (Windows' `%APPDATA%\npm\node_modules\editmamei\...`), or sits at or
 *     under the directory `process.execPath` lives in (the Windows official installer's
 *     `node_modules` living alongside `node.exe` itself, with neither a `lib` nor an `npm`
 *     segment above it).
 *   - **npm_local** — any OTHER `node_modules` segment: a project-local install (the entry
 *     script lives under some project's own `node_modules/editmamei/...`, not a global
 *     prefix). Needs different remediation from npm_global — the user updates the package
 *     in the project that hosts it, not a global `npm install -g`.
 *   - **source** — no `node_modules` segment anywhere in the resolved path at all: a git
 *     checkout run directly (`node dist/index.js`).
 *   - **unknown** — the entry path itself isn't available (`argv[1]` empty or undefined
 *     after trimming), so there's nothing to classify. Distinct from `source`: this means
 *     "we don't know," not "we know it's a checkout."
 *
 * A local dev build (`EDITION==='dev'`) is checked FIRST and short-circuits all of the
 * above — that's a contributor's working tree, not a distributed artifact, so the update
 * remediation must say "pull + rebuild", never "npm install" or "npx".
 */

import { realpathSync } from 'node:fs';
import { EDITION } from './edition.js';

export type InstallChannel =
  'npx' | 'npm_global' | 'npm_local' | 'mcpb' | 'source' | 'dev' | 'unknown';

/** Split a path into its non-empty, LOWERCASED segments, on either separator (Windows paths
 *  in this codebase can arrive with either, since they're not always normalized before
 *  reaching here — `process.argv[1]` is whatever the OS/launcher handed Node). Lowercased
 *  because a Windows path can arrive in whatever case the launcher (or a hand-edited MCP
 *  config) used; a POSIX directory that differs from `node_modules`/`lib`/`npm`/`_npx` only
 *  by case is not a distinction this classification needs to defend. */
function pathSegments(path: string): string[] {
  return path
    .split(/[\\/]/)
    .filter((s) => s.length > 0)
    .map((s) => s.toLowerCase());
}

/** Resolve symlinks in an entry path, falling back to the input unchanged on any error —
 *  the path may not exist (e.g. under a test), and this classification must never throw
 *  over a filesystem read. `.native` avoids the extra work of the pure-JS fallback path
 *  `realpathSync` otherwise uses for a small perf win on a call that runs once per boot. */
function defaultRealpath(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

/** Runs `realpath` over `p`, falling back to `p` unchanged if the call throws. Guarded
 *  independently of `defaultRealpath`'s own try/catch, so an INJECTED `realpath` (a test
 *  stub) that throws degrades to the unresolved path rather than propagating out of this
 *  classification helper. Shared by both `argv1` and `execPath` so the two sides of the
 *  exec-dir prefix compare are resolved the same way. */
function safeRealpath(p: string, realpath: (p: string) => string): string {
  try {
    return realpath(p);
  } catch {
    return p;
  }
}

export function resolveInstallChannel(
  env: Record<string, string | undefined> = process.env,
  // `edition` is injectable so tests can exercise every branch; production always uses
  // the build-time EDITION constant (the test tree is EDITION='dev').
  edition: typeof EDITION = EDITION,
  // The running entry script's path, injectable for tests. Production always uses the
  // real `process.argv[1]` (the file Node was invoked with).
  argv1: string | undefined = process.argv[1],
  // The running node binary's own path, injectable for tests. Production always uses the
  // real `process.execPath`.
  execPath: string | undefined = process.execPath,
  // Resolves symlinks in `argv1` before it's segmented — injectable so tests can exercise a
  // specific shim -> real-path mapping (or a broken filesystem) without touching the real
  // one. Production always uses `defaultRealpath`.
  realpath: (p: string) => string = defaultRealpath
): InstallChannel {
  // A dev build is a working tree, not a distributed artifact — surface that
  // honestly so the update remediation doesn't tell a contributor to `npm install`.
  if (edition === 'dev') return 'dev';
  if (env.EDITMAMEI_INSTALL_CHANNEL === 'mcpb') return 'mcpb';

  const trimmedArgv1 = argv1?.trim();
  if (!trimmedArgv1) return 'unknown';

  // Bin shims are symlinks on POSIX (see the header comment) — resolve before segmenting.
  const resolvedArgv1 = safeRealpath(trimmedArgv1, realpath);

  const segments = pathSegments(resolvedArgv1);
  if (segments.includes('_npx')) return 'npx';

  const nodeModulesIdx = segments.indexOf('node_modules');
  if (nodeModulesIdx === -1) return 'source';

  const precedingSegment = nodeModulesIdx > 0 ? segments[nodeModulesIdx - 1] : undefined;
  if (precedingSegment === 'lib' || precedingSegment === 'npm') return 'npm_global';

  // Under the directory the running node binary itself lives in — the Windows official
  // installer's layout, where `node_modules\` sits directly alongside `node.exe` with no
  // `lib` or `npm` segment above it. Realpath-resolved through the same `realpath` as
  // `argv1` (see the header comment) — a version manager can symlink the directory node.exe
  // appears to live in, and comparing an unresolved execPath against a resolved argv1 would
  // put the two sides in different path spaces. Segment-sliced (drop the binary's own
  // filename) rather than `path.dirname`, so this doesn't depend on which platform's
  // separator convention node:path happens to apply at runtime — this module already
  // hand-splits every path.
  const resolvedExecPath = execPath === undefined ? undefined : safeRealpath(execPath, realpath);
  const execDirSegments = pathSegments(resolvedExecPath ?? '').slice(0, -1);
  const entryPrefix = segments.slice(0, nodeModulesIdx);
  const underExecDir =
    execDirSegments.length > 0 && execDirSegments.every((seg, i) => entryPrefix[i] === seg);
  if (underExecDir) return 'npm_global';

  // Any other `node_modules` segment is a project-local install, not a global one.
  return 'npm_local';
}
