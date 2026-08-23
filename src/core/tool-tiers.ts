/**
 * Single source of truth for which edition each registered tool belongs to.
 *
 * `'community'` tools ship in both the CE and Pro builds.
 *
 * `'pro'` tools live in `src/tools/*-pro.ts` files, registered by the
 * downloaded Pro module (`src/modules/pro/`). The CE build's `pruneProFromCE`
 * in `scripts/lib/build-common.ts` DELETES the compiled Pro module + Pro tool
 * files from `packages/ce/dist` after tsc, so the Pro implementation never
 * reaches the CE tarball. The defense-in-depth layers: `pruneProFromCE` deletes
 * the Pro code from CE dist; the delivery worker serves the encrypted module
 * only to an entitled license; and the host loads a downloaded module only after
 * `isProEntitled()` (`resolveProModule`). NOTE: a CE host DOES load the downloaded
 * Pro module when the license entitles it — `isToolAllowedInEdition`/EDITION gates
 * the host's BUILT-IN tools, not a downloaded module's. The build invariant is
 * enforced by `tests/integration/build-output.test.ts` (tree-wide assertion that
 * no Pro tool name appears as a string literal in CE dist).
 *
 * `'dev'` tools are included in local development runs (where
 * `EDITION === 'dev'`, the committed default in `src/edition.ts`) but
 * filtered out of BOTH CE and Pro shipped bundles by the runtime gate
 * in `isToolAllowedInEdition`. Unlike Pro, dev tools are NOT moved into
 * dedicated `*-dev.ts` files — their implementations compile into CE
 * dist and are gated at registration time only, so a dev tool's
 * identifier strings may appear in a shipped bundle.
 * **This is where every new tool starts.** New tools default to `'dev'`
 * until they have documented evidence of working end-to-end against a
 * live Photoshop; once verified, promote to `'community'` (or `'pro'`)
 * in the same commit as the verification record. The dev-default-then-
 * promote workflow guarantees an untested tool can never accidentally
 * land in a shipped package.
 *
 * `'none'` tools are excluded from EVERY edition including dev — the
 * definition + handler stay in source (compiled, tested, lintable) but
 * `isToolAllowedInEdition` filters them out so they're never exposed
 * via MCP. Use this for tools that should be kept as reference but
 * shouldn't surface anywhere: known-broken pending fix, tools pending
 * removal in a deprecation window, platform-specific tools awaiting a
 * cross-platform port.
 *
 * The classification is **explicit** — every registered tool MUST appear in
 * this table. `tierOf()` throws for unknown names and `EditmameiServer`
 * runs that check at startup so a newly-added tool that was never tiered
 * fails fast at boot rather than silently leaking into the wrong bundle.
 */

export type Tier = 'community' | 'pro' | 'none' | 'dev';

