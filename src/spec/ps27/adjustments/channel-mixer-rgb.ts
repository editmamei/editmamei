/**
 * Channel Mixer adjustment layer — RGB output channels (Monochrome off).
 *
 * Ground truth: PS 27.7.0 Windows, captured 2026-06-03.
 * Capture log: JS-12-Chan-Mixer-RGB.log
 *
 * The user opened a fresh PS doc, clicked Layer > New Adjustment Layer >
 * Channel Mixer, accepted the default RGB output mode, then edited the
 * Red output channel to (R 44 / G 20 / B -36 / Constant 30).
 *
 * Channel Mixer is structurally the deepest of the adjustment layers:
 *   T → ChnM → {
 *     Rd  → ChMx → { Rd , Grn , Bl , Cnst }   ← output Red
 *     Grn → ChMx → { Rd , Grn , Bl , Cnst }   ← output Green
 *     Bl  → ChMx → { Rd , Grn , Bl , Cnst }   ← output Blue
 *   }
 *
 * Each output-channel object has its own `ChMx` class wrapping the
 * source-channel mix percentages plus a Constant. PS only emits the
 * output-channel objects the user actually edited — the Mk envelope
 * volunteers all three (with identity defaults R=100, G=100, B=100);
 * setds only carry the touched ones.
 *
 * **MEDIUM-severity drift**: Snippet emits
 * `Cnst` as putInteger; ground truth uses `putUnitDouble(Cnst, #Prc,
 * value)`. PS may silently miscoerce the integer. The fix is a
 * three-site change in the snippet (channel_mixer RGB Mk + setd + the
 * monochrome branch's same pattern).
 */

import type { AmEventSpec } from '../../types.js';
import { charID, stringID } from '../../types.js';

