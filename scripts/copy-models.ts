/*
 * Stages the local-vision ONNX models into dist/models/ for dev builds.
 *
 * Runs after tsc via the postbuild hook (alongside build-go-core-dev.ts). The
 * detection runtime resolves models via resolveModelPath() →
 * `<dist>/models/<file>`; this writes exactly there so `node dist/index.js`
 * finds them. Release builds (build-ce.ts / build-pro.ts) call copyModels()
 * directly inside runBuild(). No-op (count 0) when models/ is absent — a
 * test-only checkout without the weights still builds.
 */

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { copyModels, copyProModels, REPO_ROOT } from './lib/build-common.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dist = join(REPO_ROOT, 'dist');
  const count = copyModels(dist);
  // Dev runs (EDITION='dev') see Pro tools, so stage the Pro weights too. CE
  // release builds never call this — copyProModels is excluded from the CE path.
  const proCount = copyProModels(dist);
  console.error(
    `[copy-models] copied ${count} detection model(s) → dist/models/` +
      (proCount ? ` (+${proCount} pro model(s) → dist/models/pro/)` : '')
  );
}
