/**
 * The CE (Community) module — the free, built-in tool set that ships inside the
 * host package and loads locally.
 *
 * Holds only community-tier tool factories. The dev/community/pro edition filter
 * is retained as defense-in-depth: a dev-tier tool that slipped into a CE factory
 * is dropped from shipped (community/pro) bundles, while a dev build still sees it.
 * No license gate here — community tools are always available.
 */

import { KERNEL_ABI, type EditmameiModule, type HostApi } from '../../kernel/host-api.js';
import { EDITION } from '../../edition.js';
import { isToolAllowedInEdition } from '../../core/tool-tiers.js';

import { createDocumentTools } from '../../tools/document-tools.js';
import { createLayerTools } from '../../tools/layer-tools.js';
import { createGroupTools } from '../../tools/group-tools.js';
import { createImageTools } from '../../tools/image-tools.js';
import { createImagePlacementTools } from '../../tools/image-placement-tools.js';
import { createLayerPropertiesTools } from '../../tools/layer-properties-tools.js';
import { createLayerTransformTools } from '../../tools/layer-transform-tools.js';
import { createFilterTools } from '../../tools/filter-tools.js';
import { createAdjustmentTools } from '../../tools/adjustment-tools.js';
import { createTextTools } from '../../tools/text-tools.js';
import { createSelectionTools } from '../../tools/selection-tools.js';
import { createHistoryTools } from '../../tools/history-tools.js';
import { createLayerOrderingTools } from '../../tools/layer-ordering-tools.js';
import { createPreviewTools } from '../../tools/preview-tools.js';
import { createInspectTools } from '../../tools/inspect-tools.js';
import { createOverviewTools } from '../../tools/overview-tools.js';
import { createDiagnosticsTools } from '../../tools/diagnostics-tools.js';
import { createRetouchTools } from '../../tools/retouch-tools.js';
import { createBrushTools } from '../../tools/brush-tools.js';
import { createTransformCanvasTools } from '../../tools/transform-canvas-tools.js';
import { createGuideTools } from '../../tools/guide-tools.js';
import { createDetectionTools } from '../../tools/detection-tools.js';
import { createPortraitTools } from '../../tools/portrait-tools.js';
import { createSceneTools } from '../../tools/scene-tools.js';
import { createPathTools } from '../../tools/path-tools.js';
import { createVectorMaskTools } from '../../tools/vector-mask-tools.js';
import { createChannelComposeTools } from '../../tools/channel-compose-tools.js';
import { createShapeTools } from '../../tools/shape-tools.js';

// CE-tier factories; each takes (connection, snippetClient).
const ceFactories = [
  createDocumentTools,
  createLayerTools,
  createGroupTools,
  createImageTools,
  createImagePlacementTools,
  createLayerPropertiesTools,
  createLayerTransformTools,
  createFilterTools,
  createAdjustmentTools,
  createTextTools,
  createSelectionTools,
  createHistoryTools,
  createLayerOrderingTools,
  createPreviewTools,
  // ps_inspect (Phase 1b, 2026-06-26) consolidates the read-only state
  // readers (get_metadata/get_layer_tree/get_history/get_selection_info). The
  // verification primitives (get_preview/get_histogram/compare_regions/
  // get_layer_bounds_diff/get_selection_preview) stay separate, named tools.
  createInspectTools,
  createOverviewTools,
  // ps_report_problem (2026-06-27) — writes an anonymized diagnostic
  // bundle to Downloads for bug reports. Meta tool; does not touch Photoshop.
  createDiagnosticsTools,
  createRetouchTools,
  createBrushTools,
  // M2 (2026-06-21) — community-tier canvas + guide tools (warp_layer is Pro,
  // registered by the Pro module). transform_layer's op=skew/op=free ride the
  // existing createLayerTransformTools above.
  createTransformCanvasTools,
  createGuideTools,
  // Local-vision perception (2026-06-22) — ps_detect (faces + COCO-80
  // objects via on-device ONNX). Starts dev-tier; promotes to community after
  // live verification.
  createDetectionTools,
  // Detection-driven orchestration (2026-06-22) — ps_portrait_touchup (dodge_face /
  // soften_skin). Dev-tier until live-verified. (ps_edit_object + ps_add_text_to_object
  // PROMOTED to pro 2026-07-07 → now registered by the Pro module.)
  createPortraitTools,
  // Path-interchange surface + vector masks (2026-06-24) — ps_path
  // (selection↔path round-trip + stroke/fill/clip) and ps_vector_mask
  // (path → vector mask). Primitive B of coordinate-and-path-synthesis.md.
  // Dev-tier until live-verified (vector-mask AM descriptors are unverified).
  createPathTools,
  createVectorMaskTools,
  // Channel-compose (m4a Tier-2, 2026-06-30) — ps_apply_image + ps_calculations
  // (AM Apply Image / Calculations; channel math for blends + advanced masks).
  // Dev-tier until live-verified, then promoted to community.
  createChannelComposeTools,
  // Shape layers (m4a Tier-3, 2026-06-30) — ps_shape (vector rectangle/ellipse/line,
  // coordinate-baking). HELD AT DEV: the coordinate-aiming primitive (grid preview)
  // is still weak, so an un-aimable shape tool stays out of the shipped surface until
  // the coordinate-identification redesign lands.
  createShapeTools,
  // ps_resolve_placement (the spatial-grounding locator) PROMOTED to pro 2026-07-07
  // → registered by the Pro module now (WO-3 Option A). The grounding ENGINE
  // (src/perception/grounding-*) stays CE-host-shipped: the community tools above
  // import it directly for their placement params. See wo3-grounding-tier-decision.md.
  // NOTE: createSceneTools is registered separately in register() below — it needs
  // host.invokeTool (the cross-module broker) to reach the Pro select_subject_instance
  // refine, which the generic (connection, snippet) factory call can't supply.
];

export const ceModule: EditmameiModule = {
  manifest: { id: 'ce', name: 'Editmamei Community Tools', abi: KERNEL_ABI },

  register(host: HostApi): void {
    const { connection, snippet } = host;
    const defs = [
      ...ceFactories.flatMap((f) => f(connection, snippet)),
      // Scene Model v1 (2026-06-23) — ps_read_scene (perception read) +
      // ps_select_by_reference (named region → real pixel selection; the
      // rectangle-reflex kill). Reuses the detection decode + CE-native recipes.
      // Passed host.invokeTool so subject can refine through the Pro
      // select_subject_instance (Sensei) when entitled, else CE fallback.
      // Dev-tier until live-verified.
      ...createSceneTools(connection, snippet, { invokeTool: host.invokeTool }),
    ].filter((def) => isToolAllowedInEdition(def.tool.name, EDITION));
    host.registerTools(defs);
  },
};