export const channelMixerRgbSpec: AmEventSpec = {
  id: 'adjustments/channel-mixer-rgb',
  displayName: 'Channel Mixer adjustment layer (RGB output)',
  category: 'adjustments',
  emittedBy: ['ps_add_adjustment_layer'],
  snippetRef: 'go-core/cmd/buildtemplates/fragments_adjustments_types.go (vault.AdjCMClr)',
  groundTruth: {
    capturedAt: '2026-06-03',
    psVersion: '27.7.0',
    platform: 'Windows',
    sourceLog: 'JS-12-Chan-Mixer-RGB.log',
    menuPath: 'Layer > New Adjustment Layer > Channel Mixer',
  },
  knownGotchas: [
    'MEDIUM: `Cnst` MUST be `putUnitDouble(#Prc)`, NOT putInteger. Snippet currently emits putInteger — PS may interpret as percent (50 → 50%) or drop. Three call sites in the snippet need the fix: lines 2781, 2789, 2796, 2803 (RGB branch) + the mono branch.',
    "Output-channel keys are charIDs: `Rd  ` (Red), `Grn ` (Green), `Bl  ` (Blue). Each putObject'd with class `ChMx`. The Type-level wrapper class is `ChnM` (alias of sTID('channelMixer')).",
    'Inner source-channel keys are ALSO `Rd  `/`Grn `/`Bl  ` — the same charIDs serve as both output-channel keys (on ChnM) and source-channel keys (on ChMx). PS distinguishes by enclosing object class.',
    'All source-channel mix values + Constant are `putUnitDouble(#Prc)`. Range: source channels -200..+200%, Constant -200..+200%. Defaults: identity mix (Rd=100 on Red output, Grn=100 on Green output, Bl=100 on Blue output, Cnst=0).',
    "Mk envelope volunteers all three output-channel objects at identity defaults; setds emit only the touched outputs. Editmamei's create-with-values pattern embeds the user values into Mk for atomicity.",
    'Mnch (Monochrome) boolean is ABSENT from the RGB mode — see channel-mixer-monochrome.ts for the Mnch=true variant.',
  ],
  versionNotes: [
    'Cnst as putUnitDouble(#Prc) is consistent across PS 23/24/25/26/27 captures on file. The putInteger form likely originated in CS6-era forum posts that conflated the integer-percent interpretation with the actual type.',
  ],
  events: [
    {
      index: 1,
      event: charID('Mk  '),
      comment:
        'Creates the Channel Mixer adjustment layer in RGB mode. Mk emits all three output-channel objects with identity defaults. Editmamei create-with-values embeds the user-touched output channel inline.',
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
                  name: 'Type (the ChnM type descriptor)',
                  typeID: charID('Type'),
                  kind: 'object',
                  required: true,
                  innerShape: {
                    classID: charID('ChnM'),
                    fields: [
                      {
                        name: 'presetKind',
                        typeID: stringID('presetKind'),
                        kind: 'enum',
                        required: true,
                        enumType: stringID('presetKindType'),
                        enumValues: [
                          { typeID: stringID('presetKindDefault') },
                          { typeID: stringID('presetKindCustom') },
                        ],
                      },
                      {
                        name: 'Red output channel mix',
                        typeID: charID('Rd  '),
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
                              range: { min: -200, max: 200, default: 100 },
                            },
                            {
                              name: 'Green source',
                              typeID: charID('Grn '),
                              kind: 'unitDouble',
                              required: false,
                              unit: { charID: '#Prc' },
                              range: { min: -200, max: 200, default: 0 },
                            },
                            {
                              name: 'Blue source',
                              typeID: charID('Bl  '),
                              kind: 'unitDouble',
                              required: false,
                              unit: { charID: '#Prc' },
                              range: { min: -200, max: 200, default: 0 },
                            },
                            {
                              name: 'Constant',
                              typeID: charID('Cnst'),
                              kind: 'unitDouble',
                              required: false,
                              unit: { charID: '#Prc' },
                              range: { min: -200, max: 200, default: 0 },
                              description:
                                'MUST be putUnitDouble(#Prc) — snippet currently emits putInteger, audit MEDIUM finding.',
                            },
                          ],
                        },
                      },
                      {
                        name: 'Green output channel mix',
                        typeID: charID('Grn '),
                        kind: 'object',
                        required: true,
                        innerShape: {
                          classID: charID('ChMx'),
                          fields: [
                            {
                              name: 'Red source',
                              typeID: charID('Rd  '),
                              kind: 'unitDouble',
                              required: false,
                              unit: { charID: '#Prc' },
                              range: { min: -200, max: 200, default: 0 },
                            },
                            {
                              name: 'Green source',
                              typeID: charID('Grn '),
                              kind: 'unitDouble',
                              required: true,
                              unit: { charID: '#Prc' },
                              range: { min: -200, max: 200, default: 100 },
                            },
                            {
                              name: 'Blue source',
                              typeID: charID('Bl  '),
                              kind: 'unitDouble',
                              required: false,
                              unit: { charID: '#Prc' },
                              range: { min: -200, max: 200, default: 0 },
                            },
                            {
                              name: 'Constant',
                              typeID: charID('Cnst'),
                              kind: 'unitDouble',
                              required: false,
                              unit: { charID: '#Prc' },
                              range: { min: -200, max: 200, default: 0 },
                            },
                          ],
                        },
                      },
                      {
                        name: 'Blue output channel mix',
                        typeID: charID('Bl  '),
                        kind: 'object',
                        required: true,
                        innerShape: {
                          classID: charID('ChMx'),
                          fields: [
                            {
                              name: 'Red source',
                              typeID: charID('Rd  '),
                              kind: 'unitDouble',
                              required: false,
                              unit: { charID: '#Prc' },
                              range: { min: -200, max: 200, default: 0 },
                            },
                            {
                              name: 'Green source',
                              typeID: charID('Grn '),
                              kind: 'unitDouble',
                              required: false,
                              unit: { charID: '#Prc' },
                              range: { min: -200, max: 200, default: 0 },
                            },
                            {
                              name: 'Blue source',
                              typeID: charID('Bl  '),
                              kind: 'unitDouble',
                              required: true,
                              unit: { charID: '#Prc' },
                              range: { min: -200, max: 200, default: 100 },
                            },
                            {
                              name: 'Constant',
                              typeID: charID('Cnst'),
                              kind: 'unitDouble',
                              required: false,
                              unit: { charID: '#Prc' },
                              range: { min: -200, max: 200, default: 0 },
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
        'Applies modified output channel(s). PS only emits the output-channel objects the user edited. Snippet emits all three for safety; either approach is valid.',
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
            name: 'T (the ChnM values descriptor)',
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
                  name: 'Modified output channel (only the touched one(s) — Rd /Grn /Bl )',
                  typeID: charID('Rd  '),
                  kind: 'object',
                  required: false,
                  innerShape: {
                    classID: charID('ChMx'),
                    fields: [
                      {
                        name: 'Red source',
                        typeID: charID('Rd  '),
                        kind: 'unitDouble',
                        required: false,
                        unit: { charID: '#Prc' },
                      },
                      {
                        name: 'Green source',
                        typeID: charID('Grn '),
                        kind: 'unitDouble',
                        required: false,
                        unit: { charID: '#Prc' },
                      },
                      {
                        name: 'Blue source',
                        typeID: charID('Bl  '),
                        kind: 'unitDouble',
                        required: false,
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
                  description:
                    'Ground truth shows just the touched output channel (e.g. just Rd→ChMx{Rd=44} when user only nudged Red output). Grn and Bl follow the same shape.',
                },
              ],
            },
          },
        ],
      },
    },
  ],
};
