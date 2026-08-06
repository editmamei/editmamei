/**
 * Snippet-vs-spec proof-of-concept test for the Hue/Saturation
 * adjustment layer. Original V1 proof of the pattern; migrated
 * 2026-06-04 to use the shared `_helpers.ts` fixture.
 *
 * Comment-aware: we do NOT substring-match on the raw JSX string
 * because snippet bodies legitimately mention legacy keys in
 * comments (e.g. "CRITICAL: modern PS uses Hst2; Hsrt is silently
 * ignored"). The call-site regex in `_helpers.ts` only matches
 * typeIDs PS would actually receive at runtime.
 *
 * Two open design notes from V1:
 *
 * 1. The spec models the GROUND-TRUTH sequence (PS UI emits `Mk AdjL`
 *    default + separate `setd` with values). The Editmamei snippet
 *    uses the equivalent "create with values" pattern (one Mk with
 *    values embedded — see CLAUDE.md's "Hst2 bug history" comment).
 *    Both forms produce the same final layer state. This test treats
 *    them as equivalent by filtering out the setd-only typeIDs.
 *    When V2 ships a structural matcher, it will need to model the
 *    equivalence explicitly.
 *
 * 2. The current spec marks `T   ` (the setd `T` field) as required.
 *    With the create-with-values shortcut the snippet skips `setd`
 *    entirely. Filter via `filterEquivalence(required, [...])`.
 *    Deferred to V2.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { hueSaturationSpec } from '../../src/spec/ps27/adjustments/hue-saturation.ts';
import {
  collectRequiredTypeIDs,
  extractCalledTypeIDs,
  filterEquivalence,
  goBuild,
  goCoreBinaryAvailable,
} from './_helpers.ts';

describe.skipIf(!goCoreBinaryAvailable)('spec: adjustments/hue-saturation', () => {
  // Build the Master-entry snippet exactly as `ps_add_adjustment_layer`
  // would when called with type=hue_saturation. The capture
  // (JS-01-Hue-Sat.log) recorded Hue +30 / Sat +20 / Lightness -10.
  let jsx: string;
  let calledTypeIDs: Set<string>;

  beforeAll(async () => {
    jsx = await goBuild('addAdjustmentLayer', {
      type: 'hue_saturation',
      hue: 30,
      saturation: 20,
      lightness: -10,
      colorize: false,
    });
    calledTypeIDs = extractCalledTypeIDs(jsx);
  });

  it('uses the spec-required typeIDs that survive the create-with-values shortcut', () => {
    const required = collectRequiredTypeIDs(hueSaturationSpec);
    const equivalenceFiltered = filterEquivalence(required, ['setd', 'T   ', 'Ordn', 'Trgt']);
    const missing = equivalenceFiltered.filter((typeID) => !calledTypeIDs.has(typeID));
    expect(
      missing,
      `missing typeIDs from snippet's cTID/sTID call sites: ${missing.join(', ')}`
    ).toEqual([]);
  });

  it('uses Hst2 in a typeID call, not the legacy Hsrt', () => {
    // The famous silent-no-op bug. Check call-site usage, NOT raw
    // substring — snippet body comments legitimately reference Hsrt
    // to warn against it. A regression would manifest as a `cTID('Hsrt')`
    // or `charIDToTypeID('Hsrt')` reappearing.
    expect(calledTypeIDs.has('Hst2'), 'master entry must use Hst2').toBe(true);
    expect(calledTypeIDs.has('Hsrt'), 'Hsrt is the legacy key — silent no-op on PS24+').toBe(false);
  });

  it('declares the canonical adjustment-type charID (HStr)', () => {
    expect(calledTypeIDs.has('HStr')).toBe(true);
  });
});
