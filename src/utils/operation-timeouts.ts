/**
 * Centralized per-operation timeout budgets (ms) — the third argument
 * `timeoutMs` handlers pass through `runScript()` to override the platform
 * runner's default (`windows-runner.ts` / `macos-runner.ts` `run()`).
 *
 * Two layers live in this file. The overrides below predate the second layer
 * and are a handler's own explicit choice, passed at its own `runScript`
 * call sites. `getToolTimeoutMs()` at the bottom is the newer, coarser layer:
 * one budget per MCP tool, applied once at dispatch (`ToolRegistry.execute`)
 * so every script a handler runs during that call inherits it unless the
 * call site overrides it directly — an explicit override here still wins.
 *
 * Most tools never approach 30s. A handful of Photoshop operations
 * routinely do on real-world input — most notably a large RAW file's first
 * Camera Raw engine init on `ps_open_document`, which was previously cut off
 * at 30s and reported as a failure even when Photoshop went on to finish the
 * open (see the Phase 3 timeout-honesty fix, `run-child.ts` /
 * `document-tools.ts`). Centralizing the budgets here instead of scattering
 * more bare numeric literals across handlers — the three that predate this
 * module (`ps_select_subject` / `ps_select_sky` / annotated `ps_get_preview`)
 * were already inline literals; they're migrated in alongside the two this
 * fix adds (`ps_open_document`, `ps_apply_camera_raw`).
 *
 * Raising a budget is a real tradeoff, not a free fix: a genuine hang now
 * takes longer to surface as an error. `ps_open_document` pairs its budget
 * with a post-timeout re-probe (`document-tools.ts`'s `reprobeOpenDocument`)
 * for exactly this reason — the probe only benefits the legitimately-slow
 * case; a genuine hang still surfaces via the original timeout path once the
 * probe also finds nothing.
 */

/**
 * Wall-clock budget for a single script when no per-tool budget below
 * applies and the handler didn't override it directly. Both platform
 * runners used to each declare their own private copy of this constant;
 * centralizing it here is what lets `getToolTimeoutMs()` reason about "the
 * tool's budget, or this fallback" in one place.
 */
export const DEFAULT_SCRIPT_TIMEOUT_MS = 30_000;

/** No per-tool budget in the table below goes under this, however fast the tool measures. */
export const SCRIPT_TIMEOUT_FLOOR_MS = 5_000;

/** `ps_open_document` — large RAW files can exceed 30s on first ACR engine init. */
export const OPEN_DOCUMENT_TIMEOUT_MS = 120_000;

/**
 * Bounded budget for the post-timeout success re-probe (3b) — deliberately
 * short. It only needs to walk `app.documents`, not wait on Photoshop; a
 * probe that itself times out means PS is still busy and we fall back to the
 * original timeout error rather than waiting indefinitely.
 */
export const OPEN_DOCUMENT_REPROBE_TIMEOUT_MS = 10_000;

/** `ps_apply_camera_raw` — the Pro Camera Raw Filter headliner; structurally
 * exposed to the same first-engine-init cliff as ps_open_document. */
export const CAMERA_RAW_FILTER_TIMEOUT_MS = 120_000;

/** `ps_select_subject` (Adobe Sensei) — pre-existing inline literal, centralized. */
export const SELECT_SUBJECT_TIMEOUT_MS = 120_000;

/** `ps_select_sky` (Adobe Sensei) — pre-existing inline literal, centralized. */
export const SELECT_SKY_TIMEOUT_MS = 120_000;

/**
 * `ps_select` mode=focus_area (Focus Area). Measured 3.4s on a 4000x6000 frame,
 * 2026-08-15; the ceiling matches the other native-AI selections because the
 * first call in a session pays a one-off model load.
 */
export const SELECT_FOCUS_AREA_TIMEOUT_MS = 120_000;

/**
 * `ps_replace_sky` (Sky Replacement). Measured 7.5s on a 3789x2682 frame,
 * 2026-08-15 — it composites several layers, so it runs longer than a plain
 * selection even when warm.
 */
