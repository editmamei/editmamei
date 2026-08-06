/**
 * Snippet-vs-spec test for the Levels adjustment-layer fix
 * (2026-06-04 Bundle 1). Pins the three drift fixes from the
 * 2026-06-03 audit STEP 05:
 *   1. Chnl is putReference (not putEnumerated) to the composite.
 *   2. Inpt is a 2-int LIST [black, white] (not separate Inpt+Wht keys).
 *   3. Gmm  is putDouble of raw gamma (not putInteger(gamma * 100)).
 *
 * Also pins the post-Mk setd target-class fix (2026-07-27): the setd that
 * writes the levels values was targeting cTID('Lyr ')/Ordn/Trgt — the
 * DESTRUCTIVE BAKE descriptor (Image > Adjustments > Levels), which acts on
 * pixels. Aimed at a freshly created adjustment layer (no pixels), PS
 * returns success and silently applies nothing. The correct target is
 * cTID('AdjL')/Ordn/Trgt, plus a presetKindCustom line on the setd's type
 * descriptor — both confirmed against ScriptListener ground truth.
 *
 * Spec: src/spec/ps27/adjustments/levels.ts
 * Capture: JS-05-levels.log:108-142
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { goBuild, goCoreBinaryAvailable } from './_helpers.ts';

describe.skipIf(!goCoreBinaryAvailable)('spec: adjustments/levels', () => {
  let jsx: string;

  beforeAll(async () => {
    jsx = await goBuild('addAdjustmentLayer', {
      type: 'levels',
      black_point: 8,
      white_point: 238,
      gamma: 1.25,
    });
  });

  it('uses putReference on the descriptor for the Chnl key (not putEnumerated)', () => {
    expect(jsx).toContain("lvlsEntry.putReference(cTID('Chnl'), lvlChnlRef)");
    expect(jsx).not.toContain("lvlsEntry.putEnumerated(cTID('Chnl')");
  });

  it('uses the 2-int list form for Inpt and the raw double for Gmm', () => {
    expect(jsx).toContain('lvlInptList.putInteger(8)');
    expect(jsx).toContain('lvlInptList.putInteger(238)');
    expect(jsx).toContain("putList(cTID('Inpt'), lvlInptList)");
    expect(jsx).toContain("putDouble(cTID('Gmm '), 1.25)");
    // Legacy form must never return.
    expect(jsx).not.toContain("cTID('Inpt'), 8");
    expect(jsx).not.toContain("cTID('Wht '), 238");
    expect(jsx).not.toContain('Math.round((1.25) * 100)');
  });

  it('still routes through the setd-with-values path after the Mk-bare', () => {
    expect(jsx).toContain('apply_levels_setd');
    expect(jsx).toContain("cTID('T   '), cTID('Lvls')");
    expect(jsx).toContain("cTID('LvlA')");
    expect(jsx).toContain("cTID('Adjs')");
  });

  it('targets the adjustment layer (AdjL), not the destructive bake (Lyr), on the setd ref', () => {
    expect(jsx).toContain("lvlSetdRef.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'))");
    expect(jsx).not.toContain("lvlSetdRef.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'))");
  });

  it('marks the setd type descriptor presetKindCustom', () => {
    expect(jsx).toContain(
      "lvlsTypeDesc.putEnumerated(sTID('presetKind'), sTID('presetKindType'), sTID('presetKindCustom'))"
    );
  });
});
