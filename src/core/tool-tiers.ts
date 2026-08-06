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
 * Pro module when the license entitles it — the "free CE → buy → unlock" model
 * (`isToolAllowedInEdition`/EDITION gates the host's BUILT-IN tools, not a
 * downloaded module's). The build invariant is enforced by
 * `tests/integration/build-output.test.ts` (tree-wide assertion that no Pro
 * tool name appears as a string literal in CE dist).
 *
 * `'dev'` tools are included in local development runs (where
 * `EDITION === 'dev'`, the committed default in `src/edition.ts`) but
 * filtered out of BOTH CE and Pro shipped bundles by the runtime gate
 * in `isToolAllowedInEdition`. Unlike Pro, dev tools are NOT moved into
 * dedicated `*-dev.ts` files — their implementations DO compile into CE
 * dist and are gated only at registration time. Per `DISTRIBUTION_PLAN`
 * §2.13 this is accepted risk; the obfuscation layered defense is
 * deferred. The implication: a determined CE user can trivially re-enable
 * a dev tool by editing the runtime check, but a dev tool's identifier
 * strings appearing in CE dist are not an audit finding.
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
 * via MCP. Use this for tools we want kept around as reference but
 * shouldn't surface anywhere: known-broken pending fix, tools pending
 * removal in a deprecation window, platform-specific tools awaiting a
 * cross-platform port. The `ps_apply_adjustment` (type=color_lookup)
 * is the original motivating case.
 *
 * The classification is **explicit** — every registered tool MUST appear in
 * this table. `tierOf()` throws for unknown names and `EditmameiServer`
 * runs that check at startup so a newly-added tool that was never tiered
 * fails fast at boot rather than silently leaking into the wrong bundle.
 *
 * **Surface count (2026-06-16 tier rollout).** 12 Pro tools — the three
 * action / scripting tools (`ps_list_actions`, `ps_play_action`,
 * `ps_execute_script`), the Sensei-backed selection pair
 * (`ps_select_subject` + `ps_select_sky`), and the WHOLE
 * template surface (`ps_template_create_evidence` + `_save` + `_delete`
 * + `_list` + `_apply` + `_verify` + `_recall`). All live in `*-pro.ts` files.
 * This rollout PROMOTED the four layer-transform ops (fit/scale/move/rotate)
 * and the retouch trio (content_aware_fill/patch/content_aware_move) to
 * `'community'` — straightening + content-aware retouch are foundational photo
 * fixes that belong in CE — and DEMOTED list/apply/verify/recall to `'pro'`,
 * making templates a whole-feature Pro headliner. `ps_get_histogram`
 * stays `'community'`.
 *
 * **v0.22 tier promotions (2026-07-07, user-authorized).** dev→community:
 * `ps_shape`. dev→pro: `ps_apply_camera_raw`, `ps_warp_layer_along` / `_region`
 * / `_to`, `ps_resolve_placement`, `ps_select_object`, `ps_edit_object`,
 * `ps_add_text_to_object`. pro→community (the CE/Pro re-tier): `ps_select_subject` +
 * `ps_select_sky` — `ps_select_subject_instance` STAYS pro. Windows
 * live-verified; the macOS parity gate was overridden by the user.
 * `ps_resolve_placement`'s module-home follows WO-3 Option A (the locator moves
 * to the Pro module; the grounding engine stays CE-host-shipped). Dev-tier tools remaining:
 * `ps_apply_brush_stroke`, `ps_stroke_face_contour`, `ps_portrait_touchup`,
 * `ps_release_clipping_mask`.
 */

export type Tier = 'community' | 'pro' | 'none' | 'dev';

