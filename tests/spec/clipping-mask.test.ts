/**
 * Snippet-vs-spec test for the new Clipping Mask primitives
 * (2026-06-04 Bundle 5). Pins the create/release pair against the
 * captured `groupEvent` / `ungroupEvent` stringID aliases (which
 * resolve to `GrpL` / `Ungr` charIDs on PS 27.x).
 *
 * Spec: src/spec/ps27/layer-ops/create-clipping-mask.ts
 * Capture: JS-32-Clip-Mask.log
 */

import { describe, it, expect } from 'vitest';
import { goBuild, goCoreBinaryAvailable } from './_helpers.ts';

describe.skipIf(!goCoreBinaryAvailable)('spec: layer-ops/create-clipping-mask', () => {
  it('createClippingMask dispatches the groupEvent stringID', async () => {
    const jsx = await goBuild('createClippingMask', {});
    expect(jsx).toContain("executeAction(sTID('groupEvent')");
    expect(jsx).toContain("clipRef.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'))");
    // Must not be confused with the LayerSet ungroupLayersEvent.
    expect(jsx).not.toContain('ungroupLayersEvent');
  });

  it('releaseClippingMask dispatches the ungroupEvent stringID', async () => {
    const jsx = await goBuild('releaseClippingMask', {});
    expect(jsx).toContain("executeAction(sTID('ungroupEvent')");
    expect(jsx).toContain("releaseRef.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'))");
    // Same alias-disambiguation guard — ungroupEvent (release clip) is
    // distinct from ungroupLayersEvent (dissolve a layer group).
    expect(jsx).not.toContain('ungroupLayersEvent');
  });
});
