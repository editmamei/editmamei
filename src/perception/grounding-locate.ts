/**
 * Shared resolve→localize→gate FRONT-END for the spatial-grounding tools.
 *
 * This is the middleware `ps_resolve_placement` (the read-only locator) and any
 * ACTING tool (e.g. `ps_shape` placement) both run: export the active doc, detect,
 * localize each named anchor to a document-pixel primitive, resolve the relation
 * to geometry, and run the objective internal gate. It returns the geometry + the
 * gate verdict + the export image (for a review crop); the caller decides what to
 * do with it — render a crop, or bake the coordinate into a shape.
 *
 * Extracted from grounding-tools.ts so "name the intent, don't guess a pixel" can
 * be the front-end of the precision tools, not just a separate locator. Pure
 * pipeline: detection (fake-injectable), classical-CV producers, the closed-form
 * resolver, and the fail-closed gate — no acting on the document here.
 */
import { PhotoshopConnection } from '../platform/connection.js';
import { ValidationError, type JsonSchemaObject } from '../utils/validate.js';
import { detectActiveDoc } from '../detection/detect-active-doc.js';
import { type DetectionClient, type DetectionResult } from '../detection/detection-client.js';
import { localizeAnchor } from './grounding-anchors.js';
import {
  landmarkAnchor,
  isLandmarkFeature,
  LANDMARK_FEATURE_NAMES,
} from './grounding-landmarks.js';
import { gridAnchor, frameBox } from './grounding-grid.js';
import { findExtremum, type ExtremumMeasure } from './grounding-extrema.js';
import { cornerAnchor } from './grounding-corners.js';
import { traceEdge, type EdgeOrientation } from './grounding-edge-trace.js';
import {
  resolve,
  centerOf,
  type Anchors,
  type Primitive,
  type Relation,
  type ResolvedGeometry,
} from './grounding-resolver.js';
import { runGate, type GateSpec, type GateResult } from './grounding-gate.js';
import { boundsOf, type Region, type Box, type Point } from './grounding-geometry.js';
import type { RgbaImage } from './grounding-review-crop.js';

const POINT_RELATIONS = ['midpoint', 'centroid', 'offset'];
const REGION_RELATIONS = ['inside', 'gap'];
const PATH_RELATIONS = ['along', 'offset-curve', 'segment'];
/** The relations the resolver supports today (pure geometry — no mask primitives yet). */
export const SUPPORTED_RELATIONS = [...POINT_RELATIONS, ...REGION_RELATIONS, ...PATH_RELATIONS];
/** Default minimum edge-confidence (luma band-Δ) for a traced edge to be trusted (report E1). */
const DEFAULT_MIN_EDGE_CONFIDENCE = 40;

/** Raised for an EXPECTED localize/resolve failure (anchor not found, degenerate spec) —
 *  distinct from a structural `ValidationError`. Callers surface `.message` directly. */
export class LocateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocateError';
  }
}

interface AnchorSpec {
  id: string;
  kind: string;
  [k: string]: unknown;
}

export interface LocateInput {
  anchors: unknown;
  relation: unknown;
  maxDimension?: number;
  /**
   * Optional post-processor applied to a resolved PATH's curve BEFORE the gate runs,
   * so the gate verifies the curve that will actually be enacted (gate == enact).
   * The one consumer today is `ps_warp_layer_along`, which smooths the curve before
   * warping — without this the gate would verify the raw curve and the tool would
   * warp a different (smoothed) one. Ignored for non-path geometry.
   */
  pathTransform?: (curve: Point[]) => Point[];
}

export interface LocateResult {
  geom: ResolvedGeometry;
  gate: GateResult;
  /** id → {kind, center} of each localized anchor. */
  anchorMeta: Record<string, { kind: string; center: Point }>;
  /** getContextInfo() snapshot from the export. */
  context: Record<string, unknown> | undefined;
  /** Decoded export image (null when the export produced no bytes) — for a review crop. */
  exportImg: RgbaImage | null;
  docW: number;
  docH: number;
  /** Export/document scale (exportImg.width / docW); 1 when there is no export image. */
  s: number;
}

