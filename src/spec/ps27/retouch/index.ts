/**
 * Retouch event specs — PS 27.x.
 *
 * Selection-driven destructive retouch operations. All target the
 * document's current selection via Chnl/fsel property reference and
 * bake pixels into the active layer.
 *
 * Captured during the 2026-06-08 capture spike.
 *
 * Not included (no AM descriptor emitted):
 *   - Red Eye filter (interactive pointer tool; no AM event for the fix)
 *   - Remove Tool (Sensei-backed AI; only tool-select + UI modal events
 *     captured, no descriptor for the operation itself)
 *
 * Those two would need alternative scripting paths (DOM
 * applyRedEyeRemoval if it exists, or a different Sensei API). Left
 * unbuilt pending further investigation.
 */

export { contentAwareFillSpec } from './content-aware-fill.js';
export { patchSpec } from './patch.js';
export { contentAwareMoveSpec } from './content-aware-move.js';
