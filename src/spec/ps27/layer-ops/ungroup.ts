/**
 * Ungroup Layers — dissolves a layer group, promoting its children.
 *
 * Ground truth: PS 27.7.0 Windows, captured 2026-06-03.
 * Capture log: JS-31-Ungroup.log
 *
 * The user selected a layer group and chose Layer > Ungroup Layers
 * (Ctrl+Shift+G).
 *
 * PS emits a SINGLE `ungroupLayersEvent` (stringID) event with a minimal
 * descriptor — just a `null`-keyed reference to the target layer (the
 * group to dissolve). No other parameters.
 *
 * **Editmamei snippet vs capture (2026-06-03 audit Group C, STEP 31 — OK).**
 * EXACT MATCH. Event ID, reference shape, and `null` key all identical.
 * The Editmamei snippet additionally sets `doc.activeLayer = group` first
 * so the `Trgt` enum resolves to the right group (the capture context had
 * the group already selected via UI click). The snippet also captures the
 * children's names BEFORE dissolving (the LayerSet object becomes invalid
 * afterwards) so it can return them in the tool result.
 */

import type { AmEventSpec } from '../../types.js';
import { charID, stringID } from '../../types.js';

export const ungroupSpec: AmEventSpec = {
  id: 'layer-ops/ungroup',
  displayName: 'Ungroup layers',
  category: 'layer-ops',
  emittedBy: ['ps_ungroup'],
  snippetRef: 'go-core/cmd/buildtemplates/fragments_groups.go (vault.Ungroup — ungroupLayersEvent)',
  groundTruth: {
    capturedAt: '2026-06-03',
    psVersion: '27.7.0',
    platform: 'Windows',
    sourceLog: 'JS-31-Ungroup.log',
    menuPath: 'Layer > Ungroup Layers (Ctrl+Shift+G)',
  },
  knownGotchas: [
    'Event ID is `ungroupLayersEvent` as a stringID — there is NO short charID alias for ungroup in modern PS. Use `stringIDToTypeID("ungroupLayersEvent")` exclusively.',
    "The target LayerSet object becomes INVALID after the ungroup completes (it no longer exists in the document). The Editmamei snippet captures the children's names into an array BEFORE calling executeAction so they can be returned in the tool result. Don't reference the group object after the event fires.",
    'The reference uses `putEnumerated(Lyr, Ordn, Trgt)` — targets the currently active layer/group. The Editmamei snippet sets `doc.activeLayer = group` first to ensure the Trgt enum resolves to the intended group.',
  ],
  versionNotes: [
    'Capture from PS 27.7.0 Windows; `ungroupLayersEvent` has been the stable event ID since at least PS 21.',
  ],
  events: [
    {
      index: 1,
      event: stringID('ungroupLayersEvent'),
      comment:
        'Dissolve the active layer group, promoting its children to the parent. Minimal descriptor — single null reference to the target.',
      descriptor: {
        classID: charID('null'),
        fields: [
          {
            name: 'target (reference to current layer/group)',
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
              'putEnumerated(cTID("Lyr "), cTID("Ordn"), cTID("Trgt")). Targets the active layer (which must be a LayerSet/group for the event to succeed).',
          },
        ],
      },
    },
  ],
};