const scaleBox = (b: Box, s: number): Box => ({
  left: b.left * s,
  top: b.top * s,
  right: b.right * s,
  bottom: b.bottom * s,
});
const liftPt = (p: Point, s: number): Point => ({ x: p.x / s, y: p.y / s });

export function parseBox(v: unknown, name: string): Box {
  if (!Array.isArray(v) || v.length !== 4 || v.some((n) => !Number.isFinite(n))) {
    throw new ValidationError(`${name} must be [x1,y1,x2,y2] finite numbers in document pixels`);
  }
  const [x1, y1, x2, y2] = v as number[];
  return {
    left: Math.min(x1, x2),
    top: Math.min(y1, y2),
    right: Math.max(x1, x2),
    bottom: Math.max(y1, y2),
  };
}

/** Localize one anchor spec to a document-pixel primitive (null = not found). */
function localizeOne(
  a: AnchorSpec,
  det: DetectionResult,
  exportImg: RgbaImage | null,
  docW: number,
  docH: number,
  s: number,
  confSink: Record<string, number[]>
): Primitive | null {
  const needsImage = (): RgbaImage => {
    if (!exportImg)
      throw new ValidationError(
        `anchor '${a.id}' (${a.kind}) needs the document image, which failed to export`
      );
    return exportImg;
  };
  switch (a.kind) {
    case 'face':
      return localizeAnchor(det, {
        kind: 'face',
        instance: a.instance as number | undefined,
        pick: a.pick as never,
      });
    case 'object': {
      if (typeof a.label !== 'string')
        throw new ValidationError(`object anchor '${a.id}' needs a 'label'`);
      return localizeAnchor(det, {
        kind: 'object',
        label: a.label,
        instance: a.instance as number | undefined,
        pick: a.pick as never,
      });
    }
    case 'grid': {
      if (typeof a.at !== 'string') throw new ValidationError(`grid anchor '${a.id}' needs 'at'`);
      return gridAnchor(frameBox(docW, docH), a.at);
    }
    case 'extremum': {
      const measure = a.measure as string;
      if (!['brightest', 'darkest', 'most-saturated'].includes(measure)) {
        throw new ValidationError(
          `extremum anchor '${a.id}' needs measure brightest|darkest|most-saturated`
        );
      }
      const region = a.region
        ? scaleBox(parseBox(a.region, `${a.id}.region`), s)
        : frameBox(needsImage().width, needsImage().height);
      const e = findExtremum(needsImage(), region, measure as ExtremumMeasure);
      return { kind: 'point', point: liftPt(e.point, s) };
    }
    case 'corner': {
      if (!a.region)
        throw new ValidationError(`corner anchor '${a.id}' needs a 'region' [x1,y1,x2,y2]`);
      const region = scaleBox(parseBox(a.region, `${a.id}.region`), s);
      let near: Point | undefined;
      if (a.near) {
        if (
          !Array.isArray(a.near) ||
          a.near.length !== 2 ||
          !a.near.every((n) => Number.isFinite(n))
        )
          throw new ValidationError(`${a.id}.near must be [x,y] finite numbers`);
        near = { x: (a.near[0] as number) * s, y: (a.near[1] as number) * s };
      }
      const c = cornerAnchor(needsImage(), region, { near });
      return c && c.kind === 'point' ? { kind: 'point', point: liftPt(c.point, s) } : null;
    }
    case 'edge': {
      const orientation = a.orientation as string;
      if (orientation !== 'horizontal-edge' && orientation !== 'vertical-edge') {
        throw new ValidationError(
          `edge anchor '${a.id}' needs orientation horizontal-edge|vertical-edge`
        );
      }
      if (!a.region)
        throw new ValidationError(`edge anchor '${a.id}' needs a 'region' [x1,y1,x2,y2]`);
      const region = scaleBox(parseBox(a.region, `${a.id}.region`), s);
      const t = traceEdge(needsImage(), {
        region,
        orientation: orientation as EdgeOrientation,
        samples: typeof a.samples === 'number' ? a.samples : undefined,
      });
      if (t.polyline.length < 2) return null; // couldn't trace a boundary
      confSink[a.id] = t.confidences;
      return { kind: 'polyline', polyline: t.polyline.map((p) => liftPt(p, s)) };
    }
    case 'landmark': {
      // The mesh (with corrected eyes) is lifted to DOCUMENT pixels by
      // detectActiveDoc, so a landmark primitive is already doc-space — no scale.
      if (typeof a.feature !== 'string')
        throw new ValidationError(
          `landmark anchor '${a.id}' needs a 'feature' (one of: ${LANDMARK_FEATURE_NAMES.join(', ')})`
        );
      if (!isLandmarkFeature(a.feature))
        throw new ValidationError(
          `landmark anchor '${a.id}' feature '${a.feature}' unknown — use one of: ${LANDMARK_FEATURE_NAMES.join(', ')}`
        );
      return landmarkAnchor(det, {
        feature: a.feature,
        face: typeof a.face === 'number' ? a.face : undefined,
      });
    }
    default:
      throw new ValidationError(
        `unknown anchor kind '${a.kind}' (want face|object|grid|extremum|corner|edge|landmark)`
      );
  }
}