export const SKY_REPLACEMENT_TIMEOUT_MS = 120_000;

/** `ps_get_preview` with annotations — pre-existing inline literal, centralized. */
export const ANNOTATED_PREVIEW_TIMEOUT_MS = 90_000;

/**
 * Managed `scene:*` alpha-channel operations (load / store / delete) in
 * `perception/region-precompute.ts`.
 *
 * These are FULL-CANVAS mask reads and writes, so their cost scales with
 * document pixels exactly like the Sensei selections above — but they ran on the
 * runner's bare 30s default. Live 2026-07-30 on a 51MP document, a
 * `doc.selection.load(scene:face_nose)` blew through 30s and the wrapper killed
 * the child; Photoshop had ACTUALLY COMPLETED the load (the selection was
 * present, correctly placed, on the very next read), so the user got a hard
 * error for an operation that succeeded.
 *
 * Same tradeoff this module opens with: a genuine hang now takes 120s instead of
 * 30s to surface. Accepted here because the failure this replaces was a false
 * NEGATIVE on a completed operation — strictly worse than waiting, since the
 * caller cannot tell "timed out" from "didn't happen" and may redo destructive
 * work. Matching the Sensei budgets keeps one number for "pixel-heavy PS op".
 */
export const SCENE_CHANNEL_TIMEOUT_MS = 120_000;

/**
 * `ps_sequence` — the overall wall-clock budget for one sequence call, checked
 * between steps. Each step already inherits its own tool's timeout (the
 * budgets above); this bounds the SUM across up to 25 steps so a runaway
 * sequence can't run indefinitely. Generous on purpose — firing it costs the
 * caller the whole sequence, not just one slow step.
 *
 * Seam note: this constant is where a per-tool budget table, if one is added
 * later, would be consulted for a tighter running estimate instead of only
 * checking the total after the fact.
 */
export const SEQUENCE_OVERALL_TIMEOUT_MS = 300_000;

/**
 * Per-tool dispatch budgets (ms) — see the file doc comment for how this
 * layer relates to the overrides above.
 *
 * Values are derived from measured p99 execution times across real tool
 * calls (dev-machine telemetry, PS 27.x, win32): roughly double the clean
 * p99 (excluding calls already censored at the old flat 30s ceiling),
 * rounded up to the nearest second, floored at `SCRIPT_TIMEOUT_FLOOR_MS`. A
 * tool absent from this table had fewer than 10 measured calls — too little
 * signal to derive a number from — and falls back to
 * `DEFAULT_SCRIPT_TIMEOUT_MS` in `getToolTimeoutMs()` below.
 *
 * The six tools that already had a hardcoded override above keep that exact
 * value here instead of the (smaller) number this table's formula would
 * otherwise derive — each override already accounts for a known cliff (e.g.
 * first Camera Raw engine init) the raw percentile doesn't fully capture at
 * this sample size.
 */
