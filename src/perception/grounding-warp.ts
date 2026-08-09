/**
 * Grounded-warp geometry — pure functions that turn a RESOLVED curve (from the
 * spatial-grounding resolver) into a destination Bézier control mesh for the
 * `warpMesh` snippet's RAW path. "Name a curve; the layer bends to follow it,"
 * instead of the model hand-typing a mesh of pixels.
 *
 * The layer's home grid (spanning its bounds) is laid onto the curve: the ALONG
 * axis is re-parameterized by the curve's arc length, and the ACROSS axis is
 * offset perpendicular to the curve (centered), so the layer's centerline follows
 * the curve exactly (by construction) and its thickness is preserved on either
 * side. The result feeds `warpMesh` RAW verbatim (no edge welding).
 *
 * Pure + unit-tested here; the PS application (quilt customEnvelopeWarp) is the
 * already-live-verified `warpMesh` RAW path.
 */

export interface WPt {
  x: number;
  y: number;
}
export interface WBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface CurveSample {
  point: WPt;
  /** Unit left-normal (90° CCW from the local tangent). */
  normal: WPt;
}

/**
 * Total arc length of a polyline (sum of segment lengths).
 */
export function curveLength(curve: WPt[]): number {
  let total = 0;
  for (let k = 0; k < curve.length - 1; k++)
    total += Math.hypot(curve[k + 1].x - curve[k].x, curve[k + 1].y - curve[k].y);
  return total;
}

/**
 * Sample a polyline at explicit ARC-LENGTHS (each clamped to [0, total]), returning
 * each point + the unit left-normal of the local tangent. Throws on a degenerate
 * curve (<2 points, non-finite, or zero total length).
 */
export function sampleCurveAtLengths(curve: WPt[], lengths: number[]): CurveSample[] {
  if (curve.length < 2) throw new Error('curve needs at least 2 points');
  if (curve.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y)))
    throw new Error('curve has non-finite points');
  // Cumulative arc length at the START of each segment k (curve[k] → curve[k+1]).
  const cum: number[] = [];
  const seg: number[] = [];
  let total = 0;
  for (let k = 0; k < curve.length - 1; k++) {
    cum.push(total);
    const l = Math.hypot(curve[k + 1].x - curve[k].x, curve[k + 1].y - curve[k].y);
    seg.push(l);
    total += l;
  }
  if (total === 0) throw new Error('curve has zero length (all points coincident)');

  return lengths.map((target) => {
    const tt = target < 0 ? 0 : target > total ? total : target; // clamp to the curve
    // Segment whose [cum, cum+seg] span contains `tt` (last segment for the end).
    let k = 0;
    while (k < seg.length - 1 && cum[k] + seg[k] < tt) k++;
    const t = seg[k] > 0 ? (tt - cum[k]) / seg[k] : 0;
    const a = curve[k];
    const b = curve[k + 1];
    const point = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const m = Math.hypot(dx, dy) || 1;
    return { point, normal: { x: -dy / m, y: dx / m } };
  });
}

/**
 * Resample a polyline at `count` points spaced evenly by ARC LENGTH (fractions
 * 0…1 of the total length), each with the unit left-normal of the local tangent.
 * Throws on a degenerate curve (<2 points or zero total length).
 */
export function resampleByArcLength(curve: WPt[], count: number): CurveSample[] {
  if (count < 2) throw new Error('count must be at least 2');
  const total = curveLength(curve);
  const lengths = Array.from({ length: count }, (_, i) => (i / (count - 1)) * total);
  return sampleCurveAtLengths(curve, lengths);
}

/**
 * Light Laplacian smoothing of a polyline (each interior point → ½·self + ¼·each
 * neighbor), `iterations` passes, ENDPOINTS FIXED. Damps the high-frequency jitter
 * of a noisy edge trace so a warp follows the curve's shape, not its noise, while
 * leaving a straight line straight (collinear points are already their own average)
 * and preserving the curve's extent. No-op for <3 points or iterations ≤ 0.
 */
export function smoothCurve(curve: WPt[], iterations: number): WPt[] {
  if (iterations <= 0 || curve.length < 3) return curve.map((p) => ({ x: p.x, y: p.y }));
  let pts = curve.map((p) => ({ x: p.x, y: p.y }));
  for (let it = 0; it < iterations; it++) {
    const next = pts.map((p) => ({ x: p.x, y: p.y }));
    for (let i = 1; i < pts.length - 1; i++) {
      next[i] = {
        x: 0.5 * pts[i].x + 0.25 * pts[i - 1].x + 0.25 * pts[i + 1].x,
        y: 0.5 * pts[i].y + 0.25 * pts[i - 1].y + 0.25 * pts[i + 1].y,
      };
    }
    pts = next;
  }
  return pts;
}

