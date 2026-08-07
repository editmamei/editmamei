/**
 * Snippet-vs-spec test for the Invert adjustment-layer fix
 * (2026-06-04 Bundle 1). Pins the audit STEP 21 finding:
 * Invert uses `using.putClass(cTID('Type'), typeCharID)` with NO
 * inner type descriptor — same special-case as Color Lookup.
 *
 * Spec: src/spec/ps27/adjustments/invert.ts
 * Capture: JS-21-Invert.log
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { goBuild, goCoreBinaryAvailable } from './_helpers.ts';

describe.skipIf(!goCoreBinaryAvailable)('spec: adjustments/invert', () => {
  let jsx: string;

  beforeAll(async () => {
    jsx = await goBuild('addAdjustmentLayer', { type: 'invert' });
  });

  it('uses putClass(Type, Invr) on the Usng descriptor (not putObject + inner typeDesc)', () => {
    expect(jsx).toContain("using.putClass(cTID('Type'), typeCharID)");
    // Pre-audit (and every non-Invr type) uses putObject + inner desc:
    expect(jsx).not.toContain("using.putObject(cTID('Type'), typeCharID, typeDesc)");
  });

  it('still creates the AdjL with the Invr type charID', () => {
    expect(jsx).toContain("cTID('AdjL')");
    expect(jsx).toContain("cTID('Invr')");
    expect(jsx).toContain("cTID('Mk  ')");
  });
});
