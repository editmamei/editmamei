/**
 * Anchor adapter — bridges local CV detection to the resolver's anchor
 * primitives. This is what makes the grounding spine reachable from real
 * `ps_detect` output: face/object boxes (document pixels via mapDetectionToDoc)
 * become the `{kind:'box'}` primitives the resolver composes.
 *
 * A selector picks WHICH instance among same-class candidates. Beyond a raw
 * index it supports the spatial/size picks the identification probe validated
 * (report E7: leftmost/rightmost/largest/… bound 11/11 via Set-of-Mark) — so the
 * "which one?" step the architecture is named for has a deterministic
 * implementation for the common referents. Attribute/semantic referring ("the
 * man in glasses") stays out of scope here (report §6, gates Phase 4).
 *
 * `localizeAnchors` surfaces any MISSING anchor rather than silently dropping it,
 * because a missing anchor stalls the whole resolve chain (report E3 recall).
 */

import type { DetectionResult, BBox } from '../detection/detection-client.js';
import { orderBySpatialPick, type SpatialPick } from '../detection/geometry.js';
import type { Box } from './grounding-geometry.js';
import type { Primitive, Anchors } from './grounding-resolver.js';

export function bboxToBox(b: BBox): Box {
  return { left: b[0], top: b[1], right: b[2], bottom: b[3] };
}

/** How to break ties among same-class candidates. `confidence` = detection order (default). */
export type Pick = 'confidence' | SpatialPick;

export type AnchorSelector =
  | { kind: 'face'; instance?: number; pick?: Pick }
  | { kind: 'object'; label: string; instance?: number; pick?: Pick };

interface Candidate {
  bbox: BBox;
}

/**
 * Order candidates by the pick criterion (a copy; `confidence` keeps detection
 * order). The spatial/size picks delegate to the canonical picker in
 * detection/geometry.ts — this module owns only `confidence`'s detection-order
 * tie-break, which is specific to the anchor-localization use case.
 */
function orderBy<T extends Candidate>(items: T[], pick: Pick): T[] {
  return pick === 'confidence' ? items : orderBySpatialPick(items, pick);
}

/** Localize one anchor selector to a box primitive, or null if no such instance. */
export function localizeAnchor(det: DetectionResult, sel: AnchorSelector): Primitive | null {
  const candidates: Candidate[] =
    sel.kind === 'face'
      ? (det.faces ?? []).map((f) => ({ bbox: f.bbox }))
      : (det.objects ?? []).filter((o) => o.label === sel.label).map((o) => ({ bbox: o.bbox }));
  const ordered = orderBy(candidates, sel.pick ?? 'confidence');
  const c = ordered[sel.instance ?? 0];
  return c ? { kind: 'box', box: bboxToBox(c.bbox) } : null;
}

/**
 * Localize a whole anchor map. Returns the resolved anchors plus the ids that had
 * no matching detection — the caller MUST check `missing` before resolving,
 * because a missing anchor stalls the chain (report E3: cross-scale recall).
 */
export function localizeAnchors(
  det: DetectionResult,
  selectors: Record<string, AnchorSelector>
): { anchors: Anchors; missing: string[] } {
  const anchors: Anchors = {};
  const missing: string[] = [];
  for (const [id, sel] of Object.entries(selectors)) {
    const prim = localizeAnchor(det, sel);
    if (prim) anchors[id] = prim;
    else missing.push(id);
  }
  return { anchors, missing };
}