export interface WarpAlongResult {
  /** Destination control points, row-major (NROWS rows × NCOLS cols), doc pixels. */
  meshPoints: WPt[];
  /** Quilt CELL counts for the snippet (NCOLS = 3*ncx+1, NROWS = 3*ncy+1). */
  ncx: number;
  ncy: number;
  ncols: number;
  nrows: number;
  /** Bounding box of the destination mesh (for the read-back verification). */
  destBBox: WBounds;
  /** Fraction of the curve's arc length the layer covers (1 = the whole curve). */
  curveCovered: number;
}

/**
 * Lay a layer's home mesh grid onto `curve`. `runAxis` picks which layer dimension
 * follows the curve: 'horizontal' → the WIDTH runs along the curve (cols = along),
 * 'vertical' → the HEIGHT runs along (rows = along). `alongCells`/`acrossCells` are
 * quilt cell counts along/across the run. The returned `meshPoints` are ordered to
 * match the snippet's row-major iteration (rows outer, cols inner).
 */
export function warpAlongCurve(
  bounds: WBounds,
  curve: WPt[],
  opts: {
    runAxis: 'horizontal' | 'vertical';
    alongCells: number;
    acrossCells: number;
    /** Laplacian smoothing passes on the curve before sampling (0 = none). */
    smooth?: number;
    /**
     * How the layer's along-axis maps to the curve. 'stretch' (default): the layer
     * is scaled to span the WHOLE curve (distorts aspect if the lengths differ).
     * 'preserve': the layer runs at NATURAL 1:1 scale from the curve's start,
     * covering only its own length of arc (no along-stretch).
     */
    fit?: 'stretch' | 'preserve';
  }
): WarpAlongResult {
  const { runAxis, alongCells, acrossCells } = opts;
  const horizontal = runAxis === 'horizontal';
  const alongCount = 3 * alongCells + 1;
  const acrossCount = 3 * acrossCells + 1;
  // The layer's ALONG dimension (mapped to the curve) and its ACROSS thickness.
  const along = horizontal ? bounds.right - bounds.left : bounds.bottom - bounds.top;
  const thickness = horizontal ? bounds.bottom - bounds.top : bounds.right - bounds.left;
  // Damp trace jitter so the warp follows the curve's shape, not its noise.
  const src = (opts.smooth ?? 0) > 0 ? smoothCurve(curve, opts.smooth as number) : curve;
  // 'preserve' lays the layer at natural scale (covers its own length of the curve,
  // capped at the curve end); 'stretch' fits it to the whole curve.
  const total = curveLength(src);
  const spanLen = (opts.fit ?? 'stretch') === 'preserve' ? Math.min(along, total) : total;
  const curveCovered = total > 0 ? spanLen / total : 1;
  const lengths = Array.from({ length: alongCount }, (_, i) => (i / (alongCount - 1)) * spanLen);
  const samples = sampleCurveAtLengths(src, lengths);

  // Quilt grid: cols follow the curve when horizontal, rows follow it when vertical.
  const ncx = horizontal ? alongCells : acrossCells;
  const ncy = horizontal ? acrossCells : alongCells;
  const ncols = 3 * ncx + 1;
  const nrows = 3 * ncy + 1;

  const meshPoints: WPt[] = [];
  let l = Infinity;
  let t = Infinity;
  let r = -Infinity;
  let b = -Infinity;
  for (let rj = 0; rj < nrows; rj++) {
    for (let ci = 0; ci < ncols; ci++) {
      const alongIdx = horizontal ? ci : rj;
      const acrossIdx = horizontal ? rj : ci;
      const s = samples[alongIdx];
      const v = acrossCount > 1 ? acrossIdx / (acrossCount - 1) : 0.5;
      const off = (v - 0.5) * thickness;
      const x = s.point.x + s.normal.x * off;
      const y = s.point.y + s.normal.y * off;
      meshPoints.push({ x, y });
      if (x < l) l = x;
      if (y < t) t = y;
      if (x > r) r = x;
      if (y > b) b = y;
    }
  }
  return {
    meshPoints,
    ncx,
    ncy,
    ncols,
    nrows,
    destBBox: { left: l, top: t, right: r, bottom: b },
    curveCovered,
  };
}

