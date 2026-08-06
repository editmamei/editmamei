/**
 * Shared JPEG-quality constant for the ANNOTATED-PREVIEW encode sites (perf-audit
 * M5/M6) — detection boxes (`ps_detect`), scene overlays (`ps_read_scene`),
 * landmark points (`ps_detect_landmarks`), and the spatial-grounding review crop
 * (`ps_resolve_placement`). These all encode via `jpeg-js`'s `encode(imgData,
 * quality)`, whose `quality` is the standard 0-100 JPEG scale — a DIFFERENT knob
 * from `ps_get_preview`'s `quality` param (1-12, Photoshop's own
 * `JPEGSaveOptions.quality` scale; see preview-tools.ts). The four sites had each
 * hand-picked their own number (88 / 90) on the 0-100 scale — this centralizes
 * them to ONE constant instead of four independent literals that would silently
 * drift.
 *
 * Annotation overlays are high-contrast synthetic marks (thin colored box/line/
 * point strokes) on top of natural photo content, so they need more headroom than
 * `ps_get_preview`'s pure-tonal-judgment default before JPEG blocking reads as
 * "is that a line or an artifact?" — 80 stays comfortably in the visually-clean
 * band for that content while meaningfully undercutting the prior 88-90 (encode
 * time + payload both scale with quality).
 */

/** JPEG quality (0-100, jpeg-js's `encode()` scale) for every annotated-preview
 *  encode site — detection boxes, scene overlays, landmark points, review crops. */
export const ANNOTATED_PREVIEW_JPEG_QUALITY = 80;
