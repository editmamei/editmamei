import { describe, it, expect } from 'vitest';
import { frameBox, gridPoint, gridAnchor } from '@editmamei/perception/grounding-grid.ts';

// Computed grid anchors — pure arithmetic, no pixels.

describe('grounding-grid', () => {
  const frame = frameBox(900, 600);

  it('frameBox wraps dimensions', () => {
    expect(frame).toEqual({ left: 0, top: 0, right: 900, bottom: 600 });
  });

  it('named rule-of-thirds positions', () => {
    expect(gridPoint(frame, 'center')).toEqual({ x: 450, y: 300 });
    expect(gridPoint(frame, 'upper-left')).toEqual({ x: 300, y: 200 });
    expect(gridPoint(frame, 'lower-right')).toEqual({ x: 600, y: 400 });
    expect(gridPoint(frame, 'upper-center')).toEqual({ x: 450, y: 200 });
  });

  it('frac:x,y arbitrary position', () => {
    expect(gridPoint(frame, 'frac:0.25,0.75')).toEqual({ x: 225, y: 450 });
  });

  it('positions are relative to any box (e.g. a subject region)', () => {
    const sub = { left: 100, top: 100, right: 400, bottom: 400 };
    expect(gridPoint(sub, 'center')).toEqual({ x: 250, y: 250 });
    expect(gridPoint(sub, 'upper-left')).toEqual({ x: 200, y: 200 });
  });

  it('gridAnchor returns a resolver point primitive', () => {
    expect(gridAnchor(frame, 'center')).toEqual({ kind: 'point', point: { x: 450, y: 300 } });
  });

  it('throws on unknown name or malformed frac', () => {
    expect(() => gridPoint(frame, 'nowhere')).toThrow(/unknown position/);
    expect(() => gridPoint(frame, 'frac:a,b')).toThrow(/malformed/);
  });
});
