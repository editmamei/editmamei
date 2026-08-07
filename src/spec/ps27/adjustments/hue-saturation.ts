/**
 * Hue/Saturation adjustment layer — Master entry.
 *
 * Ground truth: PS 27.7.0 Windows, captured 2026-06-03.
 * Capture log: JS-01-Hue-Sat.log
 *
 * The user opened a fresh PS doc, clicked Layer > New Adjustment Layer >
 * Hue/Saturation, accepted the New Layer dialog defaults, then set
 * Hue +30, Saturation +20, Lightness -10 in the Properties panel.
 *
 * PS emits a SEQUENCE of two events:
 *   1. `Mk AdjL` with the type-default descriptor — creates the layer
 *   2. `setd Lyr/Trgt → T:HStr` with the values — applies the values
 *
 * The canonical "create with values" pattern (see CLAUDE.md "Create
 * with values, not create-then-modify") embeds the values in event 1's
 * descriptor instead of emitting event 2. Both forms are accepted by
 * PS; Editmamei uses the embedded form for atomicity.
 *
 * **Critical gotcha (the famous Hst2/Hsrt bug):** the master entry in
 * the `Adjs` list uses charID `Hst2`. Older docs say `Hsrt`. PS 24+
 * silently ignores `Hsrt`. See CLAUDE.md "ActionManager descriptor
 * pitfalls" → "Hst2 vs Hsrt for master Hue/Saturation entries."
 */

import type { AmEventSpec } from '../../types.js';
import { charID, stringID } from '../../types.js';

