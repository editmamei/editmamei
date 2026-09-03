/**
 * Centralized per-operation timeout budgets (ms) — the third argument
 * `timeoutMs` handlers pass through `runScript()` to override the platform
 * runner's default (`windows-runner.ts` / `macos-runner.ts` `run()`).
 *
 * Two layers live in this file. The overrides below predate the second layer
 * and are a handler's own explicit choice, passed at its own `runScript`
 * call sites. `getToolTimeoutMs()` at the bottom is the newer, coarser layer:
 * one budget per MCP tool, consumed once at dispatch (`ToolRegistry.execute`,
 * via `tool-budget-context.ts`) to compute that call's absolute DEADLINE —
 * every script the handler runs is bounded by whichever is sooner, its own
 * requested timeout or however much of that deadline is left. A call that
 * runs several scripts spends the budget once across all of them; it is not
 * handed fresh to each one. See `run-script.ts` for exactly how a script's
 * effective timeout is derived from the deadline.
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

import { Logger } from './logger.js';

const logger = new Logger('operation-timeouts');

/**
 * Wall-clock budget for a single script when no per-tool budget below
 * applies and the handler didn't override it directly. The single shared
 * constant both platform runners import, so `getToolTimeoutMs()` can reason
 * about "the tool's budget, or this fallback" in one place.
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
 * Derivation: for every row in the measured-latency data that a tool
 * dispatches to — a consolidated tool maps to every op it now covers, not
 * just a row sharing its own name — the candidate is
 * `max(2 * p99_clean, 1.5 * max_clean)`; a row with any calls censored at
 * the old flat 30s ceiling (`ceiling_hits > 0`) floors its candidate at
 * 30000, since the clean subset of a censored row understates the true
 * tail. The tool's budget is the max candidate across all its rows, rounded
 * up to the nearest second. A false timeout is worse than a slow one —
 * Photoshop keeps executing after the child is killed — so the max/1.5x
 * term exists specifically to keep the budget at or above every duration
 * already observed for that tool, not just its percentile.
 *
 * A community/dev tool absent from this table is on the `TOOLS_WITHOUT_A_BUDGET`
 * allowlist below (fewer than 10 measured calls in every row it maps to —
 * too little signal to derive a number from) and falls back to
 * `DEFAULT_SCRIPT_TIMEOUT_MS`. `getToolTimeoutMs()`'s own completeness is
 * pinned by `tests/integration/tool-timeout-budgets.test.ts`.
 *
 * Pro-tier tools are deliberately absent from BOTH this table and the
 * allowlist, with no exception — not even the one pre-existing override
 * (`ps_apply_camera_raw`) that would cost nothing to include. This file
 * ships in the CE bundle, and an object key compiles to a plain, unquoted
 * property name — invisible to a leak-guard that scans compiled output for
 * quoted Pro tool name literals, but just as readable to a person as a
 * quoted string would be. A Pro tool's own handler (in the private repo)
 * is responsible for passing its own explicit `timeoutMs` at its own
 * `runScript` call sites when it needs more than the shared default, the
 * same way the community overrides above already do.
 */
export const TOOL_TIMEOUT_BUDGETS_MS: Record<string, number> = {
  ps_open_document: OPEN_DOCUMENT_TIMEOUT_MS,
  ps_select_subject: SELECT_SUBJECT_TIMEOUT_MS,
  ps_select_sky: SELECT_SKY_TIMEOUT_MS,
  ps_select_focus_area: SELECT_FOCUS_AREA_TIMEOUT_MS,
  ps_replace_sky: SKY_REPLACEMENT_TIMEOUT_MS,

  // Held at the shared default deliberately: measured p99 (~18.6s, doubled
  // would clear 30s) would otherwise raise this, but ps_ping already has a
  // known first-impression cost when Photoshop is slow to answer, and this
  // is the one tool where a caller is actively waiting to find out if
  // Photoshop is there at all.
  ps_ping: 30_000,

  // Genuinely long — pixel-heavy full-canvas reads, well above the shared default.
  ps_read_scene: 164_000,
  ps_selection_channel: 123_000,

  // Moderately long.
  ps_select: 54_000,
  ps_modify_selection: 37_000,
  ps_save_psd: 32_000,
  ps_filter: 31_000,
  ps_get_histogram: 25_000,
  ps_create_document: 20_000,
  ps_detect: 19_000,
  ps_get_preview: 17_000,
  ps_resize_image: 16_000,
  ps_stroke_face_contour: 15_000,
  ps_get_selection_preview: 14_000,
  ps_undo: 12_000,
  ps_export: 9_000,
  ps_apply_brush_stroke: 9_000,
  ps_path: 10_000,
  ps_crop_document: 10_000,
  ps_inspect: 7_000,
  ps_duplicate_layer: 7_000,
  ps_shape: 7_000,
  ps_text: 7_000,
  ps_set_layer: 6_000,
  ps_bake_layer: 6_000,

  // Rows carrying calls already censored at the old flat 30s ceiling — the
  // formula's own max(...,30000) floor, not a hand-picked number.
  ps_document: 30_000,
  ps_apply_adjustment: 30_000,
  ps_close_document: 30_000,
  ps_group: 30_000,
  ps_clipping_mask: 30_000,
  ps_convert_image_mode: 30_000,
  ps_convert_to_smart_object: 30_000,
  ps_create_layer: 30_000,
  ps_fill_layer: 30_000,
  ps_select_layer: 30_000,
  ps_transform_layer: 30_000,
  ps_transform_canvas: 30_000,
  ps_guides: 30_000,
  ps_retouch: 30_000,
  ps_select_by_reference: 30_000,

  // Clean p99 well under the shared default; floored at SCRIPT_TIMEOUT_FLOOR_MS.
  ps_list_capabilities: 5_000,
  ps_add_adjustment_layer: 5_000,
  ps_redo: 5_000,
  ps_place_image: 5_000,
  ps_move_layer_to_position: 5_000,
  ps_rasterize_layer: 5_000,
  ps_copy_to_new_layer: 5_000,
  ps_merge: 5_000,
  ps_add_layer_style: 5_000,
  ps_delete_layer: 5_000,
  ps_add_fill_layer: 5_000,
  ps_overview: 5_000,
  ps_get_layer_bounds_diff: 5_000,
  ps_compare_regions: 5_000,
  ps_layer_mask: 5_000,
  ps_vector_mask: 5_000,
  ps_apply_image: 5_000,
};

