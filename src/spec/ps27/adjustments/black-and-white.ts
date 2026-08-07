/**
 * Black & White adjustment layer.
 *
 * Ground truth: PS 27.7.0 Windows, captured 2026-06-03.
 * Capture log: JS-06-BW.log
 *
 * The user opened a fresh PS doc, clicked Layer > New Adjustment Layer >
 * Black & White, edited Reds to 40, Yellows to 60, Greens to 40,
 * Cyans to 60, Blues to 20, Magentas to 80, and provided a tint color.
 * The Mk envelope captured all six color-channel integers plus a
 * `tintColor` RGBC object inline (no separate setd needed).
 *
 * Group A audit (STEP 06) classified this OK — snippet matches ground
 * truth. All six color-channel keys (`Rd `, `Yllw`, `Grn `, `Cyn `,
 * `Bl  `, `Mgnt`) and the `useTint`/`tintColor` shape are correct.
 *
 * Useful trivia: PS emits `BanW` as the type charID (Black-and-White),
 * which is what the snippet's `sTID('blackAndWhite')` resolves to —
 * Adobe aliases these in its type table.
 */

import type { AmEventSpec } from '../../types.js';
import { charID, stringID } from '../../types.js';

export const blackAndWhiteSpec: AmEventSpec = {
  id: 'adjustments/black-and-white',
  displayName: 'Black & White adjustment layer',
  category: 'adjustments',
  emittedBy: ['ps_add_adjustment_layer'],
  snippetRef: 'go-core/cmd/buildtemplates/fragments_adjustments_types.go (vault.AdjBWTd)',
  groundTruth: {
    capturedAt: '2026-06-03',
    psVersion: '27.7.0',
    platform: 'Windows',
    sourceLog: 'JS-06-BW.log',
    menuPath: 'Layer > New Adjustment Layer > Black & White',
  },
  knownGotchas: [
    'All six color-channel keys MUST appear (`Rd `, `Yllw`, `Grn `, `Cyn `, `Bl  `, `Mgnt`) as putIntegers. Omitting any silently coerces to previous-saved values. Defaults per PS: Rd=40, Yllw=60, Grn=40, Cyn=60, Bl=20, Mgnt=80.',
    'useTint boolean gates the `tintColor` key. When useTint=false, PS still emits tintColor with the last-known RGB doubles — Editmamei may safely include or omit.',
    'tintColor is an RGBC putObject with Rd/Grn/Bl as putDouble (0..255). HSB→RGB conversion happens client-side; PS stores RGB.',
    "Type charID is `BanW` (ground truth); snippet uses `sTID('blackAndWhite')` which aliases to the same typeID.",
  ],
  versionNotes: [
    'PS 25+ added the tintColor object as an inline child of the BanW typeDesc. Older PS used a separate tint-color event.',
  ],
  events: [
    {
      index: 1,
      event: charID('Mk  '),
      comment:
        'Creates the Black & White adjustment layer. The Mk typeDesc is rich — all six color-channel keys + useTint + tintColor inline. PS does NOT emit a separate setd when all values land in the Mk (single-event op).',
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
                  name: 'Type (the BanW type descriptor)',
                  typeID: charID('Type'),
                  kind: 'object',
                  required: true,
                  innerShape: {
                    classID: charID('BanW'),
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
                        name: 'Reds',
                        typeID: charID('Rd  '),
                        kind: 'integer',
                        required: true,
                        range: { min: -200, max: 300, default: 40 },
                      },
                      {
                        name: 'Yellows',
                        typeID: charID('Yllw'),
                        kind: 'integer',
                        required: true,
                        range: { min: -200, max: 300, default: 60 },
                      },
                      {
                        name: 'Greens',
                        typeID: charID('Grn '),
                        kind: 'integer',
                        required: true,
                        range: { min: -200, max: 300, default: 40 },
                      },
                      {
                        name: 'Cyans',
                        typeID: charID('Cyn '),
                        kind: 'integer',
                        required: true,
                        range: { min: -200, max: 300, default: 60 },
                      },
                      {
                        name: 'Blues',
                        typeID: charID('Bl  '),
                        kind: 'integer',
                        required: true,
                        range: { min: -200, max: 300, default: 20 },
                      },
                      {
                        name: 'Magentas',
                        typeID: charID('Mgnt'),
                        kind: 'integer',
                        required: true,
                        range: { min: -200, max: 300, default: 80 },
                      },
                      {
                        name: 'useTint',
                        typeID: stringID('useTint'),
                        kind: 'boolean',
                        required: true,
                        booleanDefault: false,
                      },
                      {
                        name: 'tintColor (RGBC color object)',
                        typeID: stringID('tintColor'),
                        kind: 'object',
                        required: false,
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
                        description:
                          'PS emits this even when useTint=false (carries the last user tint). Editmamei may omit when useTint=false.',
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
