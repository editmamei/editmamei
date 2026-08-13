/**
 * Snippet-vs-spec test for the Clipping Mask primitives.
 * Create pins the captured `groupEvent` stringID (alias of `GrpL`).
 * Release pins the `Ungr` charID — there is NO `ungroupEvent` stringID
 * alias; dispatching one fails with `The command "<unknown>" is not
 * currently available`.
 *
 * Spec: src/spec/ps27/layer-ops/create-clipping-mask.ts
 * Capture: JS-32-Clip-Mask.log
 */

import { describe, it, expect } from 'vitest';
import { goBuild, goCoreBinaryAvailable } from './_helpers.ts';

describe.skipIf(!goCoreBinaryAvailable)('spec: layer-ops/create-clipping-mask', () => {
  it('createClippingMask dispatches the groupEvent stringID behind a grouped guard', async () => {
    const jsx = await goBuild('createClippingMask', {});
    expect(jsx).toContain("executeAction(sTID('groupEvent')");
    expect(jsx).toContain("clipRef.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'))");
    // Idempotency guard, symmetric with release: dispatching groupEvent on
    // an already-clipped layer does not toggle — PS disables the command
    // and throws `not currently available` (live-verified PS 27.2.0) — so
    // the snippet must check clip state and no-op (already_clipped) instead.
    expect(jsx).toContain('doc.activeLayer.grouped');
    expect(jsx).toContain('already_clipped');
    // Must not be confused with the LayerSet ungroupLayersEvent.
    expect(jsx).not.toContain('ungroupLayersEvent');
  });

  it('releaseClippingMask dispatches the Ungr charID behind a grouped guard', async () => {
    const jsx = await goBuild('releaseClippingMask', {});
    expect(jsx).toContain("executeAction(cTID('Ungr')");
    expect(jsx).toContain("releaseRef.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'))");
    // Idempotency guard: raw 'Ungr' on a non-clipped layer throws -25920,
    // so the snippet must check clip state and no-op instead.
    expect(jsx).toContain('doc.activeLayer.grouped');
    // 'ungroupEvent' is not a registered stringID (typeIDToStringID of
    // 'Ungr' is "ungroup") — dispatching it fails as command "<unknown>".
    expect(jsx).not.toContain('ungroupEvent');
    // And it stays distinct from the LayerSet ungroupLayersEvent.
    expect(jsx).not.toContain('ungroupLayersEvent');
  });
});
