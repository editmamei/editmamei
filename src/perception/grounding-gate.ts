/**
 * Internal geometric GATE — stage 1 of the two-stage spatial-grounding
 * verification (Phase 1, verification backbone).
 *
 * The gate is a fail-closed REJECTER: before any pixels change, it asserts a
 * resolved placement against its anchors + sanity constraints using OBJECTIVE,
 * deterministic geometry — no model in the loop. It returns the COMPUTED features
 * in `measured` so the verdict is auditable and nothing is hand-asserted.
 *
 * This is the module the validation report (review W2) named as the first Phase-1
 * deliverable: the earlier prototype fed hand-specified verdict features
 * (`marginPx: -22`) into threshold checks, so its 9/9 was true by construction.
 * Here every feature — margin, side, intersection, area — is MEASURED from the
 * real geometry the caller passes in (grounding-geometry.ts). The tests corrupt
 * real curves programmatically and assert the gate computes the right verdict.
 */

import {
  type Point,
  type Polyline,
  type Box,
  type Region,
  type Side,
  boundsOf,
  dist,
  minSignedGap,
  polygonArea,
  pointInBox,
  polylineIntersectsRegion,
} from './grounding-geometry.js';

export interface Canvas {
  width: number;
  height: number;
}

/** Discriminated over the three target kinds from the spec ({point, path, region}). */
export type GateSpec =
  | {
      target: 'point';
      point: Point;
      canvas: Canvas;
      /** Optional expected region the point must fall inside (e.g. anchors' bbox + margin). */
      withinBounds?: Box;
      /** Optional anchor pair for a degeneracy check (a midpoint of coincident anchors is meaningless). */
      anchors?: [Point, Point];
      /** Minimum anchor separation in px (default 2). */
      minAnchorSeparation?: number;
    }
  | {
      target: 'path';
      kind: 'offset-curve';
      /** The proposed placement curve (e.g. the under-eye line). */
      curve: Polyline;
      /** The source landmark/edge curve it offsets from (e.g. the lower-lid line). */
      source: Polyline;
      side: Side;
      /** Required clearance in px on `side`. */
      requiredMargin: number;
      /** Optional exclusion region the curve must not enter (e.g. the eye mask). */
      exclusion?: Region;
      canvas: Canvas;
    }
  | {
      target: 'path';
      kind: 'edge';
      curve: Polyline;
      /** Per-point boundary confidence (e.g. the classical-CV luma/gradient Δ). */
      confidences: number[];
      minConfidence: number;
      canvas: Canvas;
    }
  | {
      target: 'path';
      kind: 'curve';
      /** A TRUSTED polyline (a face-mesh contour or a landmark curve — the mesh IS
       *  the trusted source, so there is no per-point confidence to check; the gate
       *  only asserts the curve is on-canvas and non-degenerate). */
      curve: Polyline;
      canvas: Canvas;
      /** Reject a curve shorter than this total arc length in px. Default 2. */
      minLength?: number;
    }
  | {
      target: 'region';
      polygon: Polyline;
      canvas: Canvas;
      /** Reject a region larger than this fraction of the frame (default 0.9). */
      maxAreaFraction?: number;
    };

export interface GateResult {
  pass: boolean;
  /** Present only when pass=false — a specific, human-readable rejection reason. */
  reason?: string;
  /** The COMPUTED features behind the verdict (auditable; never hand-asserted). */
  measured: Record<string, number | boolean | string>;
}

const inCanvas = (p: Point, c: Canvas): boolean =>
  p.x >= 0 && p.x <= c.width && p.y >= 0 && p.y <= c.height;

function gatePoint(spec: Extract<GateSpec, { target: 'point' }>): GateResult {
  const { point: p, canvas, withinBounds, anchors } = spec;
  const minSep = spec.minAnchorSeparation ?? 2;
  const sep = anchors ? dist(anchors[0], anchors[1]) : undefined;
  const measured: GateResult['measured'] = { x: p.x, y: p.y };
  if (sep !== undefined) measured.anchorSeparation = sep;

  if (!inCanvas(p, canvas)) {
    return {
      pass: false,
      reason: `point (${Math.round(p.x)},${Math.round(p.y)}) outside canvas ${canvas.width}x${canvas.height}`,
      measured,
    };
  }
  if (sep !== undefined && sep < minSep) {
    return {
      pass: false,
      reason: `degenerate relation — anchors ${sep.toFixed(1)}px apart (< ${minSep}px)`,
      measured,
    };
  }
  if (withinBounds && !pointInBox(p, withinBounds)) {
    return { pass: false, reason: 'point outside the expected region for this relation', measured };
  }
  return { pass: true, measured };
}