export interface WarpRadialResult {
  meshPoints: WPt[];
  ncx: number;
  ncy: number;
  ncols: number;
  nrows: number;
  destBBox: WBounds;
  /** Peak control-point displacement magnitude (px) — a field-strength summary. */
  maxDisplacement: number;
}

/**
 * Radial bulge / pinch: displace a layer's home mesh grid RADIALLY about `center`,
 * falling off to zero at `radius`. Each control point moves by `v · amount · w`,
 * where `v` is its offset from the center and `w = (1 − (r/radius)²)²` (a smooth
 * bisquare bump, 1 at the center → 0 at the radius). `amount > 0` pushes points
 * outward → the center content MAGNIFIES (bulge); `amount < 0` pulls inward →
 * PINCH. `amount` must be > −1 (at −1 the near-center collapses; below it the mesh
 * folds through the center) — callers clamp to ≥ −0.9. `cells` sets the (square)
 * mesh density in both axes; a denser grid resolves the bump more smoothly.
 */
export function warpRadial(
  bounds: WBounds,
  center: WPt,
  radius: number,
  amount: number,
  opts: { cells: number }
): WarpRadialResult {
  const cells = opts.cells;
  const ncx = cells;
  const ncy = cells;
  const ncols = 3 * ncx + 1;
  const nrows = 3 * ncy + 1;
  const W = bounds.right - bounds.left;
  const H = bounds.bottom - bounds.top;

  const meshPoints: WPt[] = [];
  let maxDisplacement = 0;
  let l = Infinity;
  let t = Infinity;
  let r = -Infinity;
  let b = -Infinity;
  for (let rj = 0; rj < nrows; rj++) {
    for (let ci = 0; ci < ncols; ci++) {
      // Home position of control point (ci, rj) spanning the layer bounds.
      const hx = bounds.left + (ci / (ncols - 1)) * W;
      const hy = bounds.top + (rj / (nrows - 1)) * H;
      const vx = hx - center.x;
      const vy = hy - center.y;
      const rr = Math.hypot(vx, vy);
      const u = radius > 0 ? rr / radius : 1;
      let dx = 0;
      let dy = 0;
      if (u < 1) {
        const w = (1 - u * u) ** 2; // bisquare falloff: 1 at center → 0 at radius
        dx = vx * amount * w;
        dy = vy * amount * w;
      }
      const x = hx + dx;
      const y = hy + dy;
      const d = Math.hypot(dx, dy);
      if (d > maxDisplacement) maxDisplacement = d;
      meshPoints.push({ x, y });
      if (x < l) l = x;
      if (y < t) t = y;
      if (x > r) r = x;
      if (y > b) b = y;
    }
  }
  return {
    meshPoints,
    ncx,
    ncy,
    ncols,
    nrows,
    destBBox: { left: l, top: t, right: r, bottom: b },
    maxDisplacement,
  };
}

/**
 * The `lift` that makes an edge-pinned warp's FAR end reach `target` (used with the
 * `warpMesh` high-level path). The pinned edge is welded; the far end moves
 * PERPENDICULAR to the run by `lift`, landing its center at `crossC + lift`, where
 * `crossC` is the layer's mid-line on the perpendicular axis. So `lift` is the
 * signed distance from that mid-line to the target's perpendicular coordinate:
 * y for a horizontal run (pin left/right), x for a vertical run (pin top/bottom).
 */
export function farEndLift(
  bounds: WBounds,
  pinEdge: 'left' | 'right' | 'top' | 'bottom',
  target: WPt
): number {
  if (pinEdge === 'left' || pinEdge === 'right') {
    return target.y - (bounds.top + bounds.bottom) / 2; // horizontal run → perpendicular is y
  }
  return target.x - (bounds.left + bounds.right) / 2; // vertical run → perpendicular is x
}

/** Extract the active layer's bounds from a getContextInfo() snapshot (throws if absent/empty). */
export function activeLayerBounds(context: Record<string, unknown> | undefined): WBounds {
  const al = context?.activeLayer as
    { bounds?: { left: number; top: number; right: number; bottom: number } } | undefined;
  const b = al?.bounds;
  if (!b || ![b.left, b.top, b.right, b.bottom].every((n) => Number.isFinite(n)))
    throw new Error('could not read the active layer bounds (no active layer?)');
  if (b.right - b.left <= 0 || b.bottom - b.top <= 0)
    throw new Error('the active layer has empty bounds — nothing to warp');
  return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
}
