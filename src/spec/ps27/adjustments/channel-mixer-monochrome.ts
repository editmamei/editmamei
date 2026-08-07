/**
 * Channel Mixer adjustment layer — Monochrome mode.
 *
 * Ground truth: PS 27.7.0 Windows, captured 2026-06-03.
 * Capture log: JS-13-Chan-Mixer-Mono.log
 *
 * The user opened a fresh PS doc, clicked Layer > New Adjustment Layer >
 * Channel Mixer, ticked Monochrome, then set R=65, G=44, B=55, Constant
 * -73.
 *
 * Monochrome mode collapses the three output-channel objects into a
 * single `Gry ` (Gray) output object:
 *   T → ChnM → {
 *     Mnch = true (boolean),
 *     Gry  → ChMx → { Rd , Grn , Bl , Cnst }   ← single gray output
 *   }
 *
 * Mnch is the discriminator — when true PS uses the Gry mix; when
 * false (or absent) PS uses the three Rd/Grn/Bl outputs.
 *
 * **Same MEDIUM `Cnst` drift as channel-mixer-rgb.ts** (audit STEP 13):
 * Cnst must be putUnitDouble(#Prc), not putInteger. Snippet has the
 * issue on both the RGB and Mono branches; one fix covers both.
 */

import type { AmEventSpec } from '../../types.js';
import { charID, stringID } from '../../types.js';

export const channelMixerMonochromeSpec: AmEventSpec = {
  id: 'adjustments/channel-mixer-monochrome',
  displayName: 'Channel Mixer adjustment layer (Monochrome on)',
  category: 'adjustments',
  emittedBy: ['ps_add_adjustment_layer'],
  snippetRef: 'go-core/cmd/buildtemplates/fragments_adjustments_types.go (vault.AdjCMMono)',
  groundTruth: {
    capturedAt: '2026-06-03',
    psVersion: '27.7.0',
    platform: 'Windows',
    sourceLog: 'JS-13-Chan-Mixer-Mono.log',
    menuPath: 'Layer > New Adjustment Layer > Channel Mixer (Monochrome ticked)',
  },
  knownGotchas: [
    'MEDIUM: Same `Cnst → putUnitDouble(#Prc)` requirement as RGB mode. Snippet currently emits putInteger; PS may miscoerce or drop. Confirmed STEP 12 + STEP 13.',
    '`Mnch` is the load-bearing boolean (charID Mnch, stringID `monochromatic` is the alias). When true, PS USES the Gry mix and ignores Rd /Grn /Bl  output objects if present.',
    '`Gry ` (Gray output) object uses `ChMx` class — same class as the RGB output-channel objects. Source-channel keys are Rd /Grn /Bl  + Cnst.',
    'When toggling Monochrome on a pre-existing layer, PS emits a setd with `Mnch=true` + the Gry object. Mk envelope only contains Mnch + Gry when created with Monochrome ticked.',
    'When Monochrome is off, the Gry object is absent — PS uses the three RGB output channel objects (see channel-mixer-rgb.ts).',
  ],
  versionNotes: [
    "Mnch charID stable across PS 23+. The sTID('monochromatic') alias has worked since CS6.",
    'Same Cnst putUnitDouble caveat as RGB mode — historic ScriptListener captures show this consistently.',
  ],
  events: [
    {
      index: 1,
      event: charID('Mk  '),
      comment:
        'Creates Channel Mixer with Monochrome on. Mk envelope holds Mnch=true and the Gry ChMx object inline (with identity defaults until user moves sliders).',
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
                  name: 'Type (the ChnM type descriptor — Monochrome variant)',
                  typeID: charID('Type'),
                  kind: 'object',
                  required: true,
                  innerShape: {
                    classID: charID('ChnM'),
                    fields: [
                      {
                        name: 'Monochrome (mode discriminator)',
                        typeID: charID('Mnch'),
                        kind: 'boolean',
                        required: true,
                        booleanDefault: false,
                        description:
                          'MUST be true for this spec. Differentiator from RGB-mode variant.',
                      },
                      {
                        name: 'Gray output channel mix',
                        typeID: charID('Gry '),
                        kind: 'object',
                        required: true,
                        innerShape: {
                          classID: charID('ChMx'),
                          fields: [
                            {
                              name: 'Red source',
                              typeID: charID('Rd  '),
                              kind: 'unitDouble',
                              required: true,
                              unit: { charID: '#Prc' },
                              range: { min: -200, max: 200, default: 40 },
                              description:
                                'Default 40% on Monochrome — the PS-canonical luminance weighting.',
                            },
                            {
                              name: 'Green source',
                              typeID: charID('Grn '),
                              kind: 'unitDouble',
                              required: true,
                              unit: { charID: '#Prc' },
                              range: { min: -200, max: 200, default: 40 },
                            },
                            {
                              name: 'Blue source',
                              typeID: charID('Bl  '),
                              kind: 'unitDouble',
                              required: true,
                              unit: { charID: '#Prc' },
                              range: { min: -200, max: 200, default: 20 },
                            },
                            {
                              name: 'Constant',
                              typeID: charID('Cnst'),
                              kind: 'unitDouble',
                              required: false,
                              unit: { charID: '#Prc' },
                              range: { min: -200, max: 200, default: 0 },
                              description:
                                'MUST be putUnitDouble(#Prc). Snippet currently emits putInteger — audit MEDIUM, same fix as RGB mode.',
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
        ],
      },
    },
    {
      index: 2,
      event: charID('setd'),
      comment:
        'Applies Monochrome mix updates. PS re-emits Mnch + Gry on every move. Skip when using create-with-values pattern.',
      descriptor: {
        classID: charID('null'),
        fields: [
          {
            name: 'target (active adjustment layer)',
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
            name: 'T (the ChnM values descriptor — Monochrome)',
            typeID: charID('T   '),
            kind: 'object',
            required: true,
            innerShape: {
              classID: charID('ChnM'),
              fields: [
                {
                  name: 'presetKind',
                  typeID: stringID('presetKind'),
                  kind: 'enum',
                  required: false,
                  enumType: stringID('presetKindType'),
                  enumValues: [{ typeID: stringID('presetKindCustom') }],
                },
                {
                  name: 'Monochrome',
                  typeID: charID('Mnch'),
                  kind: 'boolean',
                  required: true,
                  booleanDefault: true,
                },
                {
                  name: 'Gray output channel mix',
                  typeID: charID('Gry '),
                  kind: 'object',
                  required: true,
                  innerShape: {
                    classID: charID('ChMx'),
                    fields: [
                      {
                        name: 'Red source',
                        typeID: charID('Rd  '),
                        kind: 'unitDouble',
                        required: true,
                        unit: { charID: '#Prc' },
                      },
                      {
                        name: 'Green source',
                        typeID: charID('Grn '),
                        kind: 'unitDouble',
                        required: true,
                        unit: { charID: '#Prc' },
                      },
                      {
                        name: 'Blue source',
                        typeID: charID('Bl  '),
                        kind: 'unitDouble',
                        required: true,
                        unit: { charID: '#Prc' },
                      },
                      {
                        name: 'Constant',
                        typeID: charID('Cnst'),
                        kind: 'unitDouble',
                        required: false,
                        unit: { charID: '#Prc' },
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
  ],
};
