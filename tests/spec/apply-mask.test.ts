/**
 * Snippet-vs-spec test for the Apply Layer Mask fix (2026-06-04
 * Bundle 6). Pins the audit STEP 36 migration from legacy top-level
 * `Aply` event to the modern UI-emitted `Dlt + Aply: true` form.
 *
 * Spec: src/spec/ps27/masks/apply-mask.ts
 * Capture: JS-36-Mask-Apply.log
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { goBuild, goCoreBinaryAvailable } from './_helpers.ts';

describe.skipIf(!goCoreBinaryAvailable)('spec: masks/apply-mask', () => {
  let jsx: string;

  beforeAll(async () => {
    jsx = await goBuild('applyLayerMask', {});
  });

  it('dispatches Dlt with Aply:true (modern form), not the legacy standalone Aply event', () => {
    expect(jsx).toContain("executeAction(cTID('Dlt ')");
    expect(jsx).toContain("desc.putBoolean(cTID('Aply'), true)");
    expect(jsx).not.toContain("executeAction(cTID('Aply')");
  });

  it('targets the mask channel via explicit Chnl/Chnl/Msk reference (LLM-safer than capture Ordn/Trgt)', () => {
    expect(jsx).toContain("ref.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Msk '))");
  });
});
