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
 * **Tool surface.** The standalone primitive is `ps_clipping_mask`
 * (op=create / op=release, community tier; the 2026-06-04 Bundle 5
 * `ps_create_clipping_mask` / `ps_release_clipping_mask` pair was
 * consolidated into it). Snippets: `vault.ClipMask` / `vault.ReleaseClip`
 * in `go-core/cmd/buildtemplates/fragments_groups.go`. Separately,
 * `ps_add_adjustment_layer` keeps its inline `clip_to_below: true` path
 * (`vault.AdjLOuter` in `fragments_adjustments.go`).
 *
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
 * The release / inverse operation is the `Ungr` charID, whose stringID
 * is `"ungroup"` (`typeIDToStringID(charIDToTypeID("Ungr")) === "ungroup"`,
 * PS 27.2.0). The alias pattern does NOT extrapolate: there is no
 * `ungroupEvent` stringID, and dispatching `sTID("ungroupEvent")` fails
 * with `The command "<unknown>" is not currently available`. Use the
 * charID form for the release event.
 */

import type { AmEventSpec } from '../../types.js';
import { charID } from '../../types.js';

export const createClippingMaskSpec: AmEventSpec = {
  id: 'layer-ops/create-clipping-mask',
  displayName: 'Create clipping mask',
  category: 'layer-ops',
  emittedBy: [
    'ps_clipping_mask op=create/release (community; handler in src/tools/group-tools.ts)',
  ],
  snippetRef:
    'go-core/cmd/buildtemplates/fragments_groups.go (vault.ClipMask / vault.ReleaseClip); plus the INLINE clip_to_below=true path in fragments_adjustments.go (vault.AdjLOuter)',
  groundTruth: {
    capturedAt: '2026-06-03',
    psVersion: '27.7.0',
    platform: 'Windows',
    sourceLog: 'JS-32-Clip-Mask.log',
    menuPath: 'Layer > Create Clipping Mask (Ctrl+Alt+G)',
  },
  knownGotchas: [
    'The standalone surface is `ps_clipping_mask` (op=create / op=release) — the original create/release tool pair was consolidated into one op-discriminated tool. `ps_add_adjustment_layer` keeps its separate inline `clip_to_below: true` branch (`vault.AdjLOuter` in `fragments_adjustments.go`), which also dispatches `sTID("groupEvent")`.',
    'Event ID has two paired aliases: `GrpL` (charID — emitted by the PS menu capture) and `groupEvent` (stringID — used by the inline implementation in `addAdjustmentLayer`). Both resolve to the same internal event in modern PS. Verified: `app.typeIDToStringID(app.charIDToTypeID("GrpL")) === "groupEvent"` in PS 27.x.',
    'Inverse operation (release clipping mask) is the `Ungr` charID, stringID `"ungroup"`. There is NO `ungroupEvent` stringID — the GrpL↔groupEvent alias pattern does not extrapolate, and `sTID("ungroupEvent")` fails at dispatch with `The command "<unknown>" is not currently available` (verified live, PS 27.2.0 Windows). Also NOT the same as the layer-section `ungroupLayersEvent` used by `ps_ungroup`. Three distinct events: `groupEvent` (clip to below), `Ungr`/"ungroup" (release clipping mask), `ungroupLayersEvent` (dissolve a layer group).',
    'The clipping mask is conceptually "use the layer below as the alpha source for this layer." It requires the layer below to exist; PS silently no-ops if the active layer is at the bottom of the document.',
    'Pin the event IDs with `.not.toContain` regression guards on legacy / fictional forms (see docs/engineering/am-descriptor-conventions.md "Forum-lore event IDs — verify before shipping"). This spec itself fell into that trap: it originally asserted an `Ungr` ↔ `ungroupEvent` alias by extrapolation from GrpL↔groupEvent, and the fictional stringID shipped in the release snippet. tests/spec/clipping-mask.test.ts now guards `.not.toContain("ungroupEvent")`.',
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
