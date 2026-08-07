/**
 * Computed grid anchors — the cheapest classical-CV anchor (pure arithmetic, no
 * pixels). The VLM names a compositional position ("the upper-left third", "the
 * centre") and this yields the point, relative to the frame OR any anchor box
 * ("the upper third of the sky region"). Feeds the resolver as a point primitive.
 *
 * The 3×3 names map to the rule-of-thirds grid: columns left/center/right =
 * 1/3, 1/2, 2/3 of the box; rows upper/center/lower = 1/3, 1/2, 2/3. The four
 * corner names are the classic rule-of-thirds power points. `frac:x,y` gives an
 * arbitrary fractional position.
 */

import type { Point, Box } from './grounding-geometry.js';
import type { Primitive } from './grounding-resolver.js';

const NAMED: Record<string, [number, number]> = {
  center: [0.5, 0.5],
  'upper-left': [1 / 3, 1 / 3],
  'upper-center': [0.5, 1 / 3],
  'upper-right': [2 / 3, 1 / 3],
  'center-left': [1 / 3, 0.5],
  'center-right': [2 / 3, 0.5],
  'lower-left': [1 / 3, 2 / 3],
  'lower-center': [0.5, 2 / 3],
  'lower-right': [2 / 3, 2 / 3],
};

/** The full frame as a Box (the default reference for grid positions). */
export function frameBox(width: number, height: number): Box {
  return { left: 0, top: 0, right: width, bottom: height };
}

/** A named ('center', 'upper-left', …) or 'frac:fx,fy' position within a box. */
export function gridPoint(box: Box, name: string): Point {
  let fx: number, fy: number;
  if (name.startsWith('frac:')) {
    const [a, b] = name.slice('frac:'.length).split(',');
    fx = Number(a);
    fy = Number(b);
    if (Number.isNaN(fx) || Number.isNaN(fy))
      throw new Error(`gridPoint: malformed '${name}' (want frac:fx,fy)`);
  } else {
    const f = NAMED[name];
    if (!f)
      throw new Error(
        `gridPoint: unknown position '${name}' (want ${Object.keys(NAMED).join('|')} or frac:fx,fy)`
      );
    [fx, fy] = f;
  }
  return { x: box.left + fx * (box.right - box.left), y: box.top + fy * (box.bottom - box.top) };
}

/** The grid position as a resolver anchor primitive. */
export function gridAnchor(box: Box, name: string): Primitive {
  return { kind: 'point', point: gridPoint(box, name) };
}
