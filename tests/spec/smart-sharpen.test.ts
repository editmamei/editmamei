/**
 * Snippet-vs-spec test for the Smart Sharpen fix (2026-06-04 Bundle 2).
 * Pins the audit STEP 23 fixes:
 *   1. Sub-object class is adaptCorrectTones (no "ive").
 *   2. Root Amnt + noiseReduction are putUnitDouble #Prc.
 *   3. Sub-object outer keys are charID sdwM/hglM (not stringIDs).
 *   4. Inner Amnt/Wdth are putUnitDouble #Prc; inner Rds is putInteger.
 *   5. blur is charID; enum value GsnB/LnsB/MtnB are charIDs.
 *
 * Spec: src/spec/ps27/filters/smart-sharpen.ts
 * Capture: JS-23-Smart-Sharpen.log
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { extractCalledTypeIDs, goBuild, goCoreBinaryAvailable } from './_helpers.ts';

describe.skipIf(!goCoreBinaryAvailable)('spec: filters/smart-sharpen', () => {
  let jsx: string;
  let ids: Set<string>;

  beforeAll(async () => {
    jsx = await goBuild('applySmartSharpen', {
      amount: 150,
      radius: 1.5,
      noiseReduction: 20,
      removeMode: 'gaussianBlur',
      motionAngle: 0,
      shadowFade: 20,
      shadowTonalWidth: 50,
      shadowRadius: 30,
      highlightFade: 10,
      highlightTonalWidth: 50,
      highlightRadius: 35,
    });
    ids = extractCalledTypeIDs(jsx);
  });

  it('emits the smartSharpen event ID and the captured charID family', () => {
    expect(ids.has('smartSharpen')).toBe(true);
    // Root keys (charIDs):
    expect(ids.has('Amnt')).toBe(true);
    expect(ids.has('Rds ')).toBe(true);
    expect(ids.has('blur')).toBe(true);
    // Sub-object outer keys (charIDs):
    expect(ids.has('sdwM')).toBe(true);
    expect(ids.has('hglM')).toBe(true);
    // Sub-object class (stringID, no "ive"):
    expect(ids.has('adaptCorrectTones')).toBe(true);
    // Inner keys (charIDs):
    expect(ids.has('Wdth')).toBe(true);
    // Enum types + Gaussian default value:
    expect(ids.has('blurType')).toBe(true);
    expect(ids.has('GsnB')).toBe(true);
  });

  it('does NOT use the legacy stringID surface or the typo class', () => {
    // The famous typo — must never return.
    expect(ids.has('adaptiveCorrectTones')).toBe(false);
    // Pre-audit stringID keys must never return.
    expect(ids.has('shadowMode')).toBe(false);
    expect(ids.has('highlightMode')).toBe(false);
    expect(ids.has('amount')).toBe(false);
    expect(ids.has('width')).toBe(false);
  });

  it('uses putUnitDouble #Prc for the percent-typed fields', () => {
    expect(jsx).toContain("putUnitDouble(cTID('Amnt'), cTID('#Prc'), 150)");
    expect(jsx).toContain("putUnitDouble(sTID('noiseReduction'), cTID('#Prc'), 20)");
    expect(jsx).toContain("putUnitDouble(cTID('Rds '), cTID('#Pxl'), 1.5)");
  });
});
