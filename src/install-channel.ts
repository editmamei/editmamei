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
 * — the file Node was invoked with), matched by PATH SEGMENT (split on `/` and `\`), never
 * by substring — a checkout living under a directory that merely CONTAINS the text
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
 *   - **source** — no `node_modules` segment anywhere in the path at all: a git checkout
 *     run directly (`node dist/index.js`).
 *
 * A local dev build (`EDITION==='dev'`) is checked FIRST and short-circuits all of the
 * above — that's a contributor's working tree, not a distributed artifact, so the update
 * remediation must say "pull + rebuild", never "npm install" or "npx".
 */

import { EDITION } from './edition.js';

export type InstallChannel = 'npx' | 'npm_global' | 'npm_local' | 'mcpb' | 'source' | 'dev';

/** Split a path into its non-empty segments, on either separator (Windows paths in this
 *  codebase can arrive with either, since they're not always normalized before reaching
 *  here — `process.argv[1]` is whatever the OS/launcher handed Node). */
function pathSegments(path: string): string[] {
  return path.split(/[\\/]/).filter((s) => s.length > 0);
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
  execPath: string | undefined = process.execPath
): InstallChannel {
  // A dev build is a working tree, not a distributed artifact — surface that
  // honestly so the update remediation doesn't tell a contributor to `npm install`.
  if (edition === 'dev') return 'dev';
  if (env.EDITMAMEI_INSTALL_CHANNEL === 'mcpb') return 'mcpb';

  const segments = pathSegments(argv1 ?? '');
  if (segments.includes('_npx')) return 'npx';

  const nodeModulesIdx = segments.indexOf('node_modules');
  if (nodeModulesIdx === -1) return 'source';

  const precedingSegment = nodeModulesIdx > 0 ? segments[nodeModulesIdx - 1] : undefined;
  if (precedingSegment === 'lib' || precedingSegment === 'npm') return 'npm_global';

  // Under the directory the running node binary itself lives in — the Windows official
  // installer's layout, where `node_modules\` sits directly alongside `node.exe` with no
  // `lib` or `npm` segment above it. Segment-sliced (drop the binary's own filename) rather
  // than `path.dirname`, so this doesn't depend on which platform's separator convention
  // node:path happens to apply at runtime — this module already hand-splits every path.
  const execDirSegments = pathSegments(execPath ?? '').slice(0, -1);
  const entryPrefix = segments.slice(0, nodeModulesIdx);
  const underExecDir =
    execDirSegments.length > 0 && execDirSegments.every((seg, i) => entryPrefix[i] === seg);
  if (underExecDir) return 'npm_global';

  // Any other `node_modules` segment is a project-local install, not a global one.
  return 'npm_local';
}