export const TOOL_TIERS: Record<string, Tier> = {
  // server.ts ambient tools
  ps_ping: 'community',
  // live capability-map meta-tool (host-level; ships in both editions)
  ps_list_capabilities: 'community',
  // diagnostic-bundle meta-tool — writes an anonymized logs+system bundle to
  // Downloads for bug reports. Ships in both editions so users on the .mcpb
  // can self-serve a report.
  ps_report_problem: 'community',

  // action-tools
  ps_list_actions: 'pro',
  ps_play_action: 'pro',
  ps_execute_script: 'pro',

  // batch-tools — runs a recipe over many files as ONE Photoshop batch rather
  // than a round trip per file, so the per-call overhead is paid once for the
  // whole set. Factory lives in batch-tools-pro.ts, registered by the Pro
  // module, stripped from CE.
  ps_batch: 'pro',

  // adjustment-tools — bakes consolidated into ps_apply_adjustment
  ps_add_adjustment_layer: 'community',
  ps_apply_adjustment: 'community',

  // document-tools
  ps_create_document: 'community',
  ps_close_document: 'community',
  ps_open_document: 'community',
  ps_save_psd: 'community',
  // export_jpeg + export_png consolidated into ps_export
  ps_export: 'community',

  // filter-tools — one op-discriminated tool: apply (type-discriminated) plus
  // the Smart Filter management ops.
  ps_filter: 'community',

  // group-tools — one op-discriminated tool covering group lifecycle and
  // membership.
  ps_group: 'community',
  ps_clipping_mask: 'community',

  // history-tools (get_history → ps_inspect)
  ps_undo: 'community',
  ps_redo: 'community',

  // image-placement-tools
  ps_place_image: 'community',

  // image-tools
  ps_resize_image: 'community',
  ps_crop_document: 'community',
  ps_convert_image_mode: 'community',

  // layer-ordering-tools
  ps_move_layer_to_position: 'community',

  // layer-properties-tools — set_* → ps_set_layer; merge_visible/stamp/flatten → ps_merge
  ps_convert_to_smart_object: 'community',
  ps_rasterize_layer: 'community',
  ps_set_layer: 'community',
  ps_duplicate_layer: 'community',
  ps_copy_to_new_layer: 'community',
  ps_merge: 'community',
  ps_bake_layer: 'community',
  ps_add_layer_style: 'community',

  // layer-tools
  ps_create_layer: 'community',
  ps_delete_layer: 'community',
  ps_fill_layer: 'community',
  ps_add_fill_layer: 'community',
  // get_layer_tree → ps_inspect
  ps_select_layer: 'community',

  // layer-transform-tools — consolidated into one op-discriminated tool
  ps_transform_layer: 'community',

  // transform / warp / canvas / guides — raw-AM tools. transform_layer also
  // covers op=skew / op=free (matrix Trnf), which ride the existing 'community'
  // classification above. Canvas rotate/flip + guides are foundational
  // corrections → community. Warp is creative manipulation → pro (factory lives
  // in warp-tools-pro.ts, registered by the Pro module, stripped from CE).
  ps_warp_layer: 'pro',
  // The four grounded warp variants below are no longer registered by the
  // current module, but their rows must stay for one more release. The module
  // is downloaded and a newly fetched one only takes effect on the NEXT boot,
  // so a host on this version can meet a previously-installed module that
  // still registers all four. `tierOf`/`groupOf` throw on an unknown name and
  // `assertToolsClassified()` runs them at startup, so a missing row is a
  // fatal boot failure, not a missing tool. Delete these rows, their
  // `tool-groups.ts` counterparts, and the matching allowance in
  // `tests/integration/tool-tiers.test.ts` together, once no supported module
  // registers them.
  //
  // Grounded custom-mesh warp — pins one edge (welded by construction) while
  // deforming the rest (rise / ~90° bend / taper).
  ps_warp_layer_mesh: 'pro',
  // Grounded curve warp — bend a layer to FOLLOW a resolver-named curve (along
  // edge / landmark / segment). Computes the destination mesh in TS from the
  // resolved path, feeds warpMesh RAW.
  ps_warp_layer_along: 'pro',
  // Grounded radial reshape — bulge/pinch a layer around a resolver-named
  // point/region. TS radial field → warpMesh RAW.
  ps_warp_layer_region: 'pro',
  // Grounded edge-pinned warp toward a target — grounds ps_warp_layer_mesh's
  // pin/lift path: name a target point, the far end reaches it (lift computed
  // in TS).
  ps_warp_layer_to: 'pro',
  // Camera Raw Filter as a re-editable Smart Filter. Pro-gated go-core emitter
  // (//go:build pro).
  ps_apply_camera_raw: 'pro',
  ps_transform_canvas: 'community',
  ps_guides: 'community',

  // inspect-tools — ps_inspect(what) consolidates the read-only state
  // readers get_metadata / get_layer_tree / get_history / get_selection_info.
  // The verification primitives (get_preview, get_histogram, compare_regions,
  // get_layer_bounds_diff, get_selection_preview) stay separate, named
  // community tools.
  ps_inspect: 'community',

  // overview-tools
  ps_overview: 'community',

  // preview-tools
  ps_get_preview: 'community',
  ps_get_layer_bounds_diff: 'community',
  ps_compare_regions: 'community',
  ps_get_histogram: 'community',

  // retouch-tools — consolidated into one method-discriminated tool
  ps_retouch: 'community',

  // brush-tools
  ps_apply_brush_stroke: 'dev',

  // detection-tools — local-vision perception (on-device ONNX: Ultraface faces +
  // D-FINE-S COCO-80 objects): semantic scene awareness + real coordinates.
  ps_detect: 'community',

  // detection-driven orchestrations (box-only; precise cutout / landmarks = Pro).
  ps_edit_object: 'pro',
  ps_portrait_touchup: 'dev',
  ps_add_text_to_object: 'pro',

  // Face-mesh perception — the MediaPipe FaceMesh model run via ONNX on the
  // headless onnxruntime-web seam (the MODEL, not the DOM-bound JS Tasks runtime
  // that runtime.ts rejects). Returns the 468-point mesh as labelled
  // groups/anchors/centres in document px. Its weight ships in the downloaded
  // Pro module (models/pro/, never staged into the CE bundle by copyModels).
  ps_detect_landmarks: 'pro',

  // Face-FEATURE selection — turns the mesh into a real, loadable Photoshop
  // selection of a named feature (eyes/teeth/skin/…). Saves managed
  // scene:face_* channels that ps_select_by_reference loads by name, and
  // precomputes the set for the scene region menu. File pruned from CE
  // (CE_PRUNE_PATHS).
  ps_select_face_feature: 'pro',

  // Face-CONTOUR stroke — dodge/burn/brush along a named face contour
  // (jawline/cheekbones/nose-bridge/under-eye) following the mesh's real
  // geometry, via the existing applyBrushStroke snippet. The path side of the
  // landmark primitives. File pruned from CE (CE_PRUNE_PATHS).
  ps_stroke_face_contour: 'dev',

  // Scene Model perception + select-by-reference — the Layer-1 perception read
  // (ps_read_scene) and the rectangle-reflex kill (ps_select_by_reference):
  // a named target → a real pixel selection. Confidence-gated; loads saved
  // scene:* channels by name.
  ps_read_scene: 'community',
  ps_select_by_reference: 'community',

  // selection-tools — consolidated: rectangle/color_range/luminance_range/
  // magic_wand/all/deselect/invert → ps_select; feather+refine_edge →
  // modify_selection; save/load channel → selection_channel; create/delete/apply
  // mask → layer_mask. The two read-only probes stay separate.
  ps_select: 'community',
  // CE covers region/subject scale; Pro covers bespoke precision CV.
  ps_select_subject: 'community',
  ps_select_sky: 'community',
  // CV-aimed Sensei: local detection crops a copy to one instance so Select
  // Subject targets it, then the mask transfers back to the original. Uses
  // Sensei; a -pro.ts file registered by the Pro module.
  ps_select_subject_instance: 'pro',
  // Named-object selection via local MobileSAM: COCO object → CE detector box →
  // SAM organic mask → selection.
  ps_select_object: 'pro',
  // Native-AI additions (2026-08-15). Both are Adobe's own inference, so both
  // are CE-destined on the usual line — but they ship at 'dev' until the user
  // promotes. ps_select_focus_area is standalone only because a parameter
  // cannot be tiered; it folds into ps_select as mode=focus_area at promotion.
  //
  // The point-prompt selector (AM deepSelect) is deliberately ABSENT: its only
  // input is a coordinate and we have no precision aiming to give it in any
  // tier, so it stays unbuilt until the coordinate-ID work lands.
  ps_select_focus_area: 'dev',
  ps_replace_sky: 'dev',
  ps_modify_selection: 'community',
  // get_selection_info → ps_inspect
  ps_get_selection_preview: 'community',
  ps_selection_channel: 'community',
  ps_layer_mask: 'community',

  // path-interchange + vector masks. ps_path is DOM-backed (makeWorkPath/
  // makeSelection/strokePath/fillPath/makeClippingPath); ps_vector_mask is
  // AM-only. reveal_all/hide_all vector-mask sources are not supported.
  ps_path: 'community',
  ps_vector_mask: 'community',

  // channel-compose — ps_apply_image / ps_calculations (AM Apply Image /
  // Calculations): channel math for blends + advanced masks.
  ps_apply_image: 'community',
  ps_calculations: 'community',

  // shape layers — ps_shape (vector rectangle/ellipse/line). Aiming goes through
  // the grounded `placement` path (spatial-grounding resolver).
  ps_shape: 'community',

  // spatial-grounding locator — ps_resolve_placement. Read-only: NAME anchors +
  // a relation → deterministic doc-pixel geometry + objective gate + review
  // crop. The locator TOOL lives in the Pro module (grounding-tools-pro.ts); the
  // grounding ENGINE stays CE-host-shipped.
  ps_resolve_placement: 'pro',

  // template-tools
  ps_template_create_evidence: 'pro',
  ps_template_save: 'pro',
  ps_template_list: 'pro',
  ps_template_apply: 'pro',
  ps_template_verify: 'pro',
  ps_template_recall: 'pro',
  ps_template_delete: 'pro',

  // text-tools — one op-discriminated tool covering both creating a text layer
  // and styling one, in a single flat op enum.
  ps_text: 'community',
};

