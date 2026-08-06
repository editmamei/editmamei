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
 * Also runs `npm pack` to produce a `.tgz` next to the `dist/` tree. CE
 * doesn't strictly need a local tarball for the publish flow (npm runs
 * pack server-side at publish time), but having one in place is useful
 * for local-install testing (e.g. `npm install -g packages/ce/*.tgz` to
 * exercise the same artifact users will pull from the registry, or the
 * `pack:icloud` flow which copies both edition tarballs to a sync target
 * for Mac testing).
 *
 * Per DISTRIBUTION_PLAN.md §2.13, minification + property mangling will
 * land as a layered defense in a follow-up — this script intentionally
 * produces a vanilla tsc output for now so the gate is easy to verify.
 */

import { runBuild, packPackage, appendTarballToChecksums } from './lib/build-common.js';

async function main(): Promise<void> {
  await runBuild('community', 'build-ce');
  const tarballName = packPackage('community');
  appendTarballToChecksums('community', tarballName);
  console.error(`[build-ce] packed → ${tarballName}`);
}

main().catch((err) => {
  console.error(`[build-ce] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
