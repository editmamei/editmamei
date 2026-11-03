/**
 * Builds the Editmamei Community Edition bundle.
 *
 * Reads `src/core/tool-tiers.ts` as the single source of truth, patches
 * `src/edition.ts` to `'community'`, runs `tsc`, and writes the artifact
 * to `packages/ce/`. The Pro module (`src/modules/pro/` + `src/tools/*-pro.ts`)
 * is a downloaded module loaded via dynamic import — never statically linked —
 * so after compile `pruneProFromCE` in `lib/build-common.ts` deletes the orphan
 * Pro `dist/` files so the Pro implementation never ships in the CE tarball. A
 * CE build (`EDITION='community'`) also skips `loadModules()` at runtime, so the
 * pruned dynamic import is never reached.
 *
 * Installs the production dependencies into `packages/ce/node_modules/` from
 * the root lockfile; the published manifest lists them in `bundleDependencies`,
 * so the tarball carries the exact tree the release gate tested.
 *
 * Also runs `npm pack` to produce a `.tgz` next to the `dist/` tree. CE
 * doesn't strictly need a local tarball for the publish flow (npm runs
 * pack server-side at publish time), but having one in place is useful
 * for local-install testing (e.g. `npm install -g packages/ce/*.tgz` to
 * exercise the same artifact users will pull from the registry).
 *
 * Minification + property mangling may land as a layered defense in a
 * follow-up — this script intentionally produces a vanilla tsc output for
 * now so the gate is easy to verify.
 */

import {
  runBuild,
  installBundledDependencies,
  packPackage,
  appendTarballToChecksums,
} from './lib/build-common.js';

async function main(): Promise<void> {
  await runBuild('community', 'build-ce');
  // The tarball ships its tested dependency tree (bundleDependencies), so the
  // install happens here, against the root lockfile, rather than on the user's machine.
  installBundledDependencies('community', 'build-ce');
  const tarballName = packPackage('community');
  appendTarballToChecksums('community', tarballName);
  console.error(`[build-ce] packed → ${tarballName}`);
}

main().catch((err) => {
  console.error(`[build-ce] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