const TOOL_TIMEOUT_BUDGETS_MS: Record<string, number> = {
  ps_open_document: OPEN_DOCUMENT_TIMEOUT_MS,
  ps_apply_camera_raw: CAMERA_RAW_FILTER_TIMEOUT_MS,
  ps_select_subject: SELECT_SUBJECT_TIMEOUT_MS,
  ps_select_sky: SELECT_SKY_TIMEOUT_MS,
  ps_select_focus_area: SELECT_FOCUS_AREA_TIMEOUT_MS,
  ps_replace_sky: SKY_REPLACEMENT_TIMEOUT_MS,

  // Genuinely long — pixel-heavy full-canvas reads or first-run-model
  // operations, well above the shared default.
  ps_selection_channel: 123_000,
  ps_read_scene: 164_000,
  ps_batch: 212_000,

  // Moderately long — native-AI or multi-step operations.
  ps_select_subject_instance: 42_000,
  ps_select_face_feature: 38_000,
  ps_ping: 38_000,
  ps_template_verify: 35_000,
  ps_select: 33_000,
  ps_select_object: 29_000,
  ps_get_histogram: 25_000,
  ps_select_by_reference: 25_000,
  ps_execute_script: 22_000,
  ps_template_save: 20_000,
  ps_detect: 19_000,
  ps_template_create_evidence: 18_000,
  ps_modify_selection: 17_000,
  ps_resize_image: 16_000,
  ps_save_psd: 15_000,
  ps_stroke_face_contour: 15_000,
  ps_get_preview: 14_000,
  ps_get_selection_preview: 14_000,
  ps_undo: 12_000,
  ps_crop_document: 10_000,
  ps_transform_canvas: 10_000,
  ps_apply_brush_stroke: 9_000,
  ps_play_action: 9_000,
  ps_document: 8_000,
  ps_path: 8_000,
  ps_duplicate_layer: 7_000,
  ps_warp_layer_along: 7_000,
  ps_resolve_placement: 7_000,
  ps_bake_layer: 6_000,
  ps_create_document: 6_000,
  ps_retouch: 6_000,
  ps_warp_layer_mesh: 6_000,

  // Clean p99 well under the shared default; floored at SCRIPT_TIMEOUT_FLOOR_MS.
  ps_list_capabilities: 5_000,
  ps_list_actions: 5_000,
  ps_add_adjustment_layer: 5_000,
  ps_apply_adjustment: 5_000,
  ps_close_document: 5_000,
  ps_export: 5_000,
  ps_filter: 5_000,
  ps_group: 5_000,
  ps_clipping_mask: 5_000,
  ps_redo: 5_000,
  ps_place_image: 5_000,
  ps_convert_image_mode: 5_000,
  ps_move_layer_to_position: 5_000,
  ps_convert_to_smart_object: 5_000,
  ps_rasterize_layer: 5_000,
  ps_set_layer: 5_000,
  ps_copy_to_new_layer: 5_000,
  ps_merge: 5_000,
  ps_add_layer_style: 5_000,
  ps_create_layer: 5_000,
  ps_delete_layer: 5_000,
  ps_fill_layer: 5_000,
  ps_add_fill_layer: 5_000,
  ps_select_layer: 5_000,
  ps_transform_layer: 5_000,
  ps_warp_layer: 5_000,
  ps_guides: 5_000,
  ps_inspect: 5_000,
  ps_overview: 5_000,
  ps_get_layer_bounds_diff: 5_000,
  ps_compare_regions: 5_000,
  ps_layer_mask: 5_000,
  ps_vector_mask: 5_000,
  ps_apply_image: 5_000,
  ps_shape: 5_000,
  ps_template_apply: 5_000,
  ps_text: 5_000,
};

/**
 * Optional global override for a machine slower than the ones the budgets
 * above were measured on. Set to a positive number of milliseconds, every
 * budget scales by `value / DEFAULT_SCRIPT_TIMEOUT_MS` — a tool with no
 * table entry gets exactly this value, while a tool with a derived budget
 * keeps its proportion relative to the others instead of collapsing to one
 * flat number. Read fresh on every call rather than cached; nothing here is
 * hot enough to need it.
 */
function scriptTimeoutScale(): number {
  const raw = process.env.EDITMAMEI_SCRIPT_TIMEOUT_MS;
  if (!raw) return 1;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n / DEFAULT_SCRIPT_TIMEOUT_MS : 1;
}

/**
 * The budget for one MCP tool call — this tool's table entry if it has one,
 * otherwise `DEFAULT_SCRIPT_TIMEOUT_MS`, scaled by
 * `EDITMAMEI_SCRIPT_TIMEOUT_MS` if set. Applied once per dispatch by
 * `ToolRegistry.execute` (see `tool-budget-context.ts`) so every script the
 * handler runs inherits it, unless that particular `runScript` call passes
 * its own explicit `timeoutMs`.
 */
export function getToolTimeoutMs(toolName: string): number {
  const base = TOOL_TIMEOUT_BUDGETS_MS[toolName] ?? DEFAULT_SCRIPT_TIMEOUT_MS;
  return Math.round(base * scriptTimeoutScale());
}
