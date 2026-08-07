/**
 * Gradient Map adjustment layer — default Foreground-to-Background.
 *
 * Ground truth: PS 27.7.0 Windows, captured 2026-06-03.
 * Capture log: JS-15-Grad-Map.log
 *
 * The user opened a fresh PS doc, clicked Layer > New Adjustment Layer >
 * Gradient Map, accepted the default Foreground-to-Background gradient
 * (no Reverse, no Dither). PS emitted the entire gradient definition
 * inline in the Mk envelope — color stops, transparency stops, all of it.
 *
 * Shape:
 *   T → GdMp → {
 *     gradientsInterpolationMethod = Smoo enum,
 *     Grad → Grdn → {
 *       Nm  = "Foreground to Background" string,
 *       GrdF = CstS (custom stops) enum,
 *       Intr = 4096 double (interpolation length, PS internal scale),
 *       Clrs = list[ Clrt → { Clr → RGBC{r,g,b}, Type=UsrS, Lctn, Mdpn } ... ],
 *       Trns = list[ TrnS → { Opct unitDouble #Prc, Lctn, Mdpn } ... ]
 *     }
 *   }
 *
 * Group A audit (STEP 15) classified LOW: snippet uses
 * `sTID('interfaceIconFrameDimmed')` for the 4096 value — that stringID
 * IS an Adobe-symbol-table alias for `Intr` (interpolation length, charID),
 * same typeID, works fine but reads bizarrely. The audit recommended
 * renaming to `cTID('Intr')` for clarity.
 *
 * The Dthr (Dither) and Rvrs (Reverse) booleans are absent from this
 * default-state Mk envelope — they appear in the setd when the user
 * ticks them later (see gradient-map-reverse-dither.ts).
 */

import type { AmEventSpec } from '../../types.js';
import { charID, stringID } from '../../types.js';

