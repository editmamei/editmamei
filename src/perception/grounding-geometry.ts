/**
 * Pure geometry for the spatial-grounding verification backbone (Phase 1).
 *
 * These are the dependency-free primitives the internal geometric GATE
 * (grounding-gate.ts) uses to MEASURE a resolved placement against its anchors —
 * signed distance to a curve, polygon area, point-in-region, polyline/region
 * intersection. Everything works in DOCUMENT pixels (screen convention: +x
 * right, +y DOWN) and unit-tests without Photoshop or any image decode.
 *
 * These primitives serve the {anchors, relation} contract; the gate computes its
 * own features from real geometry rather than being handed them (review W2).
 */

export interface Point {
  x: number;
  y: number;
}

/** An ordered polyline: open = a curve (a landmark arc, a traced edge), closed = a contour. */
export type Polyline = Point[];

/** An axis-aligned box in document pixels. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A region to test containment/exclusion against — a box or an arbitrary polygon. */
export type Region = { kind: 'box'; box: Box } | { kind: 'polygon'; polygon: Polyline };

/** The four axis directions a relation can offset toward (screen convention, +y down). */
export type Side = 'up' | 'down' | 'left' | 'right';

export function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Tight bounding box of a polyline. Throws on empty input (a degenerate caller bug). */
export function boundsOf(poly: Polyline): Box {
  if (poly.length === 0) throw new Error('boundsOf: empty polyline');
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const p of poly) {
    if (p.x < left) left = p.x;
    if (p.x > right) right = p.x;
    if (p.y < top) top = p.y;
    if (p.y > bottom) bottom = p.y;
  }
  return { left, top, right, bottom };
}

/**
 * Interpolate a curve's OTHER coordinate at a given coordinate along `axis`.
 * For `axis:'x'` returns the curve's y where it crosses x=`at`; for `axis:'y'`
 * returns x where it crosses y=`at`. The curve is sorted by `axis` internally,
 * so callers don't have to pre-sort. Values outside the curve's range clamp to
 * the nearest endpoint (an offset curve should span the source's range; clamping
 * is the safe degenerate behaviour rather than extrapolating a wild tangent).
 */
export function interpolateCurveAt(curve: Polyline, at: number, axis: 'x' | 'y'): number {
  if (curve.length === 0) throw new Error('interpolateCurveAt: empty curve');
  const other: 'x' | 'y' = axis === 'x' ? 'y' : 'x';
  if (curve.length === 1) return curve[0][other];
  const sorted = [...curve].sort((a, b) => a[axis] - b[axis]);
  if (at <= sorted[0][axis]) return sorted[0][other];
  const last = sorted[sorted.length - 1];
  if (at >= last[axis]) return last[other];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i],
      b = sorted[i + 1];
    if (at >= a[axis] && at <= b[axis]) {
      const span = b[axis] - a[axis];
      if (span === 0) return a[other];
      const t = (at - a[axis]) / span;
      return a[other] + t * (b[other] - a[other]);
    }
  }
  return last[other]; // unreachable given the clamps, but keeps the return total
}

/**
 * Signed gap from a point to a source curve, in the requested direction. Positive
 * means the point is ON the requested side by that many pixels; negative means it
 * is on the WRONG side (or overlapping). For `down`, gap = point.y − curve.y(at
 * point.x): a point below the curve (larger y) is positive. This is the core
 * measurement behind the `under_eye` check — an under-eye line MUST have a
 * positive gap below the lower-lid landmark.
 */
export function signedGapToCurve(point: Point, curve: Polyline, side: Side): number {
  switch (side) {
    case 'down':
      return point.y - interpolateCurveAt(curve, point.x, 'x');
    case 'up':
      return interpolateCurveAt(curve, point.x, 'x') - point.y;
    case 'right':
      return point.x - interpolateCurveAt(curve, point.y, 'y');
    case 'left':
      return interpolateCurveAt(curve, point.y, 'y') - point.x;
  }
}

/**
 * The MINIMUM signed gap from every point of `offset` to the `source` curve, on
 * `side`. This is the gate's real measurement of "how far is the whole offset
 * curve on the requested side, at its worst point." A value ≥ the required
 * margin AND > 0 everywhere means the curve clears the source; a negative value
 * means part of it crossed to the wrong side (the `under_eye`-overlap defect).
 */
export function minSignedGap(offset: Polyline, source: Polyline, side: Side): number {
  if (offset.length === 0) throw new Error('minSignedGap: empty offset curve');
  let min = Infinity;
  for (const p of offset) {
    const g = signedGapToCurve(p, source, side);
    if (g < min) min = g;
  }
  return min;
}

/** Shoelace area of a closed polygon (absolute value). */
export function polygonArea(poly: Polyline): number {
  if (poly.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i],
      b = poly[(i + 1) % poly.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

export function pointInBox(p: Point, box: Box): boolean {
  return p.x >= box.left && p.x <= box.right && p.y >= box.top && p.y <= box.bottom;
}

/** Ray-casting point-in-polygon (odd crossings = inside). Boundary is treated as inside-ish. */
export function pointInPolygon(p: Point, poly: Polyline): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i],
      b = poly[j];
    const intersects =
      a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInRegion(p: Point, region: Region): boolean {
  return region.kind === 'box' ? pointInBox(p, region.box) : pointInPolygon(p, region.polygon);
}

/** Do segments p1p2 and p3p4 properly cross? (Orientation test; collinear-touch counts as false.) */
export function segmentsIntersect(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const o = (a: Point, b: Point, c: Point): number =>
    Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  const o1 = o(p1, p2, p3),
    o2 = o(p1, p2, p4),
    o3 = o(p3, p4, p1),
    o4 = o(p3, p4, p2);
  return o1 !== o2 && o3 !== o4;
}

/** Region edges as segment pairs (box → 4 edges, polygon → its edges). */
function regionEdges(region: Region): [Point, Point][] {
  if (region.kind === 'box') {
    const { left: l, top: t, right: r, bottom: b } = region.box;
    const c: Point[] = [
      { x: l, y: t },
      { x: r, y: t },
      { x: r, y: b },
      { x: l, y: b },
    ];
    return [
      [c[0], c[1]],
      [c[1], c[2]],
      [c[2], c[3]],
      [c[3], c[0]],
    ];
  }
  const poly = region.polygon;
  const edges: [Point, Point][] = [];
  for (let i = 0; i < poly.length; i++) edges.push([poly[i], poly[(i + 1) % poly.length]]);
  return edges;
}

/**
 * Does a polyline enter a region? True if any vertex is inside OR any segment
 * crosses a region edge (so a curve that passes THROUGH a box without a vertex
 * inside is still caught). Used as the gate's exclusion-mask guard — e.g. an
 * under-eye line must not enter the eye region.
 */
export function polylineIntersectsRegion(poly: Polyline, region: Region): boolean {
  for (const p of poly) if (pointInRegion(p, region)) return true;
  const edges = regionEdges(region);
  for (let i = 0; i < poly.length - 1; i++) {
    for (const [e1, e2] of edges) {
      if (segmentsIntersect(poly[i], poly[i + 1], e1, e2)) return true;
    }
  }
  return false;
}
