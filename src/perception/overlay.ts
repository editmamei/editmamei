/**
 * Shared RGBA overlay-drawing primitives (audit finding 9, 2026-07-30).
 *
 * Before this module, `setPx` + the box/ring/disc/square stamping loops were
 * copied four ways: detection-tools `drawBoxes`, scene-tools `annotateScene`,
 * detect-landmarks-tools-pro `drawPoints`, and grounding-review-crop — with
 * the annotation palette duplicated as bare literals in two of them. The
 * exported wrapper functions in those files keep their signatures (unit
 * tests pin their clone invariants); only the pixel loops live here now.
 *
 * All primitives mutate `img.data` in place and clip out-of-bounds writes.
 * Callers that must not mutate a shared buffer copy it first (the clone
 * invariant stays the caller's responsibility, unchanged).
 */

/**
 * Minimal structural shape shared by detection's `DecodedImage` and
 * perception's `RgbaImage`: RGBA, 4 bytes/pixel, row-major.
 */
export interface RgbaPixels {
  width: number;
  height: number;
  data: Uint8Array;
}

// Readonly so the shared palette tuples can't be corrupted process-wide by a
// stray `rgb[0] = …` in a callee (QA 2026-07-30); mutable tuples remain
// assignable to it at every call site.
export type RGB = readonly [number, number, number];

/**
 * The verification-overlay palette. Referenced by tool descriptions
 * ("faces cyan, objects magenta") — change the words if you change the
 * values.
 */
export const ANNOTATION_RGB: Record<'face' | 'object' | 'horizon', RGB> = {
  face: [0, 220, 255],
  object: [255, 0, 220],
  horizon: [255, 230, 0],
};

/** Overlay stroke thickness scaled to the export size (min 2px). */
export function annotationThickness(img: RgbaPixels): number {
  return Math.max(2, Math.round(Math.max(img.width, img.height) / 400));
}

export function setPx(img: RgbaPixels, x: number, y: number, [r, g, b]: RGB): void {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (y * img.width + x) * 4;
  img.data[i] = r;
  img.data[i + 1] = g;
  img.data[i + 2] = b;
  img.data[i + 3] = 255;
}

/** Axis-aligned box outline; coordinates are rounded, edges stamped inward. */
export function drawBoxOutline(
  img: RgbaPixels,
  box: [number, number, number, number],
  rgb: RGB,
  thickness: number
): void {
  const [x1, y1, x2, y2] = box.map(Math.round) as [number, number, number, number];
  for (let x = x1; x <= x2; x++)
    for (let k = 0; k < thickness; k++) {
      setPx(img, x, y1 + k, rgb);
      setPx(img, x, y2 - k, rgb);
    }
  for (let y = y1; y <= y2; y++)
    for (let k = 0; k < thickness; k++) {
      setPx(img, x1 + k, y, rgb);
      setPx(img, x2 - k, y, rgb);
    }
}

/** Full-width horizontal line stamped downward from `y`. */
export function drawHLine(img: RgbaPixels, y: number, rgb: RGB, thickness: number): void {
  for (let x = 0; x < img.width; x++) for (let k = 0; k < thickness; k++) setPx(img, x, y + k, rgb);
}

/** Filled axis-aligned square of half-side `radius` centered on (cx, cy). */
export function fillSquare(
  img: RgbaPixels,
  cx: number,
  cy: number,
  radius: number,
  rgb: RGB
): void {
  const x0 = Math.round(cx);
  const y0 = Math.round(cy);
  for (let dy = -radius; dy <= radius; dy++)
    for (let dx = -radius; dx <= radius; dx++) setPx(img, x0 + dx, y0 + dy, rgb);
}

/**
 * Hollow ring (annulus) covering radii `radius - thick` … `radius + thick` —
 * the feature shows through the hole (the E6 concur rule).
 */
export function drawRing(
  img: RgbaPixels,
  cx: number,
  cy: number,
  radius: number,
  thick: number,
  rgb: RGB
): void {
  const x0 = Math.round(cx);
  const y0 = Math.round(cy);
  const outer = radius + thick;
  for (let dy = -outer; dy <= outer; dy++) {
    for (let dx = -outer; dx <= outer; dx++) {
      const d = Math.hypot(dx, dy);
      if (d >= radius - thick && d <= radius + thick) setPx(img, x0 + dx, y0 + dy, rgb);
    }
  }
}

/** Filled disc of radius `radius` centered on (cx, cy). */
export function fillDisc(img: RgbaPixels, cx: number, cy: number, radius: number, rgb: RGB): void {
  const x0 = Math.round(cx);
  const y0 = Math.round(cy);
  for (let dy = -radius; dy <= radius; dy++)
    for (let dx = -radius; dx <= radius; dx++)
      if (dx * dx + dy * dy <= radius * radius) setPx(img, x0 + dx, y0 + dy, rgb);
}
