/**
 * Snippet-vs-spec test for the Lens Blur full rewrite (2026-06-04
 * Bundle 3). Pins the entire Bk-Bt-Be charID family (Bokeh key,
 * Bokeh type, Bokeh enum) against the pre-audit forum-lore stringIDs.
 *
 * Spec: src/spec/ps27/filters/lens-blur.ts
 * Capture: JS-22-Lens-Blur.log
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { extractCalledTypeIDs, goBuild, goCoreBinaryAvailable } from './_helpers.ts';

describe.skipIf(!goCoreBinaryAvailable)('spec: filters/lens-blur', () => {
  let jsx: string;
  let ids: Set<string>;

  beforeAll(async () => {
    jsx = await goBuild('applyLensBlur', {
      radius: 25,
      irisShape: 'hexagon',
      irisBladeCurvature: 13,
      irisRotation: 43,
      specularBrightness: 20,
      specularThreshold: 176,
      noiseAmount: 0,
      noiseDistribution: 'uniform',
      noiseMonochromatic: false,
      depthSource: 'none',
      focalDistance: 0,
      invertDepth: false,
    });
    ids = extractCalledTypeIDs(jsx);
  });

  it('dispatches the Bokh event (charID), not the forum-lore lensBlur stringID', () => {
    expect(ids.has('Bokh')).toBe(true);
    expect(ids.has('lensBlur')).toBe(false);
  });

  it('emits the depth group (BkDi/BkDc/BkDp/BkDs) with the captured defaults', () => {
    expect(ids.has('BkDi')).toBe(true);
    expect(ids.has('BtDi')).toBe(true);
    expect(ids.has('BeIt')).toBe(true);
    expect(ids.has('BkDc')).toBe(true);
    expect(ids.has('BtDc')).toBe(true);
    expect(ids.has('BeCm')).toBe(true);
    expect(ids.has('BkDp')).toBe(true);
    expect(ids.has('BkDs')).toBe(true);
  });

  it('emits the iris group with BeS6 for hexagon', () => {
    expect(ids.has('BkIs')).toBe(true);
    expect(ids.has('BtIs')).toBe(true);
    expect(ids.has('BeS6')).toBe(true);
    expect(ids.has('BkIb')).toBe(true);
    expect(ids.has('BkIc')).toBe(true);
    expect(ids.has('BkIr')).toBe(true);
  });

  it('emits the specular + noise groups', () => {
    expect(ids.has('BkSb')).toBe(true);
    expect(ids.has('BkSt')).toBe(true);
    expect(ids.has('BkNa')).toBe(true);
    expect(ids.has('BkNt')).toBe(true);
    expect(ids.has('BtNt')).toBe(true);
    expect(ids.has('BeNu')).toBe(true); // uniform
    expect(ids.has('BkNm')).toBe(true);
  });

  it('uses putDouble for BkIb (iris radius) and BkSb (specular brightness)', () => {
    expect(jsx).toContain("putDouble(cTID('BkIb'), 25)");
    expect(jsx).toContain("putDouble(cTID('BkSb'), 20)");
  });

  it('rejects all the pre-audit forum-lore stringIDs', () => {
    for (const id of [
      'radius',
      'irisShape',
      'noiseDistribution',
      'depthMap',
      'blurFocalDistance',
      'invertDepthMap',
    ]) {
      expect(ids.has(id), `pre-audit stringID '${id}' must not return`).toBe(false);
    }
  });
});
