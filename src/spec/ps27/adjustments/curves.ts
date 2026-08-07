/**
 * Curves adjustment layer.
 *
 * Ground truth: PS 27.7.0 Windows, captured 2026-06-03.
 * Capture log: JS-04-curves.log
 *
 * The user opened a fresh PS doc, clicked Layer > New Adjustment Layer >
 * Curves, accepted defaults, then dragged a small S-curve on the RGB
 * channel. The capture recorded the Mk envelope plus a setd that only
 * carried the auto-ML toggle keys (`autoMachineLearning`/`autoFaces`)
 * — the curve-point drags never made it into ScriptListener (PS evidently
 * dispatches point edits through a path that bypasses the recorder).
 *
 * Therefore this spec MIXES two truth sources:
 *   1. The Mk envelope shape and the `CrvA → Chnl=Cmps (reference)`
 *      wrapper come directly from the 2026-06-03 ground truth.
 *   2. The point-list inner shape (`Crv` list of `CrPt` objects with
 *      `Hrzn`/`Vrtc` doubles) comes from prior ScriptListener evidence
 *      pinned by the 2026-05-30 Bundle Q1 fix (replaced the broken
 *      legacy `Pnt ` key) and matches PS24/25/26 captures on file.
 *
 * **MEDIUM-severity drift the audit flagged (STEP 04):** snippet emits
 * `Chnl` as `putEnumerated`; ground truth uses `putReference` carrying
 * an ActionReference with the channel enumerated. Both forms are
 * accepted by some PS versions, but the canonical PS 2026 shape is
 * the reference form. Audit recommends switching.
 */

import type { AmEventSpec } from '../../types.js';
import { charID, stringID } from '../../types.js';