/** Read an optional exclusion region [x1,y1,x2,y2] (doc px) off a relation. */
function parseExclusion(relation: Relation & { exclusion?: unknown }): Region | undefined {
  if (!relation.exclusion) return undefined;
  return { kind: 'box', box: parseBox(relation.exclusion, 'exclusion') };
}

/**
 * Run the internal gate on the resolved geometry. point/region use the geometric
 * gate directly; path relations (along/offset-curve over an edge) FIRST gate the
 * source edge's confidence (is the traced boundary real — report E1) and, for
 * offset-curve, also check the offset lies on the requested side and clears any
 * exclusion. `confSink` holds each edge anchor's per-point confidences.
 */
function gateResolved(
  geom: ResolvedGeometry,
  relation: Relation & { curve?: string; exclusion?: unknown; min_confidence?: number },
  anchors: Anchors,
  confSink: Record<string, number[]>,
  anchorKinds: Record<string, string>,
  docW: number,
  docH: number
): GateResult {
  const canvas = { width: docW, height: docH };
  if (geom.target === 'region') return runGate({ target: 'region', polygon: geom.polygon, canvas });
  if (geom.target === 'point') {
    const spec: GateSpec = { target: 'point', point: geom.point, canvas };
    if (relation.type === 'midpoint') {
      spec.anchors = [
        centerOf(anchors[relation.anchors[0]]),
        centerOf(anchors[relation.anchors[1]]),
      ];
    }
    return runGate(spec);
  }
  // path (along | offset-curve) over an EDGE (classical-CV trace) or a LANDMARK
  // (trusted mesh curve). An edge must FIRST clear the per-point confidence gate
  // (is the boundary real — report E1); a landmark curve has no per-point Δ, so
  // that gate is skipped — the mesh IS the trusted source.
  const srcId = relation.curve ?? '';
  const srcPrim = anchors[srcId];
  const srcCurve = srcPrim && srcPrim.kind === 'polyline' ? srcPrim.polyline : [];
  let edgeMeasured: GateResult['measured'] = {};
  if (anchorKinds[srcId] === 'edge') {
    const minConf =
      typeof relation.min_confidence === 'number'
        ? relation.min_confidence
        : DEFAULT_MIN_EDGE_CONFIDENCE;
    const edgeGate = runGate({
      target: 'path',
      kind: 'edge',
      curve: srcCurve,
      confidences: confSink[srcId] ?? [],
      minConfidence: minConf,
      canvas,
    });
    if (!edgeGate.pass) return edgeGate;
    edgeMeasured = edgeGate.measured;
  }

  if (geom.kind === 'along') {
    // trusted/verified curve; ensure the (possibly trimmed) path stays on canvas.
    const off = geom.curve.some((p) => p.x < 0 || p.y < 0 || p.x > docW || p.y > docH);
    const measured = {
      ...edgeMeasured,
      source: anchorKinds[srcId] ?? 'unknown',
      points: geom.curve.length,
    };
    return off
      ? { pass: false, reason: 'path runs off canvas', measured }
      : { pass: true, measured };
  }

  // offset-curve: verify the offset lies on the requested side, clears the margin,
  // and misses any exclusion region (e.g. the eye) — this is the under-eye check.
  const ocGate = runGate({
    target: 'path',
    kind: 'offset-curve',
    curve: geom.curve,
    source: geom.source,
    side: geom.side,
    requiredMargin: 1,
    exclusion: parseExclusion(relation),
    canvas,
  });
  return {
    pass: ocGate.pass,
    ...(ocGate.pass ? {} : { reason: ocGate.reason }),
    measured: { ...edgeMeasured, ...ocGate.measured },
  };
}

