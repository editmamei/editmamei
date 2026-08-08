/**
 * Snippet-vs-spec tests for retouch ops.
 *
 * Three specs, three snippets, three sets of body assertions per the
 * helpers in `_helpers.ts`. The captures are all single-event dispatches
 * (no Mk+setd shortcut equivalence), so straight `required ⊆ called`
 * checking applies — no filterEquivalence calls needed.
 *
 * Specs at src/spec/ps27/retouch/*.ts. Snippets at the
 * tail of src/api/extendscript.ts (applyContentAwareFill, applyPatch,
 * applyContentAwareMove).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { contentAwareFillSpec } from '../../src/spec/ps27/retouch/content-aware-fill.ts';
import { patchSpec } from '../../src/spec/ps27/retouch/patch.ts';
import { contentAwareMoveSpec } from '../../src/spec/ps27/retouch/content-aware-move.ts';
import {
  collectRequiredTypeIDs,
  extractCalledTypeIDs,
  filterEquivalence,
  goBuild,
  goCoreBinaryAvailable,
} from './_helpers.ts';

describe.skipIf(!goCoreBinaryAvailable)('spec: retouch/content-aware-fill', () => {
  let jsx: string;
  let calledTypeIDs: Set<string>;

  beforeAll(async () => {
    jsx = await goBuild('applyContentAwareFill', {
      colorAdaptation: true,
      rotate: false,
      scale: false,
      mirror: false,
      opacity: 100,
      blendMode: 'normal',
    });
    calledTypeIDs = extractCalledTypeIDs(jsx);
  });

  it('emits every required typeID from the spec', () => {
    const required = collectRequiredTypeIDs(contentAwareFillSpec);
    // Equivalence filter: the spec encodes the top-level descriptor's
    // classID as 'null' (consistent with other specs), but the Fill event
    // has no target reference — the snippet just builds a parameter-only
    // descriptor without `cTID('null')` showing up at a call site. Drop
    // 'null' from the required set to match this equivalence.
    const equivalenceFiltered = filterEquivalence(required, ['null']);
    const missing = equivalenceFiltered.filter((typeID) => !calledTypeIDs.has(typeID));
    expect(
      missing,
      `missing typeIDs from snippet's cTID/sTID call sites: ${missing.join(', ')}`
    ).toEqual([]);
  });

  it('emits the Fill event with Content-Aware variant via Usng → FlCn → contentAware', () => {
    // Event ID + the discriminating enum that distinguishes this from
    // solid-color / pattern / history fill.
    expect(jsx).toContain("executeAction(cTID('Fl  ')");
    expect(jsx).toContain("putEnumerated(cTID('Usng'), cTID('FlCn'), sTID('contentAware'))");
  });

  it('emits all four Content-Aware booleans (color/rotate/scale/mirror)', () => {
    expect(jsx).toContain("sTID('contentAwareColorAdaptationFill')");
    expect(jsx).toContain("sTID('contentAwareRotateFill')");
    expect(jsx).toContain("sTID('contentAwareScaleFill')");
    expect(jsx).toContain("sTID('contentAwareMirrorFill')");
  });

  it('emits Opct (#Prc) and Md/BlnM for opacity + blend mode', () => {
    expect(jsx).toContain("putUnitDouble(cTID('Opct'), cTID('#Prc')");
    expect(jsx).toContain("putEnumerated(cTID('Md  '), cTID('BlnM')");
  });

  it('throws explicit error when no selection is active', () => {
    // Selection-driven retouch MUST guard against silent-fill-whole-layer.
    // Look for the AM probe + the explicit error message.
    expect(jsx).toContain("putProperty(cTID('Prpr'), cTID('fsel'))");
    expect(jsx).toMatch(/requires an active selection/i);
  });

  it('follows the auto-duplicate-first pattern', () => {
    // duplicateForOp() returns inline ExtendScript that sets these markers.
    // Their presence in the emitted body is the load-bearing signal.
    expect(jsx).toContain('__opTargetIsCopy');
    expect(jsx).toContain('__opOriginalName');
    expect(jsx).toContain('target_was_copy');
    expect(jsx).toContain('original_layer_name');
  });

  it('does NOT use the deprecated `cafTM` event ID from forum lore', () => {
    // Older planning notes mentioned "cafTM" — PS 27.x emits standard Fl, not cafTM.
    // Regression guard if a future refactor reaches for the forum-lore key.
    expect(jsx).not.toContain("cTID('cafT')");
    expect(jsx).not.toContain("sTID('cafTM')");
  });
});

describe.skipIf(!goCoreBinaryAvailable)('spec: retouch/patch', () => {
  let jsx: string;
  let calledTypeIDs: Set<string>;

  beforeAll(async () => {
    jsx = await goBuild('applyPatch', {
      offsetX: 90,
      offsetY: -6,
      patchStructure: 5,
      patchColor: 5,
      healSmoothFactor: 5,
      sampleAllLayers: false,
      transparent: false,
      useSource: true,
    });
    calledTypeIDs = extractCalledTypeIDs(jsx);
  });

  it('emits every required typeID from the spec', () => {
    const required = collectRequiredTypeIDs(patchSpec);
    const missing = [...required].filter((typeID) => !calledTypeIDs.has(typeID));
    expect(
      missing,
      `missing typeIDs from snippet's cTID/sTID call sites: ${missing.join(', ')}`
    ).toEqual([]);
  });

  it('uses the `patchSelection` stringID, NOT a forum-lore `Ptch` charID', () => {
    expect(jsx).toContain("executeAction(sTID('patchSelection')");
    // Regression guard — Forum sources reference 'Ptch' as the patch event ID.
    // That does not exist on PS 27.x. Keep it out of future refactors.
    expect(jsx).not.toContain("cTID('Ptch')");
  });

  it('uses From → Ofst sub-object with Hrzn/Vrtc pixel offsets', () => {
    expect(jsx).toContain("putObject(cTID('From'), cTID('Ofst')");
    expect(jsx).toContain("putUnitDouble(cTID('Hrzn'), cTID('#Pxl')");
    expect(jsx).toContain("putUnitDouble(cTID('Vrtc'), cTID('#Pxl')");
  });

  it('emits patchMode → patchModeType → patchContentAware enum', () => {
    expect(jsx).toContain(
      "putEnumerated(sTID('patchMode'), sTID('patchModeType'), sTID('patchContentAware'))"
    );
  });

  it('emits patchStructureAdapt / patchColorAdaptation / healSmoothFactor / useSource', () => {
    expect(jsx).toContain("sTID('patchStructureAdapt')");
    expect(jsx).toContain("sTID('patchColorAdaptation')");
    expect(jsx).toContain("sTID('healSmoothFactor')");
    expect(jsx).toContain("sTID('useSource')");
  });

  it('targets the current selection via Chnl/fsel reference (`null` target)', () => {
    expect(jsx).toContain("putProperty(cTID('Chnl'), cTID('fsel'))");
    expect(jsx).toContain("putReference(cTID('null'), __ref)");
  });

  it('throws when no selection is active (pre-emption guard)', () => {
    expect(jsx).toContain("putProperty(cTID('Prpr'), cTID('fsel'))");
    expect(jsx).toMatch(/requires an active selection/i);
  });

  it('embeds offset arguments into the descriptor', () => {
    // jsNum produces literal numeric tokens; verify both axes land.
    expect(jsx).toContain("putUnitDouble(cTID('Hrzn'), cTID('#Pxl'), 90)");
    expect(jsx).toContain("putUnitDouble(cTID('Vrtc'), cTID('#Pxl'), -6)");
  });
});

describe.skipIf(!goCoreBinaryAvailable)('spec: retouch/content-aware-move', () => {
  let jsx: string;
  let calledTypeIDs: Set<string>;

  beforeAll(async () => {
    jsx = await goBuild('applyContentAwareMove', {
      offsetX: 219,
      offsetY: -384,
      patchStructure: 4,
      patchColor: 5,
      healSmoothFactor: 5,
      sampleAllLayers: false,
      transparent: false,
      reshuffle: true,
    });
    calledTypeIDs = extractCalledTypeIDs(jsx);
  });

  it('emits every required typeID from the spec', () => {
    const required = collectRequiredTypeIDs(contentAwareMoveSpec);
    // Equivalence filter: the spec documents BOTH `remixMove` and
    // `remixExtend` as remixMode enum values (Content-Aware Move vs
    // Content-Aware Extend modes in the PS UI). The v1 snippet only
    // emits remixMove — remixExtend is a future surface-broadening
    // MINOR bump. Drop remixExtend from the required set so we don't
    // demand a typeID for an unimplemented mode. When extend mode
    // lands, remove it from this omit list.
    const equivalenceFiltered = filterEquivalence(required, ['remixExtend']);
    const missing = equivalenceFiltered.filter((typeID) => !calledTypeIDs.has(typeID));
    expect(
      missing,
      `missing typeIDs from snippet's cTID/sTID call sites: ${missing.join(', ')}`
    ).toEqual([]);
  });

  it('uses the `recomposeSelection` stringID (distinct from Patch)', () => {
    expect(jsx).toContain("executeAction(sTID('recomposeSelection')");
    // Regression: must NOT confuse with Patch.
    expect(jsx).not.toContain("executeAction(sTID('patchSelection')");
  });

  it("uses charID('T   ') as the offset wrapper key (THREE trailing spaces) — NOT 'From' like Patch", () => {
    // The exact byte sequence — 'T' + three spaces — is the easy-to-miscount
    // gotcha called out in the spec's knownGotchas.
    expect(jsx).toContain("putObject(cTID('T   '), cTID('Ofst')");
    // Patch's 'From' wrapper must NOT appear in CAM.
    expect(jsx).not.toContain("putObject(cTID('From'), cTID('Ofst')");
  });

  it('emits remixMode → remixModeType → remixMove enum (move mode, not extend)', () => {
    expect(jsx).toContain(
      "putEnumerated(sTID('remixMode'), sTID('remixModeType'), sTID('remixMove'))"
    );
  });

  it('emits the CAM-only keys: clone, transformOnDrop', () => {
    expect(jsx).toContain("sTID('clone')");
    expect(jsx).toContain("sTID('transformOnDrop')");
  });

  it('shares the patch adaptation keys with Patch (structure / color / smooth)', () => {
    expect(jsx).toContain("sTID('patchStructureAdapt')");
    expect(jsx).toContain("sTID('patchColorAdaptation')");
    expect(jsx).toContain("sTID('healSmoothFactor')");
  });

  it('targets the current selection via Chnl/fsel reference', () => {
    expect(jsx).toContain("putProperty(cTID('Chnl'), cTID('fsel'))");
    expect(jsx).toContain("putReference(cTID('null'), __ref)");
  });

  it('throws when no selection is active', () => {
    expect(jsx).toContain("putProperty(cTID('Prpr'), cTID('fsel'))");
    expect(jsx).toMatch(/requires an active selection/i);
  });

  it('embeds offset arguments into the descriptor', () => {
    expect(jsx).toContain("putUnitDouble(cTID('Hrzn'), cTID('#Pxl'), 219)");
    expect(jsx).toContain("putUnitDouble(cTID('Vrtc'), cTID('#Pxl'), -384)");
  });
});