export const hueSaturationSpec: AmEventSpec = {
  id: 'adjustments/hue-saturation',
  displayName: 'Hue/Saturation adjustment layer',
  category: 'adjustments',
  emittedBy: ['ps_add_adjustment_layer'],
  snippetRef:
    'go-core/adjustments.go (addAdjustmentLayer dispatch); go-core/cmd/buildtemplates/fragments_adjustments_types.go (vault.AdjHSTd)',
  groundTruth: {
    capturedAt: '2026-06-03',
    psVersion: '27.7.0',
    platform: 'Windows',
    sourceLog: 'JS-01-Hue-Sat.log',
    menuPath: 'Layer > New Adjustment Layer > Hue/Saturation',
  },
  knownGotchas: [
    'Master entry MUST use charID `Hst2`, NOT `Hsrt`. `Hsrt` is silently ignored on PS 24+. This is the canonical silent-no-op pattern that motivated the audit.',
    'Per-color-range entries (Reds, Yellows, etc.) use a different shape than the master `Hst2` entry — they also include a `BgnR`/`EdnR`/`BgnS`/`EdnS` hue-range quad. This spec covers the MASTER entry only; see hue-saturation-colorize.ts for the Colorize variant.',
    'When the Properties panel reads "Master", PS emits `Hst2` ONLY. Other range entries are emitted as separate `Hst2`-shaped objects in the same `Adjs` list only when the user touches those ranges.',
  ],
  versionNotes: [
    'PS 23 and earlier used `Hsrt` (legacy). The transition to `Hst2` happened in PS 24. The legacy key still parses but does not affect pixels on modern PS.',
  ],
  events: [
    {
      index: 1,
      event: charID('Mk  '),
      comment:
        'Creates the empty adjustment layer with type=HStr. The Usng descriptor establishes the layer class (AdjL) and the adjustment type (HStr) with defaults. Editmamei can EITHER emit this exactly as PS does (then setd in event 2) OR embed the values inline in this Mk descriptor (create-with-values) and skip event 2.',
      descriptor: {
        classID: charID('null'),
        fields: [
          {
            name: 'target (null reference to AdjL class)',
            typeID: charID('null'),
            kind: 'reference',
            required: true,
            referenceShape: {
              classID: charID('AdjL'),
              variant: 'class',
            },
          },
          {
            name: 'Using (the type-bearing descriptor)',
            typeID: charID('Usng'),
            kind: 'object',
            required: true,
            innerShape: {
              classID: charID('AdjL'),
              fields: [
                {
                  name: 'Type (the HStr type descriptor)',
                  typeID: charID('Type'),
                  kind: 'object',
                  required: true,
                  innerShape: {
                    classID: charID('HStr'),
                    fields: [
                      {
                        name: 'presetKind',
                        typeID: stringID('presetKind'),
                        kind: 'enum',
                        required: true,
                        enumType: stringID('presetKindType'),
                        enumValues: [
                          {
                            typeID: stringID('presetKindDefault'),
                            context: 'Layer created with no user values — accept all defaults',
                          },
                          {
                            typeID: stringID('presetKindCustom'),
                            context:
                              'Layer being created with user-supplied values (create-with-values pattern)',
                          },
                        ],
                      },
                      {
                        name: 'GeneratedPreset',
                        typeID: stringID('GeneratedPreset'),
                        kind: 'boolean',
                        required: false,
                        booleanDefault: false,
                        description:
                          'False means the user (not a Photoshop preset library) authored these values.',
                      },
                      {
                        name: 'Colorize',
                        typeID: charID('Clrz'),
                        kind: 'boolean',
                        required: true,
                        booleanDefault: false,
                        description:
                          'False = master/range adjustment; True = colorize (see hue-saturation-colorize.ts).',
                      },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    },
    {
      index: 2,
      event: charID('setd'),
      comment:
        'Applies the user-supplied Hue/Saturation values to the layer just created. The Adjs list holds one Hst2 object per affected range — for "Master" only the single Hst2 entry. Skip this entire event when using the create-with-values pattern (the same descriptor body would then be embedded into event 1).',
      descriptor: {
        classID: charID('null'),
        fields: [
          {
            name: 'target (the active adjustment layer)',
            typeID: charID('null'),
            kind: 'reference',
            required: true,
            referenceShape: {
              classID: charID('AdjL'),
              variant: 'enumerated',
              enumKey: charID('Ordn'),
              enumValue: charID('Trgt'),
            },
          },
          {
            name: 'T (the HStr values descriptor)',
            typeID: charID('T   '),
            kind: 'object',
            required: true,
            innerShape: {
              classID: charID('HStr'),
              fields: [
                {
                  name: 'presetKind',
                  typeID: stringID('presetKind'),
                  kind: 'enum',
                  required: true,
                  enumType: stringID('presetKindType'),
                  enumValues: [
                    {
                      typeID: stringID('presetKindCustom'),
                      context: 'Always presetKindCustom in a setd that carries user values.',
                    },
                  ],
                },
                {
                  name: 'Colorize',
                  typeID: charID('Clrz'),
                  kind: 'boolean',
                  required: true,
                  booleanDefault: false,
                  description:
                    'Always false in this master-entry spec. Colorize variant lives in hue-saturation-colorize.ts.',
                },
                {
                  name: 'Adjustments list',
                  typeID: charID('Adjs'),
                  kind: 'list',
                  required: true,
                  itemSchema: {
                    classID: charID('Hst2'),
                    fields: [
                      {
                        name: 'Hue',
                        typeID: charID('H   '),
                        kind: 'integer',
                        required: true,
                        range: { min: -180, max: 180, default: 0 },
                        description: 'Hue shift in degrees.',
                      },
                      {
                        name: 'Saturation',
                        typeID: charID('Strt'),
                        kind: 'integer',
                        required: true,
                        range: { min: -100, max: 100, default: 0 },
                        description: 'Saturation shift.',
                      },
                      {
                        name: 'Lightness',
                        typeID: charID('Lght'),
                        kind: 'integer',
                        required: true,
                        range: { min: -100, max: 100, default: 0 },
                        description: 'Lightness shift.',
                      },
                    ],
                  },
                  gotchas: [
                    'Item class MUST be charID `Hst2` for the master entry. `Hsrt` is the legacy key — silently no-ops on PS 24+.',
                    'Even when the user only moves one slider, ALL THREE keys (H, Strt, Lght) are required in the item. Omitting any silently coerces it to the previous-saved value, NOT to zero.',
                  ],
                },
              ],
            },
          },
        ],
      },
    },
  ],
};
