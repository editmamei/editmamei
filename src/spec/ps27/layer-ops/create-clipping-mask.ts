/**
 * Create Clipping Mask — clip the active layer to the layer below.
 *
 * Ground truth: PS 27.7.0 Windows, captured 2026-06-03.
 * Capture log: JS-32-Clip-Mask.log
 *
 * The user selected an upper layer and chose Layer > Create Clipping Mask
 * (Ctrl+Alt+G).
 *
 * PS emits a SINGLE `GrpL` (charID, "Group into Layer") event with a
 * minimal descriptor — just a `null`-keyed reference to the target layer
 * (the upper layer that becomes clipped to the layer below). The
 * stringID alias for the same event is `groupEvent`; both resolve to the
 * same internal event in PS 27.x.
 *
 * **Coverage gap (2026-06-03 audit Group C, STEP 32 — HIGH).**
 *
 * **There is no `ps_create_clipping_mask` tool yet.** The only
 * clipping behavior in the codebase is the optional `clip_to_below: true`
 * parameter on `ps_add_adjustment_layer`, implemented inline at
 * `go-core/cmd/buildtemplates/fragments_adjustments.go` (`vault.AdjLOuter`). It uses `sTID("groupEvent")` —
 * the stringID alias — which resolves identically to `cTID("GrpL")` in
 * modern PS.
 *
 * **The audit recommends adding `ps_create_clipping_mask` (and
 * the inverse `ps_release_clipping_mask`) as tier-`'dev'` tools.**
 * The descriptor shape pinned by this spec — `GrpL` charID OR
 * `groupEvent` stringID + null-keyed reference `Lyr/Ordn/Trgt` — is the
 * canonical form, verified against the menu capture.
 *
 * **Event ID aliasing.** `app.typeIDToStringID(app.charIDToTypeID("GrpL"))
 * === "groupEvent"` in PS 27.x — the two forms are paired aliases. The
 * inline path in `addAdjustmentLayer` uses the stringID; a future
 * standalone tool should either match (stringID) or pick one form and
 * pin it with a `.not.toContain` regression test to prevent a refactor
 * from flipping to a fictional event ID.
 *
 * The release / inverse operation is `Ungr` charID / `ungroupEvent`
 * stringID — same alias pattern.
 */

import type { AmEventSpec } from '../../types.js';
import { charID } from '../../types.js';

export const createClippingMaskSpec: AmEventSpec = {
  id: 'layer-ops/create-clipping-mask',
  displayName: 'Create clipping mask',
  category: 'layer-ops',
  emittedBy: ['ps_create_clipping_mask (community — shipped; handler in src/tools/group-tools.ts)'],
  snippetRef:
    'go-core/cmd/buildtemplates/fragments_adjustments.go (vault.AdjLOuter — INLINE inside addAdjustmentLayer when clip_to_below=true; no standalone tool yet)',
  groundTruth: {
    capturedAt: '2026-06-03',
    psVersion: '27.7.0',
    platform: 'Windows',
    sourceLog: 'JS-32-Clip-Mask.log',
    menuPath: 'Layer > Create Clipping Mask (Ctrl+Alt+G)',
  },
  knownGotchas: [
    "COVERAGE GAP (HIGH) — there is no standalone `ps_create_clipping_mask` tool. The only clipping behavior in the codebase is the inline `clip_to_below: true` branch of `ps_add_adjustment_layer` in `go-core/cmd/buildtemplates/fragments_adjustments.go` (`vault.AdjLOuter`). The 2026-06-03 audit (Group C, STEP 32) recommends adding `ps_create_clipping_mask` and `ps_release_clipping_mask` as tier-`'dev'` tools.",
    'Event ID has two paired aliases: `GrpL` (charID — emitted by the PS menu capture) and `groupEvent` (stringID — used by the inline implementation in `addAdjustmentLayer`). Both resolve to the same internal event in modern PS. Verified: `app.typeIDToStringID(app.charIDToTypeID("GrpL")) === "groupEvent"` in PS 27.x.',
    "Inverse operation (release clipping mask) is `Ungr` charID / `ungroupEvent` stringID — same alias pattern. NOT the same as the layer-section `ungroupLayersEvent` used by `ps_ungroup`. Three distinct stringIDs: `groupEvent` (clip to below), `ungroupEvent` (release clipping mask), `ungroupLayersEvent` (dissolve a layer group). Don't confuse them.",
    'The clipping mask is conceptually "use the layer below as the alpha source for this layer." It requires the layer below to exist; PS silently no-ops if the active layer is at the bottom of the document.',
    'When adding the future standalone tool, pin both the `GrpL` ↔ `groupEvent` alias and the `Ungr` ↔ `ungroupEvent` alias with `.not.toContain` regression guards on legacy / fictional event IDs (see docs/engineering/am-descriptor-conventions.md "Forum-lore event IDs — verify before shipping").',
  ],
  versionNotes: [
    'Capture from PS 27.7.0 Windows; the GrpL/groupEvent alias has been stable since at least PS 21.',
    'Snippet uses the stringID form (`sTID("groupEvent")`) at the inline site; menu capture uses the charID form (`cTID("GrpL")`). Either is acceptable — pick one and pin it.',
  ],
  events: [
    {
      index: 1,
      event: charID('GrpL'),
      comment:
        'Clip the active layer to the layer below (Group into Layer). Minimal descriptor — single null reference to the target. The stringID alias `groupEvent` resolves to the same internal event; both forms are valid.',
      descriptor: {
        classID: charID('null'),
        fields: [
          {
            name: 'target (reference to current layer)',
            typeID: charID('null'),
            kind: 'reference',
            required: true,
            referenceShape: {
              classID: charID('Lyr '),
              variant: 'enumerated',
              enumKey: charID('Ordn'),
              enumValue: charID('Trgt'),
            },
            description:
              'putEnumerated(cTID("Lyr "), cTID("Ordn"), cTID("Trgt")). Targets the active layer — that layer becomes clipped to the one immediately below it in the layer stack.',
          },
        ],
      },
    },
  ],
};
