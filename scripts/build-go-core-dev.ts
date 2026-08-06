/*
 * Builds the editmamei-core Go binary for the HOST platform into dist/bin/.
 *
 * Runs after tsc via the postbuild hook in package.json (alongside
 * build-skill-zip.ts) so every dev build (`npm run build`) produces the
 * binary the live MCP server spawns. The server's `node dist/index.js`
 * resolves the core binary via resolveCoreBinaryPath() →
 * `<dist>/bin/<coreBinaryName()>`; this writes exactly there.
 *
 * Host-only and non-fatal on a missing Go toolchain (warns) — see
 * buildGoCoreDev() in lib/build-common.ts for the rationale. The release
 * builds (build-ce.ts / build-pro.ts) cross-compile all targets and are
 * fail-loud; they don't go through this script.
 */

import { pathToFileURL } from 'node:url';
import { buildGoCoreDev } from './lib/build-common.js';

// Run when invoked directly (postbuild hook), not when imported by a test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { built, proBuilt, hostBinaryPath, proBinaryPath } = buildGoCoreDev();
  if (built) {
    console.error(`[build-go-core-dev] built CE host core binary → ${hostBinaryPath}`);
    if (proBuilt) {
      console.error(`[build-go-core-dev] built Pro-only core binary → ${proBinaryPath}`);
    }
  }
  // When not built, buildGoCoreDev() has already emitted its loud warning;
  // exit 0 so the dev build / npm install still succeeds.
}
