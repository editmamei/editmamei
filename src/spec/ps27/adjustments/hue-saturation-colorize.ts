/**
 * Hue/Saturation adjustment layer — Colorize variant.
 *
 * Ground truth: PS 27.7.0 Windows, captured 2026-06-03.
 * Capture log: JS-02-HueSat-Color.log
 *
 * The user opened a fresh PS doc, clicked Layer > New Adjustment Layer >
 * Hue/Saturation, ticked the Colorize checkbox, then set Hue +200,
 * Saturation +40, Lightness 0 in the Properties panel.
 *
 * Two events are emitted:
 *   1. `Mk AdjL` — type-default Hue/Sat with the **blend mode pinned to
 *      `Md → BlnM → Clr` (Color)**, the canonical sidecar PS attaches
 *      when colorize-on is the user intent. This is the structural cue
 *      that distinguishes the colorize variant from the master spec
 *      (see hue-saturation.ts).
 *   2. `setd Lyr/Trgt → T:HStr` with `Clrz=true`, a single `Hst2` entry
 *      in `Adjs` that **additionally carries `Chnl=Cmps` enumerated**
 *      (the colorize-only key), and the H/Strt/Lght integers.
 *
 * **Why this exists as a separate spec file:** master Hue/Sat and the
 * Colorize variant share descriptor surface but differ on two load-
 * bearing keys that snippet authors get wrong:
 *   - Master has NO `Chnl` key in the Hst2 entry; colorize REQUIRES
 *     `putEnumerated(Chnl, Chnl, Cmps)` on the Hst2.
 *   - Master uses `Clrz=false`; colorize uses `Clrz=true`.
 *
 * H values in colorize are a hue *angle* on the colorize wheel (0..360
 * conceptually), but PS still emits them as plain `putInteger`, not as
 * a unitDouble #Ang — verified by ground truth. Same shape as master,
 * different semantic interpretation by PS.
 *
 * The original drift: addAdjustmentLayer's schema
 * does NOT expose colorize today; the colorize path is reachable only
 * via the `adjust_hue_saturation` tool surface.
 */

import type { AmEventSpec } from '../../types.js';
import { charID, stringID } from '../../types.js';

