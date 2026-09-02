/**
 * How this host was installed — drives the *remediation* text in the
 * boot-time update check (see `src/update/check.ts`) and the telemetry `channel`
 * dimension. Each channel updates differently (npx re-fetches on next launch, a global
 * npm install needs `npm install -g`, the one-click `.mcpb` bundle needs a re-download +
 * reinstall, a source checkout needs a pull + rebuild), so the "a new version is
 * available" message has to say the right thing for the channel the user is actually on.
 *
 * Why an env var for mcpb, not a build-edition stamp: the `.mcpb` bundle is compiled by
 * the SAME `runBuild('community', …)` path as the npm CE tarball (`scripts/build-mcpb.ts`),
 * so `src/edition.ts` can't tell them apart. The `.mcpb` manifest already injects env
 * hints into the spawned server (the telemetry toggles), so it also sets
 * `EDITMAMEI_INSTALL_CHANNEL=mcpb` (`buildMcpbManifest`).
 *
 * The remaining three channels are told apart from the entry script's own path
 * (`process.argv[1]` — the file Node was invoked with), since npm/npx both leave no env
 * marker of their own:
 *   - **npx** — a one-off run through npm's `_npx` cache dir (e.g.
 *     `~/.npm/_npx/<hash>/node_modules/editmamei/dist/index.js` on POSIX,
 *     `%LocalAppData%\npm-cache\_npx\<hash>\...` on Windows) — the path contains an
 *     `_npx` path segment on both.
 *   - **npm_global** — an ordinary `npm install -g` puts the entry script under some
 *     other `node_modules/editmamei/...` (global prefix, not `_npx`).
 *   - **source** — anything else: a git checkout run directly (`node dist/index.js`),
 *     which has no `node_modules` segment in its own path at all.
 * A local dev build (`EDITION==='dev'`) is checked FIRST and short-circuits all of the
 * above — that's a contributor's working tree, not a distributed artifact, so the update
 * remediation must say "pull + rebuild", never "npm install" or "npx".
 */

import { EDITION } from './edition.js';

export type InstallChannel = 'npx' | 'npm_global' | 'mcpb' | 'source' | 'dev';

export function resolveInstallChannel(
  env: Record<string, string | undefined> = process.env,
  // `edition` is injectable so tests can exercise every branch; production always uses
  // the build-time EDITION constant (the test tree is EDITION='dev').
  edition: typeof EDITION = EDITION,
  // The running entry script's path, injectable for tests. Production always uses the
  // real `process.argv[1]` (the file Node was invoked with).
  argv1: string | undefined = process.argv[1]
): InstallChannel {
  // A dev build is a working tree, not a distributed artifact — surface that
  // honestly so the update remediation doesn't tell a contributor to `npm install`.
  if (edition === 'dev') return 'dev';
  if (env.EDITMAMEI_INSTALL_CHANNEL === 'mcpb') return 'mcpb';
  const entry = argv1 ?? '';
  if (entry.includes('/_npx/') || entry.includes('\\_npx\\')) return 'npx';
  if (entry.includes('node_modules')) return 'npm_global';
  return 'source';
}
