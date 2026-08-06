/**
 * Snippet-vs-spec test for the Curves adjustment-layer fix (2026-07-27).
 * Pins three drift fixes confirmed against ScriptListener ground truth:
 *   1. The post-Mk setd ref targeted cTID('Lyr ')/Ordn/Trgt — the
 *      DESTRUCTIVE BAKE descriptor (Image > Adjustments > Curves), which
 *      acts on pixels. Aimed at a freshly created adjustment layer (no
 *      pixels), PS returns success and silently applies nothing. The
 *      correct target is cTID('AdjL')/Ordn/Trgt.
 *   2. Chnl on the CrvA entry is a putReference (ActionReference
 *      enumerating Chnl/Chnl/Cmps), not a bare putEnumerated. Both the
 *      capture and the typed spec require the reference form.
 *   3. The setd's outer `T` object class was cTID('Crv ') — this DISAGREED
 *      with the class Mk uses on creation (cTID('Crvs')) and with ground
 *      truth (JS-04-curves.log:555-556, `idCrvs = charIDToTypeID("Crvs")`).
 *      Live-verified 2026-07-27: with the 'Crv ' class the setd hard-errors
 *      ('The command "Set" is not currently available.'); with 'Crvs' it
 *      succeeds and the histogram moves as expected. Note cTID('Crv ') is
 *      still correct and must NOT change on the POINT-LIST key
 *      (`crvEntry.putList(cTID('Crv '), pointList)`) — only the T-object
 *      class was wrong.
 * Curves is affected worse than levels: its default preset (sCurveMedium)
 * is not 'linear', so hasCustomValues is true on essentially every call —
 * the broken setd fired on nearly every invocation.
 *
 * Spec: src/spec/ps27/adjustments/curves.ts
 * Capture: JS-04-curves.log:546-547,555-556
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { goBuild, goCoreBinaryAvailable } from './_helpers.ts';

describe.skipIf(!goCoreBinaryAvailable)('spec: adjustments/curves', () => {
  let jsx: string;

  beforeAll(async () => {
    jsx = await goBuild('addAdjustmentLayer', { type: 'curves', curves_preset: 'sCurveMedium' });
  });

  it('targets the adjustment layer (AdjL), not the destructive bake (Lyr), on the setd ref', () => {
    expect(jsx).toContain("crvSetdRef.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'))");
    expect(jsx).not.toContain("crvSetdRef.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'))");
  });

  it('marks the setd type descriptor presetKindCustom', () => {
    expect(jsx).toContain(
      "crvTypeDesc.putEnumerated(sTID('presetKind'), sTID('presetKindType'), sTID('presetKindCustom'))"
    );
  });

  it('uses putReference for the Chnl key on the CrvA entry (not putEnumerated)', () => {
    expect(jsx).toContain("crvEntry.putReference(cTID('Chnl'), crvChnlRef)");
    expect(jsx).not.toContain("crvEntry.putEnumerated(cTID('Chnl')");
  });

  it("uses cTID('Crvs') for the setd's T-object class, not cTID('Crv ') (PS rejects the setd with \"Set\" not available otherwise)", () => {
    expect(jsx).toContain("crvSetd.putObject(cTID('T   '), cTID('Crvs'), crvTypeDesc)");
    expect(jsx).not.toContain("crvSetd.putObject(cTID('T   '), cTID('Crv '), crvTypeDesc)");
    // The point-list key legitimately keeps cTID('Crv ') — must NOT regress.
    expect(jsx).toContain("crvEntry.putList(cTID('Crv '), pointList)");
  });

  it('still routes through the setd-with-values path after the Mk-bare', () => {
    expect(jsx).toContain('apply_curves_setd');
    expect(jsx).toContain("cTID('T   '), cTID('Crvs')");
    expect(jsx).toContain("cTID('CrvA')");
    expect(jsx).toContain("cTID('Adjs')");
  });
});
