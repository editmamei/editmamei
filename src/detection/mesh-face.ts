/**
 * Shared mesh-face helpers — convert a detection result's faces into the
 * convenience shape the Pro face tools consume (box + mesh score + points), and
 * pick one by `which`. Used by ps_select_face_feature and
 * ps_stroke_face_contour so the face-selection semantics stay identical.
 */
import type { DetectedFace } from './detection-client.js';
import type { LandmarkPoint } from './detection-client.js';
import { orderBySpatialPick, type SpatialPick } from './geometry.js';

/** A detected face that carries a resolved mesh. */
export interface MeshFace {
  bbox: DetectedFace['bbox'];
  confidence: number;
  score: number;
  points: LandmarkPoint[];
}

/** Keep only faces with a resolved mesh, flattened to the convenience shape. */
export function meshFaces(faces: DetectedFace[]): MeshFace[] {
  const out: MeshFace[] = [];
  for (const f of faces) {
    if (f.features) {
      out.push({
        bbox: f.bbox,
        confidence: f.confidence,
        score: f.features.score,
        points: f.features.points,
      });
    }
  }
  return out;
}

const area = (f: MeshFace): number => (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]);

/**
 * Pick the target face by `which`: 'best' (highest mesh score, tie-break by
 * area), 'leftmost' / 'rightmost' / 'largest' (canonical picker — box CENTER-x
 * for leftmost/rightmost, area for largest; see detection/geometry.ts), or a
 * 0-based left-to-right index (by box left edge — the stable frame for an
 * index, independent of the spatial-pick convention). Returns undefined when
 * nothing resolves.
 */
export function pickFace(faces: MeshFace[], which: string): MeshFace | undefined {
  if (faces.length === 0) return undefined;
  const byLeft = [...faces].sort((a, b) => a.bbox[0] - b.bbox[0]);
  switch (which) {
    case 'best':
      return [...faces].sort((a, b) => b.score - a.score || area(b) - area(a))[0];
    case 'leftmost':
    case 'rightmost':
    case 'largest':
      // `which` is narrowed to one of these three literals by the case labels above;
      // TS can't see that through a raw `string` param, hence the assertion.
      return orderBySpatialPick(faces, which as SpatialPick)[0];
    default: {
      const idx = Number.parseInt(which, 10);
      if (String(idx) === which.trim() && idx >= 0 && idx < byLeft.length) return byLeft[idx];
      return undefined;
    }
  }
}
