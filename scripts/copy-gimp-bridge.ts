/*
 * Stages the GIMP bridge's Python source into dist/backends/gimp/bridge/ —
 * `tsc` only compiles .ts, so the .py files it never touches have to be
 * copied by hand, the same way copy-models.ts stages the ONNX weights.
 *
 * `session.ts`'s `resolveOpsPyPath()` resolves `ops.py` relative to its own
 * compiled module directory (`dist/backends/gimp/` at runtime), so this MUST
 * land the files at that exact offset. `test_lib.py` is deliberately NOT
 * staged: it only runs via `python -m unittest` against the committed
 * source, never against a shipped install.
 *
 * Runs after tsc via the postbuild hook (alongside build-go-core-dev.ts and
 * copy-models.ts). Release builds (build-ce.ts / build-pro.ts) call
 * copyGimpBridge() directly inside runBuild(), before checksums are written.
 */

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { copyGimpBridge, REPO_ROOT } from './lib/build-common.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dist = join(REPO_ROOT, 'dist');
  const count = copyGimpBridge(dist);
  console.error(`[copy-gimp-bridge] copied ${count} bridge file(s) → dist/backends/gimp/bridge/`);
}
