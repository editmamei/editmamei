/**
 * Exposure adjustment layer.
 *
 * Ground truth: PS 27.7.0 Windows, captured 2026-06-03.
 * Capture log: JS-17-Exposure.log
 *
 * The user opened a fresh PS doc, clicked Layer > New Adjustment Layer >
 * Exposure, accepted defaults, then nudged Exposure to +0.61, Offset
 * to -0.0202, and (in a subsequent setd) gamma to ~1.1.
 *
 * Shape:
 *   Mk: Type → Exps → { presetKindDefault, Exps=0.0, Ofst=0.0, gammaCorrection=1.0 }
 *   setd: T → Exps → { presetKindCustom, Exps=value, Ofst=value }
 *   (gamma is in the Mk but also re-emittable via setd)
 *
 * Verdict: OK — snippet matches ground truth.
 * Notable: `Exps` is used both as the type-class charID AND as the
 * exposure-value charID. PS distinguishes by descriptor context (the
 * inner Exps key holds a putDouble; the outer Exps class wraps the
 * descriptor). Adobe aliases sTID('exposure') and cTID('Exps') to the
 * same typeID — interoperable.
 */

import type { AmEventSpec } from '../../types.js';
import { charID, stringID } from '../../types.js';

export const exposureSpec: AmEventSpec = {
  id: 'adjustments/exposure',
  displayName: 'Exposure adjustment layer',
  category: 'adjustments',
  emittedBy: ['ps_add_adjustment_layer'],
  snippetRef: 'go-core/cmd/buildtemplates/fragments_adjustments_types.go (vault.AdjExpTd)',
  groundTruth: {
    capturedAt: '2026-06-03',
    psVersion: '27.7.0',
    platform: 'Windows',
    sourceLog: 'JS-17-Exposure.log',
    menuPath: 'Layer > New Adjustment Layer > Exposure',
  },
  knownGotchas: [
    "`Exps` charID is reused: outer class wraps the descriptor; inner key holds the exposure value. PS distinguishes by descriptor context. Adobe aliases sTID('exposure') to the same typeID — interoperable, snippet uses the stringID.",
    "`Ofst` charID (Offset) — Adobe aliases sTID('offset') to the same typeID.",
    '`gammaCorrection` is the stringID-only field for gamma. Range 0.01..9.99, default 1.0. PS rejects values outside this range with a "value out of range" error.',
    'All three values are putDouble — NOT putInteger. Exposure is in stops (-20..+20 EV); Offset in normalized 0-relative (-0.5..+0.5); gamma is the gamma exponent.',
    'PS emits `presetKindDefault` on the Mk and `presetKindCustom` on subsequent setds. The snippet emits `presetKindCustom` inline on the Mk via create-with-values — PS accepts the extra key.',
    'PS may emit setds with only the touched value (e.g. just Exps in the first setd, then Exps+Ofst in the second after the user nudged offset). Snippet always emits all three.',
  ],
  versionNotes: [
    "Exps and Ofst as putDouble has been stable since PS 22. The pre-CS6 form used integer scaled values; that's no longer accepted.",
  ],
  events: [
    {
      index: 1,
      event: charID('Mk  '),
      comment:
        'Creates the Exposure adjustment layer with all three values at PS defaults (0.0, 0.0, 1.0). Editmamei embeds user values inline via create-with-values.',
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
                  name: 'Type (the Exps type descriptor)',
                  typeID: charID('Type'),
                  kind: 'object',
                  required: true,
                  innerShape: {
                    classID: charID('Exps'),
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
                        name: 'Exposure (in stops)',
                        typeID: charID('Exps'),
                        kind: 'double',
                        required: true,
                        range: { min: -20, max: 20, default: 0 },
                        description:
                          "Stops of exposure change. sTID('exposure') is an Adobe alias.",
                      },
                      {
                        name: 'Offset',
                        typeID: charID('Ofst'),
                        kind: 'double',
                        required: true,
                        range: { min: -0.5, max: 0.5, default: 0 },
                        description: "0-relative offset. sTID('offset') is an Adobe alias.",
                      },
                      {
                        name: 'Gamma Correction',
                        typeID: stringID('gammaCorrection'),
                        kind: 'double',
                        required: true,
                        range: { min: 0.01, max: 9.99, default: 1.0 },
                        description:
                          'Gamma exponent. Outside-range values cause PS to throw "value out of range".',
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
        'Applies updated Exposure/Offset/Gamma. PS may emit only the touched value(s) — when user nudges Exposure first, the first setd carries only Exps; subsequent setd after they touch Offset carries Exps+Ofst.',
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
            name: 'T (the Exps values descriptor)',
            typeID: charID('T   '),
            kind: 'object',
            required: true,
            innerShape: {
              classID: charID('Exps'),
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
                  name: 'Exposure',
                  typeID: charID('Exps'),
                  kind: 'double',
                  required: false,
                  range: { min: -20, max: 20 },
                },
                {
                  name: 'Offset',
                  typeID: charID('Ofst'),
                  kind: 'double',
                  required: false,
                  range: { min: -0.5, max: 0.5 },
                },
                {
                  name: 'Gamma Correction',
                  typeID: stringID('gammaCorrection'),
                  kind: 'double',
                  required: false,
                  range: { min: 0.01, max: 9.99 },
                },
              ],
            },
          },
        ],
      },
    },
  ],
};