/**
 * The shared pipeline: export + detect the active doc, localize every named anchor
 * to a document-pixel primitive, resolve the relation to geometry, and run the
 * objective gate. Returns the geometry + gate + the export image for a review crop.
 *
 * Throws `ValidationError` for a structural mis-spec (bad anchors/relation shape,
 * unknown anchor kind) and `LocateError` for an expected failure (an anchor the CV
 * couldn't find, or a relation that couldn't be resolved). Does NOT touch the
 * document — acting on the geometry is the caller's job.
 */
export async function resolveToGeometry(
  connection: PhotoshopConnection,
  client: DetectionClient,
  input: LocateInput
): Promise<LocateResult> {
  const anchorSpecs = input.anchors as AnchorSpec[];
  const relation = input.relation as Relation & { type: string };
  if (!Array.isArray(anchorSpecs) || anchorSpecs.length === 0)
    throw new ValidationError('anchors must be a non-empty array');
  if (!relation || typeof relation !== 'object' || typeof relation.type !== 'string')
    throw new ValidationError('relation must be an object with a "type"');
  if (!SUPPORTED_RELATIONS.includes(relation.type)) {
    throw new ValidationError(
      `relation "${relation.type}" not supported yet — use ${SUPPORTED_RELATIONS.join(' | ')}`
    );
  }
  for (const a of anchorSpecs)
    if (typeof a?.id !== 'string' || typeof a?.kind !== 'string')
      throw new ValidationError('each anchor needs a string "id" and "kind"');

  // Export + detect (faces/objects only if an anchor needs them). A landmark
  // anchor needs the face mesh, so it requests faces too.
  const needFaces = anchorSpecs.some((a) => a.kind === 'face' || a.kind === 'landmark');
  const needObjects = anchorSpecs.some((a) => a.kind === 'object');
  const det = await detectActiveDoc(connection, client, {
    faces: needFaces,
    objects: needObjects,
    maxDimension: input.maxDimension,
  });
  const docW = det.docWidth;
  const docH = det.docHeight;
  // Already decoded once by detectActiveDoc (perf-audit H4) — no re-decode here.
  const exportImg: RgbaImage | null = det.decoded ?? null;
  const s = exportImg ? exportImg.width / docW : 1;

  // Localize anchors → document-pixel primitives (edge anchors also stash their
  // per-point confidences in confSink for the path gate).
  const anchors: Anchors = {};
  const anchorMeta: Record<string, { kind: string; center: Point }> = {};
  const confSink: Record<string, number[]> = {};
  const missing: string[] = [];
  for (const a of anchorSpecs) {
    const prim = localizeOne(a, det.result, exportImg, docW, docH, s, confSink);
    if (prim) {
      anchors[a.id] = prim;
      anchorMeta[a.id] = { kind: a.kind, center: centerOf(prim) };
    } else missing.push(`${a.id} (${a.kind})`);
  }
  if (missing.length > 0) {
    throw new LocateError(
      `Could not localize anchor(s): ${missing.join(', ')}. ` +
        `Detection found ${det.result.faces?.length ?? 0} face(s), ${det.result.objects?.length ?? 0} object(s). ` +
        `Try ps_detect to see what's present, or loosen the selector.`
    );
  }

  // Resolve + gate (document pixels).
  let geom: ResolvedGeometry;
  try {
    geom = resolve(relation as Relation, anchors, { frame: { width: docW, height: docH } });
  } catch (e) {
    throw new LocateError(`Could not resolve the relation: ${(e as Error).message}`);
  }
  // Apply the caller's path post-processor (e.g. warp-along smoothing) BEFORE gating,
  // so the gate verifies the enacted curve, not the raw resolved one. Path geom only;
  // a degenerate (<2 point) transform result is ignored (the raw curve still gates).
  if (input.pathTransform && geom.target === 'path') {
    const transformed = input.pathTransform(geom.curve);
    if (Array.isArray(transformed) && transformed.length >= 2) {
      geom = { ...geom, curve: transformed };
    }
  }
  const anchorKinds = Object.fromEntries(Object.entries(anchorMeta).map(([id, m]) => [id, m.kind]));
  const gate = gateResolved(geom, relation as Relation, anchors, confSink, anchorKinds, docW, docH);

  return { geom, gate, anchorMeta, context: det.context, exportImg, docW, docH, s };
}

