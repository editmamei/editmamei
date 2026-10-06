/**
 * The GIMP module — the second-editor beta tool set. Registers `gimp_*`
 * tools when a GIMP install was detected (or the `editor` pin forced it) at
 * boot; see `src/backends/detect-editors.ts` (`resolveEditorRegistration`)
 * for the matrix and `src/core/server.ts` for where the decision is applied.
 *
 * Mirrors `ceModule`'s shape (manifest + `register(host)`), but every
 * `gimp_*` tool factory takes a `GimpBackend` instead of
 * `(connection, snippetClient)` — there is no go-core snippet layer on this
 * side, `GimpBackend.call(op, args)` IS the dispatch primitive.
 */

import { KERNEL_ABI, type EditmameiModule, type HostApi } from '../../kernel/host-api.js';
import { EDITION } from '../../edition.js';
import { isToolAllowedInEdition } from '../../core/tool-tiers.js';

import { createGimpCoreTools } from '../../tools/gimp-core-tools.js';
import { createGimpDocumentTools } from '../../tools/gimp-document-tools.js';
import { createGimpInspectTools } from '../../tools/gimp-inspect-tools.js';
import { createGimpAdjustmentTools } from '../../tools/gimp-adjustment-tools.js';
import { createGimpEffectTools } from '../../tools/gimp-effect-tools.js';
import { createGimpFilterTools } from '../../tools/gimp-filter-tools.js';
import { createGimpGeometryTools } from '../../tools/gimp-geometry-tools.js';
import { createGimpVerifyTools } from '../../tools/gimp-verify-tools.js';
import { createGimpCheckpointTools } from '../../tools/gimp-checkpoint-tools.js';
import { createGimpLayerTools } from '../../tools/gimp-layer-tools.js';
import { createGimpTransformLayerTools } from '../../tools/gimp-transform-layer-tools.js';
import { createGimpComposeTools } from '../../tools/gimp-compose-tools.js';
import { createGimpTextTools } from '../../tools/gimp-text-tools.js';
import { createGimpSelectionTools } from '../../tools/gimp-selection-tools.js';

// gimp_* tool factories; each takes (gimp: GimpBackend). Exported so tests
// (the leak-guard / factory-wiring derivations, mirroring `ceFactories`) can
// enumerate every gimp_* tool description without a hand-copied list.
export const gimpFactories = [
  createGimpCoreTools,
  createGimpDocumentTools,
  createGimpInspectTools,
  createGimpAdjustmentTools,
  createGimpEffectTools,
  createGimpFilterTools,
  createGimpGeometryTools,
  createGimpVerifyTools,
  createGimpCheckpointTools,
  createGimpLayerTools,
  createGimpTransformLayerTools,
  createGimpComposeTools,
  createGimpTextTools,
  createGimpSelectionTools,
];

export const gimpModule: EditmameiModule = {
  manifest: { id: 'gimp', name: 'Editmamei GIMP Tools', abi: KERNEL_ABI },

  register(host: HostApi): void {
    if (!host.gimp) {
      // Belt-and-braces: the server only loads this module when the boot
      // matrix decided to register the GIMP surface, which always hands a
      // `GimpBackend` (see server.ts). A host that somehow loads this module
      // without one logs and no-ops rather than registering tools with
      // nothing behind them.
      host.logger.warn('gimpModule.register called with no host.gimp backend — skipping.');
      return;
    }
    const gimp = host.gimp;
    const defs = gimpFactories
      .flatMap((f) => f(gimp))
      .filter((def) => isToolAllowedInEdition(def.tool.name, EDITION));
    host.registerTools(defs);
  },
};
