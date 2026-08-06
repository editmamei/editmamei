/**
 * Relation RESOLVER — the middleware that turns a spatial spec
 * `{anchors, relation, params}` into exact document-pixel geometry (Phase 2/3 of
 * the spatial-grounding redesign, the differentiator). Pure closed-form
 * arithmetic over localized anchor primitives — NO model in the loop — so the
 * resolver contributes no error of its own (validated: report E4). Its output
 * feeds the internal gate (grounding-gate.ts) unchanged.
 *
 * The VLM never emits a pixel: it names anchors (localized by CV to primitives)
 * and picks a relation; this module produces the coordinate/curve/region.
 *
 * Scope (this slice): the pure-geometry relations — midpoint / centroid / offset
 * → point; along / offset-curve → path; inside / gap → region. Relations that
 * need image data or mask primitives (extremum, boolean, around-annulus) are
 * deferred to when the anchor palette provides masks.
 *
 * Units are RELATIVE by default (frac-diag / frac-of:<anchor>:<w|h|diag>), the
 * scale-robustness the VLM-pixel path lacked (report §1).
 */

import {
  type Point,
  type Polyline,
  type Box,
  type Side,
  boundsOf,
  dist,
} from './grounding-geometry.js';

/** A localized anchor: what the CV layer resolves a named anchor to. */
export type Primitive =
  | { kind: 'point'; point: Point }
  | { kind: 'box'; box: Box }
  | { kind: 'polyline'; polyline: Polyline };

/** Anchors by caller id (e.g. `{ eyeL: {...}, faceR: {...} }`). */
export type Anchors = Record<string, Primitive>;

/** A relative-by-default length. `unit` is 'px' | 'frac-diag' | 'frac-of:<ref>:<w|h|diag>'. */
export interface Length {
  value: number;
  unit: string;
}

/** 'up'|'down'|'left'|'right' | 'angle:<deg>' | 'toward:<ref>' | 'away:<ref>'. */
export type Direction = string;

export type Relation =
  | { type: 'midpoint'; anchors: [string, string]; t?: number }
  | { type: 'centroid'; anchor: string }
  | { type: 'offset'; from: string; direction: Direction; distance: Length }
  | { type: 'along'; curve: string; from?: number; to?: number }
  | { type: 'offset-curve'; curve: string; distance: Length; side: Side }
  | { type: 'segment'; anchors: [string, string] }
  | { type: 'inside'; anchor: string; inset?: Length }
  | { type: 'gap'; anchors: [string, string] };

export interface ResolveContext {
  frame: { width: number; height: number };
}

export type ResolvedGeometry =
  | { target: 'point'; point: Point }
  | { target: 'path'; kind: 'along'; curve: Polyline }
  | {
      target: 'path';
      kind: 'offset-curve';
      curve: Polyline;
      source: Polyline;
      side: Side;
      margin: number;
    }
  | { target: 'region'; polygon: Polyline };

// ---- primitive helpers ------------------------------------------------------

function need(anchors: Anchors, id: string): Primitive {
  const a = anchors[id];
  if (!a) throw new Error(`resolve: unknown anchor '${id}'`);
  return a;
}

/** Representative center point of a primitive (bbox center for box/polyline). */
export function centerOf(prim: Primitive): Point {
  if (prim.kind === 'point') return prim.point;
  const b = prim.kind === 'box' ? prim.box : boundsOf(prim.polyline);
  return { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 };
}

/** Bounding box of any primitive. */
export function bboxOf(prim: Primitive): Box {
  if (prim.kind === 'box') return prim.box;
  if (prim.kind === 'polyline') return boundsOf(prim.polyline);
  return { left: prim.point.x, top: prim.point.y, right: prim.point.x, bottom: prim.point.y };
}

/** A primitive as a curve — polyline directly; anything else is a structural mis-spec. */
function asCurve(prim: Primitive, id: string): Polyline {
  if (prim.kind !== 'polyline')
    throw new Error(`resolve: anchor '${id}' must be a polyline for this relation`);
  return prim.polyline;
}

function dimOf(prim: Primitive, dim: string): number {
  const b = bboxOf(prim);
  const w = b.right - b.left,
    h = b.bottom - b.top;
  if (dim === 'w') return w;
  if (dim === 'h') return h;
  if (dim === 'diag') return Math.hypot(w, h);
  throw new Error(`resolve: bad frac-of dimension '${dim}' (want w|h|diag)`);
}

/** Resolve a relative-or-absolute Length to pixels. */
export function resolveLength(len: Length, anchors: Anchors, frameDiag: number): number {
  if (len.unit === 'px') return len.value;
  if (len.unit === 'frac-diag') return len.value * frameDiag;
  if (len.unit.startsWith('frac-of:')) {
    const [, ref, dim] = len.unit.split(':');
    if (!ref || !dim)
      throw new Error(`resolve: malformed unit '${len.unit}' (want frac-of:<ref>:<w|h|diag>)`);
    return len.value * dimOf(need(anchors, ref), dim);
  }
  throw new Error(`resolve: unknown length unit '${len.unit}'`);
}

const AXIS: Record<Side, Point> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

/** Unit vector for a Direction, from `from` (needed for toward/away). */
function unitVector(direction: Direction, from: Point, anchors: Anchors): Point {
  if (direction in AXIS) return AXIS[direction as Side];
  const [kind, arg] = direction.split(':');
  if (kind === 'angle') {
    const r = (Number(arg) * Math.PI) / 180; // screen convention: 0=right, 90=down
    return { x: Math.cos(r), y: Math.sin(r) };
  }
  if (kind === 'toward' || kind === 'away') {
    const target = centerOf(need(anchors, arg));
    const v = { x: target.x - from.x, y: target.y - from.y };
    const m = Math.hypot(v.x, v.y) || 1;
    const u = { x: v.x / m, y: v.y / m };
    return kind === 'toward' ? u : { x: -u.x, y: -u.y };
  }
  throw new Error(`resolve: unknown direction '${direction}'`);
}