// ── Reusable `placement` surface for ACTING tools ────────────────────────────
// ps_shape / ps_crop_document / ps_guides / ps_transform_layer all take the same
// anchor-relational `placement` input and bake the resolved+gated geometry into
// their own params. The schema fragment + the target-enforcing resolver below are
// the single source for that contract, so the four consumers can't drift.

/** The reusable `placement` input sub-schema. Spread into a tool's inputSchema;
 *  override `description` per tool to name the relation kind it needs. */
export const PLACEMENT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  description:
    'ANCHOR-RELATIONAL placement (preferred over guessing pixels): name anchors + a relation and the ' +
    'spatial-grounding resolver computes the geometry, verified by an objective gate; the action runs ONLY if the ' +
    'gate PASSES. For a HARD or ambiguous placement, first concur on ps_resolve_placement (review_crop: true) — a ' +
    'read-only zoomed crop with a marker at the resolved spot — then pass the SAME anchors + relation here. See ' +
    'ps_resolve_placement for the full anchors + relation vocabulary.',
  properties: {
    anchors: {
      type: 'array',
      description:
        'Named anchors, same vocabulary as ps_resolve_placement (face/object/grid/extremum/corner/edge/landmark).',
    },
    relation: {
      type: 'object',
      description: 'The relation, same vocabulary as ps_resolve_placement.',
    },
    max_dimension: {
      type: 'number',
      minimum: 256,
      maximum: 4096,
      description: 'Long-edge px of the export the CV runs on (default 1024).',
    },
  },
};

/** The resolved+gated placement geometry, rounded to document pixels, for a
 *  consuming tool to bake into its own params. Discriminated on `target`. */
interface PlacementBase {
  /** id → {kind, center} of each localized anchor (for the tool's structured echo). */
  anchors: Record<string, { kind: string; center: Point }>;
  /** Human-readable coordinate summary for the tool's result text. */
  summary: string;
}
export type ResolvedPlacement =
  | (PlacementBase & { target: 'point'; point: { x: number; y: number } })
  | (PlacementBase & {
      target: 'region';
      bbox: { left: number; top: number; right: number; bottom: number };
    })
  | (PlacementBase & { target: 'path'; curve: { x: number; y: number }[] });

const EXPECT_HINT: Record<ResolvedPlacement['target'], string> = {
  point: 'Use a point relation (centroid / midpoint / offset).',
  region: 'Use a region relation (inside / gap).',
  path: 'Use a path relation (along / offset-curve).',
};