export const hueSaturationColorizeSpec: AmEventSpec = {
  id: 'adjustments/hue-saturation-colorize',
  displayName: 'Hue/Saturation adjustment layer (Colorize on)',
  category: 'adjustments',
  emittedBy: ['ps_add_adjustment_layer'],
  snippetRef:
    'go-core/cmd/buildtemplates/fragments_adjustments_types.go (vault.AdjHSTd — colorize NOT exposed via schema)',
  groundTruth: {
    capturedAt: '2026-06-03',
    psVersion: '27.7.0',
    platform: 'Windows',
    sourceLog: 'JS-02-HueSat-Color.log',
    menuPath: 'Layer > New Adjustment Layer > Hue/Saturation (Colorize ticked)',
  },
  knownGotchas: [
    'Hst2 entry MUST include `putEnumerated(Chnl, Chnl, Cmps)` when Colorize is on. Master entries OMIT this key — silently ignored if you accidentally include it on master, but REQUIRED here.',
    '`Clrz=true` on the outer HStr descriptor distinguishes colorize from master. Leaving it false (or omitting it) drops the colorize semantics even if the Hst2 includes Chnl=Cmps.',
    'PS additionally pins `Md → BlnM → Clr ` (blend mode = Color) into the Mk envelope when Colorize is the user intent. Editmamei does not currently emit this — the result is a Normal-blend Hue/Sat layer with Colorize on, which behaves correctly but does not exactly mirror the PS UI workflow.',
    'addAdjustmentLayer does NOT expose a `colorize` schema field today (audit MEDIUM finding). To reach this code path the user must invoke `adjust_hue_saturation` instead.',
  ],
  versionNotes: [
    'Hst2 charID for the colorize Hue/Sat entry holds on PS 27 (consistent with the master spec). Hsrt remains the silently-ignored legacy key.',
  ],
  events: [
    {
      index: 1,
      event: charID('Mk  '),
      comment:
        'Creates the empty Hue/Sat adjustment layer with the blend mode pinned to Color (the colorize-on sidecar). The Mk envelope is otherwise identical to the master spec.',
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
            name: 'Using (the type-bearing descriptor with Color blend mode)',
            typeID: charID('Usng'),
            kind: 'object',
            required: true,
            innerShape: {
              classID: charID('AdjL'),
              fields: [
                {
                  name: 'Mode (blend mode pinned to Color)',
                  typeID: charID('Md  '),
                  kind: 'enum',
                  required: false,
                  enumType: charID('BlnM'),
                  enumValues: [
                    {
                      typeID: charID('Clr '),
                      label: 'Color',
                      context:
                        'PS attaches Color blend mode whenever Colorize is ticked in the New Layer dialog.',
                    },
                  ],
                  description:
                    'PS-emitted sidecar. Editmamei may safely omit this; the user can set blend mode separately.',
                },
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
                            context: 'PS-default — Mk-then-setd flow.',
                          },
                          {
                            typeID: stringID('presetKindCustom'),
                            context: 'Editmamei create-with-values flow.',
                          },
                        ],
                      },
                      {
                        name: 'GeneratedPreset',
                        typeID: stringID('GeneratedPreset'),
                        kind: 'boolean',
                        required: false,
                        booleanDefault: false,
                      },
                      {
                        name: 'Colorize',
                        typeID: charID('Clrz'),
                        kind: 'boolean',
                        required: true,
                        booleanDefault: false,
                        description:
                          'MUST be true for this spec. Differentiator from the master spec.',
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
        'Applies Colorize values. The Hst2 entry in Adjs includes a Chnl=Cmps enumerated key in addition to H/Strt/Lght. Skip this event entirely when using create-with-values pattern (embed the descriptor body into event 1).',
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
                  enumValues: [{ typeID: stringID('presetKindCustom') }],
                },
                {
                  name: 'Colorize',
                  typeID: charID('Clrz'),
                  kind: 'boolean',
                  required: true,
                  booleanDefault: false,
                  description: 'MUST be true. This is the colorize variant.',
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
                        name: 'Channel (Composite — colorize-only key)',
                        typeID: charID('Chnl'),
                        kind: 'enum',
                        required: true,
                        enumType: charID('Chnl'),
                        enumValues: [
                          {
                            typeID: charID('Cmps'),
                            label: 'Composite',
                            context:
                              'The colorize-only channel selector. NOT emitted on master Hst2 entries.',
                          },
                        ],
                        description:
                          'REQUIRED on colorize Hst2 entries; ABSENT on master Hst2 entries (see hue-saturation.ts).',
                      },
                      {
                        name: 'Hue',
                        typeID: charID('H   '),
                        kind: 'integer',
                        required: true,
                        range: { min: 0, max: 360, default: 0 },
                        description:
                          'Hue angle on the colorize wheel. Emitted as integer despite being conceptually a degree value.',
                      },
                      {
                        name: 'Saturation',
                        typeID: charID('Strt'),
                        kind: 'integer',
                        required: true,
                        range: { min: 0, max: 100, default: 25 },
                        description: 'Colorize saturation.',
                      },
                      {
                        name: 'Lightness',
                        typeID: charID('Lght'),
                        kind: 'integer',
                        required: true,
                        range: { min: -100, max: 100, default: 0 },
                        description: 'Colorize lightness shift.',
                      },
                    ],
                  },
                  gotchas: [
                    'Item class MUST be charID `Hst2`. Same Hsrt-vs-Hst2 silent-no-op as the master spec applies here.',
                    'Chnl=Cmps must be the FIRST key in the Hst2 entry for colorize — PS treats it as the per-entry selector.',
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