function gateOffsetCurve(
  spec: Extract<GateSpec, { target: 'path'; kind: 'offset-curve' }>
): GateResult {
  const { curve, source, side, requiredMargin, exclusion, canvas } = spec;
  // MEASURE the worst-case signed gap of the whole curve to the source, on `side`.
  const minMargin = minSignedGap(curve, source, side);
  const sideOk = minMargin > 0; // any point on the wrong side pushes this ≤ 0
  const intersects = exclusion ? polylineIntersectsRegion(curve, exclusion) : false;
  const outOfCanvas = curve.some((p) => !inCanvas(p, canvas));
  const measured: GateResult['measured'] = {
    minMargin: Math.round(minMargin * 100) / 100,
    requiredMargin,
    side,
    sideOk,
    intersectsExclusion: intersects,
  };

  if (!sideOk) {
    return {
      pass: false,
      reason: `offset-curve on the wrong side of the source (worst gap ${minMargin.toFixed(1)}px on '${side}')`,
      measured,
    };
  }
  if (minMargin < requiredMargin) {
    return {
      pass: false,
      reason: `offset-curve clearance ${minMargin.toFixed(1)}px < required ${requiredMargin}px (overlaps feature)`,
      measured,
    };
  }
  if (intersects) {
    return { pass: false, reason: 'offset-curve enters the exclusion region', measured };
  }
  if (outOfCanvas) {
    return { pass: false, reason: 'offset-curve runs off canvas', measured };
  }
  return { pass: true, measured };
}

function gateEdge(spec: Extract<GateSpec, { target: 'path'; kind: 'edge' }>): GateResult {
  const { curve, confidences, minConfidence, canvas } = spec;
  const minConf = confidences.length ? Math.min(...confidences) : 0;
  const outOfCanvas = curve.some((p) => !inCanvas(p, canvas));
  const measured: GateResult['measured'] = { minConfidence: minConf, required: minConfidence };
  if (confidences.length !== curve.length) {
    return {
      pass: false,
      reason: `confidence count ${confidences.length} != curve points ${curve.length}`,
      measured,
    };
  }
  if (minConf < minConfidence) {
    return {
      pass: false,
      reason: `edge confidence ${minConf} < required ${minConfidence} (weak/absent boundary)`,
      measured,
    };
  }
  if (outOfCanvas) {
    return { pass: false, reason: 'edge runs off canvas', measured };
  }
  return { pass: true, measured };
}

function gateCurve(spec: Extract<GateSpec, { target: 'path'; kind: 'curve' }>): GateResult {
  const { curve, canvas } = spec;
  const minLength = spec.minLength ?? 2;
  let length = 0;
  for (let k = 0; k < curve.length - 1; k++)
    length += Math.hypot(curve[k + 1].x - curve[k].x, curve[k + 1].y - curve[k].y);
  const outOfCanvas = curve.some((p) => !inCanvas(p, canvas));
  const measured: GateResult['measured'] = {
    points: curve.length,
    length: Math.round(length),
    on_canvas: !outOfCanvas,
  };
  if (curve.length < 2) return { pass: false, reason: 'curve has fewer than 2 points', measured };
  if (length < minLength)
    return {
      pass: false,
      reason: `curve length ${Math.round(length)} < required ${minLength} (degenerate)`,
      measured,
    };
  if (outOfCanvas) return { pass: false, reason: 'curve runs off canvas', measured };
  return { pass: true, measured };
}

function gateRegion(spec: Extract<GateSpec, { target: 'region' }>): GateResult {
  const { polygon, canvas } = spec;
  const maxFrac = spec.maxAreaFraction ?? 0.9;
  const area = polygonArea(polygon);
  const frameArea = canvas.width * canvas.height;
  const areaFraction = frameArea > 0 ? area / frameArea : 0;
  const b = polygon.length ? boundsOf(polygon) : undefined;
  const outOfCanvas = b
    ? b.left < 0 || b.top < 0 || b.right > canvas.width || b.bottom > canvas.height
    : true;
  const measured: GateResult['measured'] = {
    area: Math.round(area),
    areaFraction: Math.round(areaFraction * 1000) / 1000,
  };
  if (area <= 0) {
    return { pass: false, reason: 'empty region', measured };
  }
  if (outOfCanvas) {
    return { pass: false, reason: 'region extends off canvas', measured };
  }
  if (areaFraction > maxFrac) {
    return {
      pass: false,
      reason: `region ${(areaFraction * 100).toFixed(0)}% of frame — implausibly large for the relation`,
      measured,
    };
  }
  return { pass: true, measured };
}

/**
 * Run the internal geometric gate on a resolved placement. Fail-closed: returns
 * `{pass:false, reason, measured}` on any violated constraint, `{pass:true,
 * measured}` otherwise. Every feature in `measured` is computed here from the
 * geometry — the caller never hands the gate a pre-decided verdict.
 */
export function runGate(spec: GateSpec): GateResult {
  switch (spec.target) {
    case 'point':
      return gatePoint(spec);
    case 'region':
      return gateRegion(spec);
    case 'path':
      return spec.kind === 'offset-curve'
        ? gateOffsetCurve(spec)
        : spec.kind === 'edge'
          ? gateEdge(spec)
          : gateCurve(spec);
  }
}