// ---- curve ops --------------------------------------------------------------

/** Sub-curve between fractional arc-length positions [from,to] (0..1), endpoints interpolated. */
export function trimByArcLength(curve: Polyline, from: number, to: number): Polyline {
  if (curve.length < 2 || (from <= 0 && to >= 1)) return curve;
  const segLen: number[] = [];
  let total = 0;
  for (let i = 0; i < curve.length - 1; i++) {
    const d = dist(curve[i], curve[i + 1]);
    segLen.push(d);
    total += d;
  }
  const startD = Math.max(0, from) * total,
    endD = Math.min(1, to) * total;
  const at = (target: number): Point => {
    let acc = 0;
    for (let i = 0; i < segLen.length; i++) {
      if (acc + segLen[i] >= target) {
        const t = segLen[i] === 0 ? 0 : (target - acc) / segLen[i];
        return {
          x: curve[i].x + t * (curve[i + 1].x - curve[i].x),
          y: curve[i].y + t * (curve[i + 1].y - curve[i].y),
        };
      }
      acc += segLen[i];
    }
    return curve[curve.length - 1];
  };
  const out: Polyline = [at(startD)];
  let acc = 0;
  for (let i = 0; i < curve.length; i++) {
    if (i > 0) acc += segLen[i - 1];
    if (acc > startD && acc < endD) out.push(curve[i]);
  }
  out.push(at(endD));
  return out;
}

const boxToPolygon = (b: Box): Polyline => [
  { x: b.left, y: b.top },
  { x: b.right, y: b.top },
  { x: b.right, y: b.bottom },
  { x: b.left, y: b.bottom },
];

// ---- the resolver -----------------------------------------------------------

/** Resolve a relation over localized anchors into exact geometry. Throws on a structural mis-spec. */
export function resolve(
  relation: Relation,
  anchors: Anchors,
  ctx: ResolveContext
): ResolvedGeometry {
  const frameDiag = Math.hypot(ctx.frame.width, ctx.frame.height);
  switch (relation.type) {
    case 'midpoint': {
      const a = centerOf(need(anchors, relation.anchors[0]));
      const b = centerOf(need(anchors, relation.anchors[1]));
      const t = relation.t ?? 0.5;
      return { target: 'point', point: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t } };
    }
    case 'centroid':
      return { target: 'point', point: centerOf(need(anchors, relation.anchor)) };
    case 'offset': {
      const from = centerOf(need(anchors, relation.from));
      const d = resolveLength(relation.distance, anchors, frameDiag);
      const u = unitVector(relation.direction, from, anchors);
      return { target: 'point', point: { x: from.x + u.x * d, y: from.y + u.y * d } };
    }
    case 'along': {
      const curve = asCurve(need(anchors, relation.curve), relation.curve);
      return {
        target: 'path',
        kind: 'along',
        curve: trimByArcLength(curve, relation.from ?? 0, relation.to ?? 1),
      };
    }
    case 'offset-curve': {
      const source = asCurve(need(anchors, relation.curve), relation.curve);
      const d = resolveLength(relation.distance, anchors, frameDiag);
      const u = AXIS[relation.side];
      const curve = source.map((p) => ({ x: p.x + u.x * d, y: p.y + u.y * d }));
      return {
        target: 'path',
        kind: 'offset-curve',
        curve,
        source,
        side: relation.side,
        margin: d,
      };
    }
    case 'segment': {
      // A straight path BETWEEN two anchors (each reduced to its center) — the
      // path analog of `midpoint`. A trivial 2-point 'along' curve, so the gate's
      // on-canvas path check applies unchanged. Feeds a line (ps_shape) or a
      // stroke (ps_apply_brush_stroke) between the two named things.
      const a = centerOf(need(anchors, relation.anchors[0]));
      const b = centerOf(need(anchors, relation.anchors[1]));
      return { target: 'path', kind: 'along', curve: [a, b] };
    }
    case 'inside': {
      const bb = bboxOf(need(anchors, relation.anchor));
      const inset = relation.inset ? resolveLength(relation.inset, anchors, frameDiag) : 0;
      return {
        target: 'region',
        polygon: boxToPolygon({
          left: bb.left + inset,
          top: bb.top + inset,
          right: bb.right - inset,
          bottom: bb.bottom - inset,
        }),
      };
    }
    case 'gap': {
      const a = bboxOf(need(anchors, relation.anchors[0]));
      const b = bboxOf(need(anchors, relation.anchors[1]));
      // gap along whichever axis the two boxes are separated on
      const [l, r] = a.right <= b.left ? [a, b] : [b, a]; // horizontal order
      if (l.right < r.left) {
        return {
          target: 'region',
          polygon: boxToPolygon({
            left: l.right,
            right: r.left,
            top: Math.max(a.top, b.top),
            bottom: Math.min(a.bottom, b.bottom),
          }),
        };
      }
      const [t, bot] = a.bottom <= b.top ? [a, b] : [b, a]; // vertical order
      if (t.bottom < bot.top) {
        return {
          target: 'region',
          polygon: boxToPolygon({
            top: t.bottom,
            bottom: bot.top,
            left: Math.max(a.left, b.left),
            right: Math.min(a.right, b.right),
          }),
        };
      }
      // overlapping → empty region (the gate rejects it, which is the right answer)
      return { target: 'region', polygon: [] };
    }
  }
}
