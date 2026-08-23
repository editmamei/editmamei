/**
 * Centralized per-operation timeout budgets (ms) — the third argument
 * `timeoutMs` handlers pass through `runScript()` to override the platform
 * runner's 30s default (`windows-runner.ts` / `macos-runner.ts`
 * `run()`).
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
 * `ps_select_focus_area` (Focus Area). Measured 3.4s on a 4000x6000 frame,
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
