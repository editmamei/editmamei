/**
 * Snippet-vs-spec test for the Color Range Lab fix (2026-06-04
 * Bundle 4). Pins the audit STEP 38 fix: emit LbCl (Lab Color) objects
 * with Lmnc/A/B doubles + a top-level colorModel integer, NOT the
 * pre-audit RGBC form.
 *
 * Spec: src/spec/ps27/selection/color-range.ts
 * Capture: JS-38-Color-Range.log
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { extractCalledTypeIDs, goBuild, goCoreBinaryAvailable } from './_helpers.ts';

describe.skipIf(!goCoreBinaryAvailable)('spec: selection/color-range', () => {
  let jsx: string;
  let ids: Set<string>;

  beforeAll(async () => {
    jsx = await goBuild('selectColorRange', {
      red: 200,
      green: 50,
      blue: 50,
      fuzziness: 60,
      selectionType: 'replace',
    });
    ids = extractCalledTypeIDs(jsx);
  });

  it('emits ClrR event + LbCl color class + Lmnc/A/B keys', () => {
    expect(ids.has('ClrR')).toBe(true);
    expect(ids.has('LbCl')).toBe(true);
    expect(ids.has('Lmnc')).toBe(true);
    expect(ids.has('A   ')).toBe(true);
    expect(ids.has('B   ')).toBe(true);
    expect(ids.has('Mnm ')).toBe(true);
    expect(ids.has('Mxm ')).toBe(true);
    expect(ids.has('Fzns')).toBe(true);
  });

  it('emits the colorModel integer that PS uses to pick the matching algorithm', () => {
    expect(ids.has('colorModel')).toBe(true);
    expect(jsx).toContain("putInteger(stringIDToTypeID('colorModel'), 0)");
  });

  it('rejects the legacy RGBC form', () => {
    expect(ids.has('RGBC')).toBe(false);
  });

  it('inlines the sRGB → Lab D65 conversion math (not a coerce-on-PS-side hope)', () => {
    expect(jsx).toContain('_srgbToLin');
    expect(jsx).toContain('_labF');
    expect(jsx).toContain('_rgbToLab');
  });
});