/**
 * The shared front-end EVERY acting tool runs: resolve a `placement`, ENFORCE the
 * gate PASSED, and ENFORCE the resolved target is one the caller can consume,
 * throwing the standard `LocateError` (fail-closed) on either. Returns the FULL
 * `LocateResult` — UNROUNDED geometry + gate + the getContextInfo snapshot — so a
 * tool that needs the raw point/curve AND the active-layer bounds (the warp trio)
 * shares this exact gate/target enforcement instead of re-implementing it. An
 * optional `pathTransform` (e.g. warp-along's smoothing) is applied to a resolved
 * PATH before the gate, so the gate verifies the enacted curve (gate == enact).
 *
 * `expect` is one target or a list (e.g. `['point','region']` for a tool that
 * accepts either); the generic narrows the returned `geom` to those target(s).
 * `label` names the action for the message ('crop', 'guide', 'warp-along', …).
 */
export async function resolveGatedPlacement<E extends ResolvedGeometry['target']>(
  connection: PhotoshopConnection,
  client: DetectionClient,
  placement: unknown,
  opts: {
    expect: E | E[];
    label: string;
    pathTransform?: (curve: Point[]) => Point[];
  }
): Promise<LocateResult & { geom: Extract<ResolvedGeometry, { target: E }> }> {
  const p = (placement ?? {}) as { anchors?: unknown; relation?: unknown; max_dimension?: number };
  const loc = await resolveToGeometry(connection, client, {
    anchors: p.anchors,
    relation: p.relation,
    maxDimension: p.max_dimension,
    pathTransform: opts.pathTransform,
  });
  if (!loc.gate.pass) {
    throw new LocateError(
      `Placement gate REJECT — ${loc.gate.reason ?? 'failed verification'}. No ${opts.label} performed; re-spec the anchors/relation.`
    );
  }
  const expects = (
    Array.isArray(opts.expect) ? opts.expect : [opts.expect]
  ) as ResolvedGeometry['target'][];
  if (!expects.includes(loc.geom.target)) {
    const want = expects.join(' or ');
    const hint = expects.map((e) => EXPECT_HINT[e]).join(' ');
    throw new LocateError(
      `${opts.label} placement needs a ${want} relation — resolved a '${loc.geom.target}'. ${hint}`
    );
  }
  return loc as LocateResult & { geom: Extract<ResolvedGeometry, { target: E }> };
}

/**
 * Resolve + gate a `placement`, enforce a SINGLE target kind, and return the
 * ROUNDED document-pixel geometry shaped for a consumer (point / region bbox /
 * curve). A thin convenience over `resolveGatedPlacement` for tools that only need
 * the coordinate (ps_shape / ps_crop_document / ps_guides / ps_transform_layer /
 * ps_retouch). Throws `LocateError` on a gate REJECT or target mismatch.
 */
export async function resolveExpectedPlacement<E extends ResolvedPlacement['target']>(
  connection: PhotoshopConnection,
  client: DetectionClient,
  placement: unknown,
  expect: E,
  label: string
): Promise<Extract<ResolvedPlacement, { target: E }>> {
  const gated = await resolveGatedPlacement(connection, client, placement, { expect, label });
  // Widen back to the full union so the target branches narrow cleanly below.
  const g: ResolvedGeometry = gated.geom;
  const anchors = gated.anchorMeta;
  let out: ResolvedPlacement;
  if (g.target === 'point') {
    const point = { x: Math.round(g.point.x), y: Math.round(g.point.y) };
    out = { target: 'point', point, anchors, summary: `(${point.x},${point.y})` };
  } else if (g.target === 'region') {
    const b = boundsOf(g.polygon);
    const bbox = {
      left: Math.round(b.left),
      top: Math.round(b.top),
      right: Math.round(b.right),
      bottom: Math.round(b.bottom),
    };
    out = {
      target: 'region',
      bbox,
      anchors,
      summary: `[${bbox.left},${bbox.top},${bbox.right},${bbox.bottom}]`,
    };
  } else {
    if (g.curve.length < 2) {
      throw new LocateError(`${label} placement resolved to a degenerate (<2 point) curve.`);
    }
    const curve = g.curve.map((pt) => ({ x: Math.round(pt.x), y: Math.round(pt.y) }));
    out = { target: 'path', curve, anchors, summary: `${curve.length}-point path` };
  }
  // Sound by resolveGatedPlacement's target enforcement: out.target === expect === E.
  return out as Extract<ResolvedPlacement, { target: E }>;
}