export const curvesSpec: AmEventSpec = {
  id: 'adjustments/curves',
  displayName: 'Curves adjustment layer',
  category: 'adjustments',
  emittedBy: ['ps_add_adjustment_layer'],
  snippetRef:
    'go-core/cmd/buildtemplates/fragments_adjustments.go (vault.AdjCrvPM — curves post-Mk setd)',
  groundTruth: {
    capturedAt: '2026-06-03',
    psVersion: '27.7.0',
    platform: 'Windows',
    sourceLog: 'JS-04-curves.log',
    menuPath: 'Layer > New Adjustment Layer > Curves',
  },
  knownGotchas: [
    'Chnl in the CrvA entry MUST be a putReference whose ActionReference enumerates `(Chnl class, Chnl key, channel value)` — NOT putEnumerated. Ground truth: `ref.putEnumerated(idChnl, idChnl, idCmps); desc.putReference(idChnl, ref)`. Snippet currently uses putEnumerated directly — audit MEDIUM finding.',
    'Per-channel curves go in the Adjs list with one CrvA entry per channel. Composite (Cmps), Red (Rd  ), Green (Grn ), Blue (Bl  ) are the four channels for RGB documents.',
    'Curve points live in a Crv list of CrPt objects. CrPt was the 2026-05-30 Bundle Q1 fix replacing legacy `Pnt ` — using Pnt silently drops the points. Each CrPt holds `Hrzn` (input 0-255) and `Vrtc` (output 0-255) as putDouble.',
    'The capture log does NOT contain the actual curve-point setd events — PS dispatches drag-completed point edits through a recorder-bypassing path. The `Crv`/`CrPt`/`Hrzn`/`Vrtc` shape comes from prior captures, not from JS-04-curves.log directly.',
    '`TrnF=0` integer in the Mk envelope means "Transfer Function disabled" — the curve is the only adjustment. PS emits this; Editmamei may safely omit.',
    "autoMachineLearning + autoFaces booleans toggle PS 27's auto-curve features. Default true on a fresh adjustment layer; not relevant to scripted curve-point writing.",
  ],
  versionNotes: [
    'PS 23 and earlier accepted `Pnt ` for point objects; PS 24+ requires `CrPt`. The legacy key parses but silently drops points.',
    'autoMachineLearning + autoFaces appeared in PS 25 (the "Curves auto-AI" addition). Older PS versions reject them — emit only when targeting PS 25+.',
    'The Chnl putReference vs putEnumerated drift has bounced across PS major versions. Putting it through ActionReference is the PS 2026 ground truth; older versions accepted both.',
  ],
  events: [
    {
      index: 1,
      event: charID('Mk  '),
      comment:
        'Creates the empty Curves adjustment layer. Mk typeDesc holds `TrnF=0` (transfer-function disabled) and `presetKindDefault`. No curve points emitted at create time in the PS UI flow; Editmamei embeds the points inline via the setd descriptor body.',
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
                  name: 'Type (the Crvs type descriptor)',
                  typeID: charID('Type'),
                  kind: 'object',
                  required: true,
                  innerShape: {
                    classID: charID('Crvs'),
                    fields: [
                      {
                        name: 'TransferFunction (disabled)',
                        typeID: charID('TrnF'),
                        kind: 'integer',
                        required: false,
                        range: { min: 0, max: 1, default: 0 },
                        description:
                          '0 = curve mode (the normal case). 1 = transfer function mode (rarely used).',
                      },
                      {
                        name: 'presetKind',
                        typeID: stringID('presetKind'),
                        kind: 'enum',
                        required: true,
                        enumType: stringID('presetKindType'),
                        enumValues: [
                          { typeID: stringID('presetKindDefault') },
                          {
                            typeID: stringID('presetKindCustom'),
                            context: 'When create-with-values embeds the Crv list.',
                          },
                        ],
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
        'Applies the curve points. Adjs list holds one CrvA entry per channel. Each CrvA has a Chnl=Cmps putReference and a Crv list of CrPt objects (Hrzn/Vrtc doubles). The ground-truth capture only recorded the auto-ML toggle path — the Crv/CrPt shape comes from prior captures.',
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
            name: 'T (the Crvs values descriptor)',
            typeID: charID('T   '),
            kind: 'object',
            required: true,
            innerShape: {
              classID: charID('Crvs'),
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
                  name: 'Adjustments list (per-channel curves)',
                  typeID: charID('Adjs'),
                  kind: 'list',
                  required: true,
                  itemSchema: {
                    classID: charID('CrvA'),
                    fields: [
                      {
                        name: 'Channel (reference to channel enum)',
                        typeID: charID('Chnl'),
                        kind: 'reference',
                        required: true,
                        referenceShape: {
                          classID: charID('Chnl'),
                          variant: 'enumerated',
                          enumKey: charID('Chnl'),
                          enumValue: charID('Cmps'),
                        },
                        description:
                          'CANONICAL: putReference (ActionReference→enumerated). NOT putEnumerated. Snippet drift flagged in audit STEP 04.',
                      },
                      {
                        name: 'Curve points',
                        typeID: charID('Crv '),
                        kind: 'list',
                        required: false,
                        itemSchema: {
                          classID: charID('CrPt'),
                          fields: [
                            {
                              name: 'Horizontal (input 0-255)',
                              typeID: charID('Hrzn'),
                              kind: 'double',
                              required: true,
                              range: { min: 0, max: 255 },
                            },
                            {
                              name: 'Vertical (output 0-255)',
                              typeID: charID('Vrtc'),
                              kind: 'double',
                              required: true,
                              range: { min: 0, max: 255 },
                            },
                          ],
                        },
                        gotchas: [
                          'CrPt is the canonical PS 24+ point-item class. Legacy `Pnt ` silently drops points.',
                          'Hrzn/Vrtc are putDouble — PS records them with fractional values (e.g. 31.500000) when the user nudges between integer steps.',
                          'Curve must have at least two points (endpoints). Fewer points causes PS to insert a straight 0,0 → 255,255 line.',
                        ],
                      },
                      {
                        name: 'autoMachineLearning',
                        typeID: stringID('autoMachineLearning'),
                        kind: 'boolean',
                        required: false,
                        booleanDefault: true,
                        description:
                          'PS 25+ auto-curve toggle. Irrelevant when scripting explicit Crv points; PS emits true on fresh layers.',
                      },
                      {
                        name: 'autoFaces',
                        typeID: stringID('autoFaces'),
                        kind: 'boolean',
                        required: false,
                        booleanDefault: true,
                        description:
                          'PS 25+ face-aware curve toggle. Same caveat as autoMachineLearning.',
                      },
                    ],
                  },
                  gotchas: [
                    'One CrvA entry per channel touched. RGB Composite (Cmps), Red, Green, Blue are valid channel-enum values for RGB documents.',
                    'When the user only edits the Composite curve, ONLY a Cmps CrvA entry is emitted — the per-channel entries are absent. Snippet must NOT emit empty per-channel CrvAs.',
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
