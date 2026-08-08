/**
 * Color Balance adjustment layer (Preserve Luminosity OFF).
 *
 * Ground truth: PS 27.7.0 Windows, captured 2026-06-03.
 * Capture log: JS-08-Color-Bal-NoLum.log
 *
 * Same descriptor surface as the standard color-balance.ts spec, but
 * with `PrsL=false` in the Mk envelope. Captured because Preserve
 * Luminosity is a load-bearing perceptual toggle the LLM may need to
 * flip for certain color-correction workflows (toning highlights
 * without preserving brightness, for instance).
 *
 * The user opened a fresh PS doc, clicked Layer > New Adjustment Layer >
 * Color Balance, **unticked Preserve Luminosity in the New Layer dialog**,
 * accepted, then nudged Midtones Cyan-Red to +35.
 *
 * Verdict: OK — the only delta from
 * STEP 07 is the PrsL boolean value. All structural points are the
 * same as color-balance.ts; this spec exists to document that PS
 * faithfully records the PrsL toggle into the Mk envelope (i.e. it is
 * NOT a separate setd that flips PrsL later — the user-dialog toggle
 * is captured at creation).
 */

import type { AmEventSpec } from '../../types.js';
import { charID } from '../../types.js';

export const colorBalanceNoLuminositySpec: AmEventSpec = {
  id: 'adjustments/color-balance-no-luminosity',
  displayName: 'Color Balance adjustment layer (Preserve Luminosity off)',
  category: 'adjustments',
  emittedBy: ['ps_add_adjustment_layer'],
  snippetRef:
    'go-core/cmd/buildtemplates/fragments_adjustments_types.go (vault.AdjCBTd — PrsL=false variant)',
  groundTruth: {
    capturedAt: '2026-06-03',
    psVersion: '27.7.0',
    platform: 'Windows',
    sourceLog: 'JS-08-Color-Bal-NoLum.log',
    menuPath: 'Layer > New Adjustment Layer > Color Balance (Preserve Luminosity unticked)',
  },
  knownGotchas: [
    'PrsL=false in the Mk envelope — the only structural delta from the main color-balance.ts spec.',
    'Setting PrsL=false at creation is the canonical workflow when the user wants to shift saturation/brightness through color balance rather than preserve it. The toggle is sticky on the descriptor — flipping it via a later setd works but adds a round trip.',
    'See color-balance.ts for all other gotchas (range key names, list ordering, etc.). They apply identically here.',
  ],
  versionNotes: [
    'PS 24+: PrsL is the canonical key. Legacy Lmnc is silently dropped (same as in the main color-balance.ts spec).',
  ],
  events: [
    {
      index: 1,
      event: charID('Mk  '),
      comment:
        'Creates the Color Balance adjustment layer with Preserve Luminosity OFF. Mk envelope mirrors the standard color-balance.ts spec exactly except PrsL=false.',
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
                      },
                      {
                        name: 'Midtones [CR, MG, YB]',
                        typeID: charID('MdtL'),
                        kind: 'list',
                        required: true,
                        itemSchema: { primitive: 'integer' },
                      },
                      {
                        name: 'Highlights [CR, MG, YB]',
                        typeID: charID('HghL'),
                        kind: 'list',
                        required: true,
                        itemSchema: { primitive: 'integer' },
                      },
                      {
                        name: 'Preserve Luminosity (false in this variant)',
                        typeID: charID('PrsL'),
                        kind: 'boolean',
                        required: true,
                        booleanDefault: false,
                        description:
                          'MUST be false for this spec. The differentiator from the main color-balance.ts spec.',
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
        'Applies user-touched ranges. Identical to the standard color-balance.ts setd event. PrsL toggling typically happens at creation; flipping it via a separate setd is allowed but uncommon.',
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
                },
                {
                  name: 'Midtones [CR, MG, YB]',
                  typeID: charID('MdtL'),
                  kind: 'list',
                  required: false,
                  itemSchema: { primitive: 'integer' },
                },
                {
                  name: 'Highlights [CR, MG, YB]',
                  typeID: charID('HghL'),
                  kind: 'list',
                  required: false,
                  itemSchema: { primitive: 'integer' },
                },
              ],
            },
          },
        ],
      },
    },
  ],
};