/**
 * Community/dev tools with no `TOOL_TIMEOUT_BUDGETS_MS` entry — every row
 * they map to had fewer than 10 measured calls, too little signal to derive
 * a number from — mapped to why the shared default is the deliberate choice
 * here rather than an oversight. `getToolTimeoutMs()` falls back to
 * `DEFAULT_SCRIPT_TIMEOUT_MS` for these exactly as it does for an
 * unrecognized name.
 */
export const TOOLS_WITHOUT_A_BUDGET: Record<string, string> = {
  ps_report_problem: 'n=3 measured calls',
  ps_calculations: 'n=8 measured calls',
  ps_portrait_touchup: 'n=9 measured calls',
};

/**
 * Optional global override for a machine slower than the ones the budgets
 * above were measured on, read ONCE at module load — not per call, so it
 * can't change mid-process — and applied only inside `getToolTimeoutMs()`.
 * It never touches an explicit `timeoutMs` a handler passes directly to
 * `runScript`, which always means exactly what the caller wrote, nor the
 * deadline math in `run-script.ts`, which works in absolute remaining time
 * regardless of how the budget it was given was computed.
 *
 * Set to a positive number of milliseconds, every table/default budget
 * scales by `value / DEFAULT_SCRIPT_TIMEOUT_MS` — a tool with no table entry
 * gets exactly this value; a tool with a derived budget keeps its
 * proportion relative to the others instead of collapsing to one flat
 * number. `getToolTimeoutMs()` clamps its RESULT to `SCRIPT_TIMEOUT_FLOOR_MS`
 * separately, so a small value here can't push a tool below the floor. A
 * malformed value (not a positive number) is ignored with a warning rather
 * than silently taken as 1x or crashing the process.
 */
function resolveScriptTimeoutScale(): number {
  const raw = process.env.EDITMAMEI_SCRIPT_TIMEOUT_MS;
  if (!raw) return 1;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    logger.warn(`EDITMAMEI_SCRIPT_TIMEOUT_MS="${raw}" is not a positive number — ignoring it.`);
    return 1;
  }
  return n / DEFAULT_SCRIPT_TIMEOUT_MS;
}

const SCRIPT_TIMEOUT_SCALE = resolveScriptTimeoutScale();

/**
 * The budget for one MCP tool call — this tool's table entry if it has one,
 * otherwise `DEFAULT_SCRIPT_TIMEOUT_MS`, scaled by
 * `EDITMAMEI_SCRIPT_TIMEOUT_MS` if set, and floored at
 * `SCRIPT_TIMEOUT_FLOOR_MS` regardless of how small that scaling would
 * otherwise make it. Consumed once per dispatch by `ToolRegistry.execute`
 * (see `tool-budget-context.ts`) to compute that call's deadline.
 * `Object.hasOwn` guards a lookup name that collides with an inherited
 * `Object.prototype` member (e.g. `'toString'`), which would otherwise read
 * back a function instead of `undefined` and multiply to `NaN`.
 */
export function getToolTimeoutMs(toolName: string): number {
  const base = Object.hasOwn(TOOL_TIMEOUT_BUDGETS_MS, toolName)
    ? TOOL_TIMEOUT_BUDGETS_MS[toolName]
    : DEFAULT_SCRIPT_TIMEOUT_MS;
  return Math.max(Math.round(base * SCRIPT_TIMEOUT_SCALE), SCRIPT_TIMEOUT_FLOOR_MS);
}
