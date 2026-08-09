/**
 * Color Balance adjustment layer (with Preserve Luminosity on).
 *
 * Ground truth: PS 27.7.0 Windows, captured 2026-06-03.
 * Capture log: JS-07-Color-Bal.log
 *
 * The user opened a fresh PS doc, clicked Layer > New Adjustment Layer >
 * Color Balance, accepted defaults (Preserve Luminosity ticked, all
 * sliders at 0), then nudged Midtones Cyan-Red +20 and Yellow-Blue -21,
 * later added Highlights Cyan-Red +14.
 *
 * The Mk envelope emits all three range-list keys (`ShdL`, `MdtL`, `HghL`)
 * as default 3-int lists `[0, 0, 0]` plus `PrsL` boolean. Subsequent
 * setd events only re-emit the range lists the user actually touched.
 *
 * Verdict: OK — the 2026-05-31
 * fix that replaced the forum-lore `Mdtn`/`Lmnc` keys with the canonical
 * `MdtL`/`PrsL` is durable.
 *
 * Per-range list shape: `[cyanRed, magentaGreen, yellowBlue]` integers,
 * each in [-100, +100]. Order matters — PS interprets list index, not
 * key names.
 */

import type { AmEventSpec } from '../../types.js';
import { charID } from '../../types.js';

export const colorBalanceSpec: AmEventSpec = {
  id: 'adjustments/color-balance',
  displayName: 'Color Balance adjustment layer',
  category: 'adjustments',
  emittedBy: ['ps_add_adjustment_layer'],
  snippetRef: 'go-core/cmd/buildtemplates/fragments_adjustments_types.go (vault.AdjCBTd)',
  groundTruth: {
    capturedAt: '2026-06-03',
    psVersion: '27.7.0',
    platform: 'Windows',
    sourceLog: 'JS-07-Color-Bal.log',
    menuPath: 'Layer > New Adjustment Layer > Color Balance',
  },
  knownGotchas: [
    'Range keys are `ShdL` (Shadows), `MdtL` (Midtones), `HghL` (Highlights) — the 2026-05-31 fix replaced the forum-lore `Mdtn`/`Hghl`/`Shdw` which silently no-opped on modern PS.',
    'Each range key holds a 3-int list `[cyanRed, magentaGreen, yellowBlue]`. Order is positional — PS does NOT key by axis name. Mixing the order silently shifts colors along the wrong axes.',
    '`PrsL` (Preserve Luminosity) is the canonical key — the legacy `Lmnc` is silently ignored.',
    "Mk envelope ALWAYS emits all three range lists with `[0, 0, 0]` defaults; setd only re-emits the touched ranges. Editmamei's create-with-values flow embeds all three range lists into Mk with the user values for atomicity.",
    'Range values clamp to [-100, +100] in the PS UI; descriptor accepts wider but PS clamps internally.',
  ],
  versionNotes: [
    'PS 23 and earlier may have accepted `Mdtn`/`Hghl`/`Shdw` along with the canonical keys; PS 24+ requires the canonical -L suffix forms.',
    '`Lmnc` (legacy Preserve Luminosity) is silently dropped on modern PS.',
  ],
  events: [
    {
      index: 1,
      event: charID('Mk  '),
      comment:
        'Creates the Color Balance adjustment layer. The Mk typeDesc emits all three range lists with [0,0,0] defaults plus PrsL. Editmamei embeds user values inline via create-with-values.',
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
                  name: 'Type (the ClrB type descriptor)',
                  typeID: charID('Type'),
                  kind: 'object',
                  required: true,
                  innerShape: {
                    classID: charID('ClrB'),
                    fields: [
                      {
                        name: 'Shadows [CR, MG, YB]',
                        typeID: charID('ShdL'),
                        kind: 'list',
                        required: true,
                        itemSchema: { primitive: 'integer' },
                        description:
                          '3-int list [cyanRed, magentaGreen, yellowBlue]. Default [0, 0, 0].',
                      },
                      {
                        name: 'Midtones [CR, MG, YB]',
                        typeID: charID('MdtL'),
                        kind: 'list',
                        required: true,
                        itemSchema: { primitive: 'integer' },
                        description:
                          '3-int list. Default [0, 0, 0]. Canonical key (replaces legacy Mdtn).',
                      },
                      {
                        name: 'Highlights [CR, MG, YB]',
                        typeID: charID('HghL'),
                        kind: 'list',
                        required: true,
                        itemSchema: { primitive: 'integer' },
                        description: '3-int list. Default [0, 0, 0].',
                      },
                      {
                        name: 'Preserve Luminosity',
                        typeID: charID('PrsL'),
                        kind: 'boolean',
                        required: true,
                        booleanDefault: true,
                        description: 'Canonical (replaces legacy Lmnc which is silently dropped).',
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
        'Applies user-touched ranges. PS only re-emits the range lists the user actually moved — single range when user touched only Midtones, two when they touched Midtones + Highlights. Skip when using create-with-values.',
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
            name: 'T (the ClrB values descriptor)',
            typeID: charID('T   '),
            kind: 'object',
            required: true,
            innerShape: {
              classID: charID('ClrB'),
              fields: [
                {
                  name: 'Shadows [CR, MG, YB]',
                  typeID: charID('ShdL'),
                  kind: 'list',
                  required: false,
                  itemSchema: { primitive: 'integer' },
                  description: 'Only emitted when user touched Shadows.',
                },
                {
                  name: 'Midtones [CR, MG, YB]',
                  typeID: charID('MdtL'),
                  kind: 'list',
                  required: false,
                  itemSchema: { primitive: 'integer' },
                  description: 'Only emitted when user touched Midtones.',
                },
                {
                  name: 'Highlights [CR, MG, YB]',
                  typeID: charID('HghL'),
                  kind: 'list',
                  required: false,
                  itemSchema: { primitive: 'integer' },
                  description: 'Only emitted when user touched Highlights.',
                },
              ],
            },
          },
        ],
      },
    },
  ],
};