export const TOOL_TIERS: Record<string, Tier> = {
  // server.ts ambient tools
  ps_ping: 'community',
  // live capability-map meta-tool (host-level; ships in both editions)
  ps_list_capabilities: 'community',
  // diagnostic-bundle meta-tool (2026-06-27) — writes an anonymized logs+system
  // bundle to Downloads for bug reports. PS-independent, so "live verification"
  // is running it and confirming a valid sanitized bundle (not a real-PS edit);
  // ships in both editions so users on the .mcpb can self-serve a report.
  ps_report_problem: 'community',

  // action-tools
  ps_list_actions: 'pro',
  ps_play_action: 'pro',
  ps_execute_script: 'pro',

  // adjustment-tools — bakes consolidated into ps_apply_adjustment (Phase 1, 2026-06-20)
  ps_add_adjustment_layer: 'community',
  ps_apply_adjustment: 'community',

  // document-tools
  ps_create_document: 'community',
  ps_close_document: 'community',
  ps_open_document: 'community',
  ps_save_psd: 'community',
  // export_jpeg + export_png consolidated into ps_export (Phase 1, 2026-06-20)
  ps_export: 'community',

  // filter-tools — consolidated into one type-discriminated tool (Phase 1, 2026-06-20)
  ps_apply_filter: 'community',

  // group-tools
  ps_create_group: 'community',
  ps_move_layer_to_group: 'community',
  ps_set_group_blend_mode: 'community',
  ps_ungroup: 'community',
  ps_delete_group: 'community',
  ps_create_clipping_mask: 'community',
  ps_release_clipping_mask: 'dev',

  // history-tools (get_history → ps_inspect, Phase 1b 2026-06-26)
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

  // layer-properties-tools — set_* → ps_set_layer; merge_visible/stamp/flatten → ps_merge (Phase 1, 2026-06-20)
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
  ps_create_text_layer: 'community',
  ps_fill_layer: 'community',
  ps_add_fill_layer: 'community',
  // get_layer_tree → ps_inspect (Phase 1b, 2026-06-26)
  ps_select_layer: 'community',

  // layer-transform-tools — consolidated into one op-discriminated tool (Phase 1, 2026-06-20)
  ps_transform_layer: 'community',

  // M2 transform / warp / canvas / guides (2026-06-21) — raw-AM tools from the
  // M2 capture campaign, live-verified vs PS 27.2.0 then promoted 2026-06-21.
  // transform_layer also gained op=skew / op=free (matrix Trnf), which ride the
  // existing 'community' classification above. Canvas rotate/flip + guides are
  // foundational corrections → community. Warp is creative manipulation and its
  // future custom-mesh op is the Pro headliner (per-tool tiering means the whole
  // warp_layer tool is Pro) → pro (factory lives in warp-tools-pro.ts, registered
  // by the Pro module, stripped from the CE bundle).
  ps_warp_layer: 'pro',
  // Grounded custom-mesh warp (2026-06-24) — the deferred "Pro headliner" custom
  // mesh: pins one edge (welded by construction) while deforming the rest (rise /
  // ~90° bend / taper). PROMOTED to pro 2026-06-26 on the 2026-06-24 live
  // verification (pinned_edge_held=true, left edge held at x=983 while the far end
  // rose + bent); coordinate-grid aiming gate is met.
  ps_warp_layer_mesh: 'pro',
  // Grounded curve warp (2026-07-04, Phase 4 warp slice W1) — bend a layer to
  // FOLLOW a resolver-named curve (along edge / landmark / segment). Computes the
  // destination mesh in TS from the resolved path, feeds warpMesh RAW.
  // PROMOTED to pro 2026-07-07 (v0.22, user-authorized).
  ps_warp_layer_along: 'pro',
  // Grounded radial reshape (2026-07-04, Phase 4 warp slice W2) — bulge/pinch a
  // layer around a resolver-named point/region. TS radial field → warpMesh RAW.
  // PROMOTED to pro 2026-07-07 (v0.22, user-authorized).
  ps_warp_layer_region: 'pro',
  // Grounded edge-pinned warp toward a target (2026-07-04, Phase 4 warp slice W3) —
  // grounds ps_warp_layer_mesh's pin/lift path: name a target point, the far end
  // reaches it (lift computed in TS). PROMOTED to pro 2026-07-07 (v0.22, user-authorized).
  ps_warp_layer_to: 'pro',
  // Camera Raw Filter as a re-editable Smart Filter (2026-07-04, CRF Pro
  // headliner). Pro-gated go-core emitter (//go:build pro). PROMOTED to pro
  // 2026-07-07 (v0.22, user-authorized; macOS parity gate overridden by user).
  ps_apply_camera_raw: 'pro',
  ps_transform_canvas: 'community',
  ps_guides: 'community',

  // inspect-tools — ps_inspect(what) consolidates the read-only state
  // readers get_metadata / get_layer_tree / get_history / get_selection_info
  // (Phase 1b, 2026-06-26). The verification primitives (get_preview,
  // get_histogram, compare_regions, get_layer_bounds_diff, get_selection_preview)
  // stay separate, named community tools.
  ps_inspect: 'community',

  // overview-tools
  ps_overview: 'community',

  // preview-tools
  ps_get_preview: 'community',
  ps_get_layer_bounds_diff: 'community',
  ps_compare_regions: 'community',
  ps_get_histogram: 'community',

  // retouch-tools — consolidated into one method-discriminated tool (Phase 1, 2026-06-20)
  ps_retouch: 'community',

  // brush-tools
  ps_apply_brush_stroke: 'dev',

  // detection-tools — local-vision perception (on-device ONNX: Ultraface faces +
  // D-FINE-S COCO-80 objects). PROMOTED to community 2026-06-26 (the "huge CE win":
  // semantic scene awareness + real coordinates). The .mcpb wasm-prune gate
  // (pruneOnnxWasm in build-mcpb.ts) is cleared.
  ps_detect: 'community',

  // detection-driven orchestrations (box-only; precise cutout / landmarks = Pro).
  // ps_edit_object + ps_add_text_to_object PROMOTED to pro 2026-07-07 (v0.22,
  // user-authorized); factories moved to *-pro.ts. ps_portrait_touchup stays dev.
  ps_edit_object: 'pro',
  ps_portrait_touchup: 'dev',
  ps_add_text_to_object: 'pro',

  // Pro face-mesh perception (2026-06-25) — the MediaPipe FaceMesh model run via
  // ONNX on the headless onnxruntime-web seam (the MODEL, not the DOM-bound JS
  // Tasks runtime that runtime.ts rejected). Returns the 468-point mesh as
  // labelled groups/anchors/centres in document px. Pro-destined (precise
  // geometry → Pro). PROMOTED to pro
  // 2026-06-26 (L0 built + live-verified 2026-06-25 per pro-face-mesh.md). Its
  // weight ships in the downloaded Pro module (models/pro/, never staged into the
  // CE bundle by copyModels).
  ps_detect_landmarks: 'pro',

  // Pro face-FEATURE selection (2026-06-25, L2) — turns the mesh into a real,
  // loadable Photoshop selection of a named feature (eyes/teeth/skin/…). Saves
  // managed scene:face_* channels that ps_select_by_reference loads by
  // name, and precomputes the set for the scene region menu. Pro-destined
  // (mesh-backed). PROMOTED to pro 2026-06-26 (L2 built + live-verified 2026-06-25:
  // teeth/eyes land precisely, per pro-face-mesh.md). File pruned from CE (CE_PRUNE_PATHS).
  ps_select_face_feature: 'pro',

  // Pro face-CONTOUR stroke (2026-06-26, L2.1) — dodge/burn/brush along a named
  // face contour (jawline/cheekbones/nose-bridge/under-eye) following the mesh's
  // real geometry, via the existing applyBrushStroke snippet. The path side of
  // the landmark primitives. Pro-destined; lands 'dev', promotes to 'pro' after
  // live verification. File pruned from CE (CE_PRUNE_PATHS).
  ps_stroke_face_contour: 'dev',

  // Scene Model perception + select-by-reference — the Layer-1 perception read
  // (ps_read_scene) and the rectangle-reflex kill (ps_select_by_reference):
  // a named target → a real pixel selection. PROMOTED to community 2026-06-26 on the
  // v2.1 confidence-gated implementation (scene-model-v2.md, core BUILT + live-verified
  // 2026-06-23 over a 10-photo harness trial; loads saved scene:* channels by name).
  ps_read_scene: 'community',
  ps_select_by_reference: 'community',

  // selection-tools — consolidated (Phase 1, 2026-06-20): rectangle/color_range/luminance_range/
  // magic_wand/all/deselect/invert → ps_select; feather+refine_edge → modify_selection;
  // save/load channel → selection_channel; create/delete/apply mask → layer_mask. The AI
  // selectors stay Pro; the two read-only probes stay separate (inspect consolidation deferred).
  ps_select: 'community',
  // ps_select_subject + ps_select_sky RE-TIERED pro→community 2026-07-07 (v0.22;
  // the CE/Pro re-tier — CE = region/
  // subject scale, Pro = bespoke precision CV). go-core snippets migrated _pro →
  // community; factory moved selection-tools-pro.ts → selection-tools.ts.
  // ps_select_subject_instance STAYS pro.
  ps_select_subject: 'community',
  ps_select_sky: 'community',
  // CV-aimed Sensei (Part 1 of coordinate-and-path-synthesis, 2026-06-23):
  // local detection crops a copy to one instance so Select Subject targets it,
  // then the mask transfers back to the original. Uses Sensei; a -pro.ts file
  // registered by the Pro module. PROMOTED to pro 2026-06-26 (exercised via the
  // scene-model-v2 select_by_reference Pro path in the 10-photo trial).
  ps_select_subject_instance: 'pro',
  // Named-object selection via local MobileSAM (2026-07-04): COCO object
  // → CE detector box → SAM organic mask → selection. PROMOTED to pro 2026-07-07
  // (v0.22, user-authorized).
  ps_select_object: 'pro',
  ps_modify_selection: 'community',
  // get_selection_info → ps_inspect (Phase 1b, 2026-06-26)
  ps_get_selection_preview: 'community',
  ps_selection_channel: 'community',
  ps_layer_mask: 'community',

  // path-interchange + vector masks (2026-06-24) — primitive B of
  // coordinate-and-path-synthesis.md. ps_path is DOM-backed (makeWorkPath/
  // makeSelection/strokePath/fillPath/makeClippingPath); ps_vector_mask is
  // AM-only. The full surface was VERIFIED live against PS 27.2.0 on 2026-06-24
  // (path round-trip + vm add/delete/link/unlink); reveal_all/hide_all vm sources
  // failed live and were dropped. PROMOTED to community 2026-06-26 on that
  // 2026-06-24 live verification (the held-at-dev run was the promotion evidence).
  ps_path: 'community',
  ps_vector_mask: 'community',

  // channel-compose (m4a Tier-2, 2026-06-30) — ps_apply_image / ps_calculations
  // (AM Apply Image / Calculations). PROMOTED to community after live verification
  // vs real PS 27.2.0 (2026-06-30): both tools + all 12 Clcn blend charIDs +
  // rgb/single-channel/alpha/named-layer refs + auto-duplicate-first all pass.
  ps_apply_image: 'community',
  ps_calculations: 'community',

  // shape layers (m4a Tier-3, 2026-06-30) — ps_shape (vector rectangle/ellipse/line).
  // Historically HELD AT DEV pending reliable aiming; the grounded `placement` path
  // (spatial-grounding resolver) resolved that blocker. Built + live-verified vs PS
  // 27.2.0; PROMOTED to community 2026-07-07 (v0.22, user-authorized).
  ps_shape: 'community',

  // spatial-grounding locator (Phase 4, 2026-07-03) — ps_resolve_placement.
  // Read-only: NAME anchors + a relation → deterministic doc-pixel geometry +
  // objective gate + review crop. PROMOTED to pro 2026-07-07 (v0.22,
  // user-authorized) per WO-3 Option A: the locator TOOL moves to the Pro module
  // (grounding-tools-pro.ts); the grounding ENGINE stays CE-host-shipped.
  ps_resolve_placement: 'pro',

  // template-tools
  ps_template_create_evidence: 'pro',
  ps_template_save: 'pro',
  ps_template_list: 'pro',
  ps_template_apply: 'pro',
  ps_template_verify: 'pro',
  ps_template_recall: 'pro',
  ps_template_delete: 'pro',

  // text-tools — consolidated into one property-discriminated tool (Phase 1, 2026-06-20)
  ps_set_text: 'community',
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
 * them. We don't reject unclassified tools here because that would mask
 * the assertion's clearer error message.
 */
export function isToolAllowedInEdition(toolName: string, edition: Tier): boolean {
  const tier = TOOL_TIERS[toolName];
  if (tier === 'none') return false;
  if (tier === 'dev') return edition === 'dev';
  if (edition === 'community') return tier !== 'pro';
  // edition is 'pro' or 'dev' → community + pro tools both pass.
  return true;
}