export const gradientMapDefaultSpec: AmEventSpec = {
  id: 'adjustments/gradient-map-default',
  displayName: 'Gradient Map adjustment layer (default gradient, no Reverse/Dither)',
  category: 'adjustments',
  emittedBy: ['ps_add_adjustment_layer'],
  snippetRef: 'go-core/cmd/buildtemplates/fragments_adjustments_types.go (vault.AdjGMTd)',
  groundTruth: {
    capturedAt: '2026-06-03',
    psVersion: '27.7.0',
    platform: 'Windows',
    sourceLog: 'JS-15-Grad-Map.log',
    menuPath: 'Layer > New Adjustment Layer > Gradient Map',
  },
  knownGotchas: [
    "`Intr` charID (interpolation length, 4096 = \"1.0\" on PS internal scale) is silently aliased by sTID('interfaceIconFrameDimmed') in Adobe's symbol table — both resolve to the same typeID. Snippet uses the bizarre stringID; audit recommended `cTID('Intr')` for readability.",
    '`Grad → Grdn` is the outer gradient wrapper. The `Grdn` class on the inner descriptor distinguishes a gradient definition from other Grad uses.',
    '`Nm  ` (Name) charID — gradient name as a string. PS UI shows this. Editmamei writes `editmamei_<preset>` — PS does not recognize as a built-in but accepts the name.',
    '`GrdF = CstS` (Gradient Form = Custom Stops) enum is the canonical kind for the stop-based gradients. Other GrdF values (e.g. `ClNs` for color noise) use different inner shapes.',
    '`Clrs` list holds color-stop objects, class `Clrt`. Each Clrt has: `Clr → RGBC{Rd,Grn,Bl doubles 0..255}`, `Type=Clry enum (UsrS=user-supplied or BckC=background/foreground-locked)`, `Lctn` (location 0..4096 integer), `Mdpn` (midpoint 0..100 integer).',
    '`Trns` list holds transparency-stop objects, class `TrnS`. Each TrnS has: `Opct → unitDouble #Prc`, `Lctn`, `Mdpn`.',
    "Location values are scaled 0..4096 (NOT 0..100 like percentages). 0 = left edge, 4096 = right edge. PS's 4096-scale is consistent across gradient location/intr keys.",
    'gradientsInterpolationMethod (`Smoo`/`Lnr `/`StrI`) defaults to `Smoo` (smooth). Editmamei does not currently expose this — relies on PS default.',
  ],
  versionNotes: [
    'PS 23 and earlier may have accepted `Intr` only (no interfaceIconFrameDimmed alias); modern PS accepts either.',
    'gradientsInterpolationMethod was added in PS 24+. Older PS used a fixed Smoo interpolation.',
  ],
  events: [
    {
      index: 1,
      event: charID('Mk  '),
      comment:
        'Creates the Gradient Map adjustment layer with the entire gradient definition inline. Single-event op for default-state creation.',
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
                  name: 'Type (the GdMp type descriptor)',
                  typeID: charID('Type'),
                  kind: 'object',
                  required: true,
                  innerShape: {
                    classID: charID('GdMp'),
                    fields: [
                      {
                        name: 'gradientsInterpolationMethod',
                        typeID: stringID('gradientsInterpolationMethod'),
                        kind: 'enum',
                        required: false,
                        enumType: stringID('gradientInterpolationMethodType'),
                        enumValues: [
                          { typeID: charID('Smoo'), label: 'Smooth (default)' },
                          { typeID: charID('Lnr '), label: 'Linear' },
                          { typeID: charID('StrI'), label: 'Stripes/striped' },
                        ],
                      },
                      {
                        name: 'Gradient',
                        typeID: charID('Grad'),
                        kind: 'object',
                        required: true,
                        innerShape: {
                          classID: charID('Grdn'),
                          fields: [
                            {
                              name: 'Name',
                              typeID: charID('Nm  '),
                              kind: 'string',
                              required: true,
                              stringDefault: 'Foreground to Background',
                            },
                            {
                              name: 'Gradient Form',
                              typeID: charID('GrdF'),
                              kind: 'enum',
                              required: true,
                              enumType: charID('GrdF'),
                              enumValues: [
                                { typeID: charID('CstS'), label: 'Custom Stops (the normal case)' },
                                {
                                  typeID: charID('ClNs'),
                                  label: 'Color Noise (different inner shape — not handled here)',
                                },
                              ],
                            },
                            {
                              name: 'Interpolation length (4096 = full scale)',
                              typeID: charID('Intr'),
                              kind: 'double',
                              required: true,
                              range: { default: 4096 },
                              description:
                                "Adobe-symbol-table aliased by sTID('interfaceIconFrameDimmed') — same typeID, different cryptic name. Prefer cTID('Intr') for readability.",
                            },
                            {
                              name: 'Color stops list',
                              typeID: charID('Clrs'),
                              kind: 'list',
                              required: true,
                              itemSchema: {
                                classID: charID('Clrt'),
                                fields: [
                                  {
                                    name: 'Color (RGB color object)',
                                    typeID: charID('Clr '),
                                    kind: 'object',
                                    required: true,
                                    innerShape: {
                                      classID: charID('RGBC'),
                                      fields: [
                                        {
                                          name: 'Red',
                                          typeID: charID('Rd  '),
                                          kind: 'double',
                                          required: true,
                                          range: { min: 0, max: 255 },
                                        },
                                        {
                                          name: 'Green',
                                          typeID: charID('Grn '),
                                          kind: 'double',
                                          required: true,
                                          range: { min: 0, max: 255 },
                                        },
                                        {
                                          name: 'Blue',
                                          typeID: charID('Bl  '),
                                          kind: 'double',
                                          required: true,
                                          range: { min: 0, max: 255 },
                                        },
                                      ],
                                    },
                                  },
                                  {
                                    name: 'Type (color-stop kind)',
                                    typeID: charID('Type'),
                                    kind: 'enum',
                                    required: true,
                                    enumType: charID('Clry'),
                                    enumValues: [
                                      { typeID: charID('UsrS'), label: 'User-supplied' },
                                      {
                                        typeID: charID('BckC'),
                                        label: 'Foreground/background-locked',
                                      },
                                    ],
                                  },
                                  {
                                    name: 'Location (0..4096 scale)',
                                    typeID: charID('Lctn'),
                                    kind: 'integer',
                                    required: true,
                                    range: { min: 0, max: 4096 },
                                  },
                                  {
                                    name: 'Midpoint (0..100 percentage)',
                                    typeID: charID('Mdpn'),
                                    kind: 'integer',
                                    required: true,
                                    range: { min: 0, max: 100, default: 50 },
                                  },
                                ],
                              },
                            },
                            {
                              name: 'Transparency stops list',
                              typeID: charID('Trns'),
                              kind: 'list',
                              required: true,
                              itemSchema: {
                                classID: charID('TrnS'),
                                fields: [
                                  {
                                    name: 'Opacity (#Prc unitDouble)',
                                    typeID: charID('Opct'),
                                    kind: 'unitDouble',
                                    required: true,
                                    unit: { charID: '#Prc' },
                                    range: { min: 0, max: 100, default: 100 },
                                  },
                                  {
                                    name: 'Location (0..4096 scale)',
                                    typeID: charID('Lctn'),
                                    kind: 'integer',
                                    required: true,
                                    range: { min: 0, max: 4096 },
                                  },
                                  {
                                    name: 'Midpoint (0..100 percentage)',
                                    typeID: charID('Mdpn'),
                                    kind: 'integer',
                                    required: true,
                                    range: { min: 0, max: 100, default: 50 },
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
        ],
      },
    },
  ],
};