/**
 * Throws if the name is not classified. Used at server boot to refuse
 * to start with an unclassified tool registered.
 */
export function tierOf(toolName: string): Tier {
  const tier = TOOL_TIERS[toolName];
  if (!tier) {
    throw new Error(
      `Tool '${toolName}' has no entry in src/core/tool-tiers.ts. ` +
        `Every registered tool must be explicitly classified as one of ` +
        `'community', 'pro', 'dev', or 'none'.`
    );
  }
  return tier;
}

/** All tool names belonging to a given tier. Used by build scripts. */
export function toolsInTier(tier: Tier): string[] {
  return Object.entries(TOOL_TIERS)
    .filter(([, t]) => t === tier)
    .map(([name]) => name);
}

/**
 * Returns true if a tool with the given name should be registered in a
 * build of the given edition.
 *
 *   tier 'none' → excluded from EVERY edition (including dev)
 *   tier 'dev'  → only registered when edition === 'dev' (local
 *                 development runs); excluded from shipped CE / Pro
 *   tier 'pro'  → registered in 'dev' and 'pro'; excluded from 'community'
 *   tier 'community' → registered in every edition
 *
 * The 'dev' edition (the committed default in `src/edition.ts`) is what
 * local development runs see. Build scripts overwrite EDITION to
 * 'community' or 'pro' before tsc runs so shipped bundles never include
 * 'dev'-tier tools. This is the load-bearing guarantee for the
 * "new tools default to 'dev'" workflow.
 *
 * Unclassified tools (not in `TOOL_TIERS`) pass through here — they get
 * registered and then the startup assertion in `EditmameiServer` catches
 * them. Rejecting unclassified tools here would mask the assertion's
 * clearer error message.
 */
export function isToolAllowedInEdition(toolName: string, edition: Tier): boolean {
  const tier = TOOL_TIERS[toolName];
  if (tier === 'none') return false;
  if (tier === 'dev') return edition === 'dev';
  if (edition === 'community') return tier !== 'pro';
  // edition is 'pro' or 'dev' → community + pro tools both pass.
  return true;
}
