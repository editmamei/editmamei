/**
 * How this host was installed — drives the *remediation* text in the
 * boot-time update check (see `src/update/check.ts`). The npm package and the
 * one-click `.mcpb` bundle update differently (npm install vs. download + reinstall
 * the Claude Desktop extension), so the "a new version is available" message has to
 * say the right thing for the channel the user is actually on.
 *
 * Why an env var, not a build-edition stamp: the `.mcpb` bundle is compiled by the
 * SAME `runBuild('community', …)` path as the npm CE tarball (`scripts/build-mcpb.ts`),
 * so `src/edition.ts` can't tell them apart. The `.mcpb` manifest already injects env
 * hints into the spawned server (the telemetry toggles), so it also sets
 * `EDITMAMEI_INSTALL_CHANNEL=mcpb` (`buildMcpbManifest`). The npm/CLI path sets nothing
 * → defaults to `'npm'`. A local dev build reports `'dev'` (EDITION marker) so the
 * update message says "pull + rebuild", not "npm install".
 */

import { EDITION } from './edition.js';

export type InstallChannel = 'npm' | 'mcpb' | 'dev';

export function resolveInstallChannel(
  env: Record<string, string | undefined> = process.env,
  // `edition` is injectable so tests can exercise the npm/mcpb branches; production always
  // uses the build-time EDITION constant (the test tree is EDITION='dev').
  edition: typeof EDITION = EDITION
): InstallChannel {
  // A dev build is a working tree, not a distributed artifact — surface that
  // honestly so the update remediation doesn't tell a contributor to `npm install`.
  if (edition === 'dev') return 'dev';
  if (env.EDITMAMEI_INSTALL_CHANNEL === 'mcpb') return 'mcpb';
  return 'npm';
}
