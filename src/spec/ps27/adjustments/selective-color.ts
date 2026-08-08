/**
 * Selective Color adjustment layer.
 *
 * Ground truth: PS 27.7.0 Windows, captured 2026-06-03.
 * Capture log: JS-14-Selective-Color.log
 *
 * The user opened a fresh PS doc, clicked Layer > New Adjustment Layer >
 * Selective Color, accepted defaults, then for the Reds color family
 * nudged Cyan +9, Magenta +36, Yellow -29, Black -8.
 *
 * Shape:
 *   T → SlcC → {
 *     presetKindCustom,
 *     ClrC → list[
 *       ClrC → { Clrs=Rds enum, Cyn, Mgnt, Ylw, Blck (#Prc unitDoubles) }
 *       ... one entry per family the user touched ...
 *     ]
 *   }
 *
 * Verdict: MEDIUM — the snippet emits a
 * top-level `Mthd → correctionMethod` enum (relative/absolute) on the
 * typeDesc, but the captured ground truth has NO Mthd anywhere. PS may
 * default to Relative when Mthd is absent; the snippet\'s emission likely
 * works but the placement is unverified. Audit recommended capturing
 * an explicit Method=Absolute session to ground-truth the placement.
 *
 * The 2026-05-31 fix that landed `ClrC`/`Clrs`/`Cyn`/`Mgnt`/
 * `Ylw`/`Blck` with #Prc unitDoubles is durable on ground truth.
 */

import type { AmEventSpec } from '../../types.js';
import { charID, stringID } from '../../types.js';

export const selectiveColorSpec: AmEventSpec = {
  id: 'adjustments/selective-color',
  displayName: 'Selective Color adjustment layer',
  category: 'adjustments',
  emittedBy: ['ps_add_adjustment_layer'],
  snippetRef: 'go-core/cmd/buildtemplates/fragments_adjustments_types.go (vault.AdjSCTd)',
  groundTruth: {
    capturedAt: '2026-06-03',
    psVersion: '27.7.0',
    platform: 'Windows',
    sourceLog: 'JS-14-Selective-Color.log',
    menuPath: 'Layer > New Adjustment Layer > Selective Color',
  },
  knownGotchas: [
    'MEDIUM: `Mthd → correctionMethod` enum (relative/absolute) placement is UNVERIFIED. Snippet emits it on the SlcC typeDesc top-level; ground truth has no Mthd anywhere. PS defaults to Relative when absent. Audit recommended capturing an explicit Absolute session to confirm where Mthd belongs (per-entry vs top-level).',
    '`ClrC` is used twice: once as the outer list key on the SlcC typeDesc, and once as the per-entry object class. Same charID, different roles — easy confusion.',
    '`Clrs` enum picks the color family. Values are charIDs: `Rds ` (Reds), `Yllw` (Yellows), `Grn ` (Greens), `Cyn ` (Cyans), `Bl  ` (Blues), `Mgnt` (Magentas), `Wht ` (Whites), `Ntrl` (Neutrals), `Blks` (Blacks). Snippet uses stringID aliases (`reds`/`yellows`/...) — same typeID.',
    'Per-entry value keys are `Cyn `, `Mgnt`, `Ylw ` (note charID `Ylw ` not `Yllw`), `Blck`. All MUST be `putUnitDouble(#Prc)`. Range -100..+100%.',
    'PS only emits the keys the user moved within each entry. Ground truth (Reds entry) shows only `Cyn ` when user only moved cyan; once they touch the others, all four appear.',
    'PS only emits entries for the color families the user touched — empty families are absent from ClrC list.',
  ],
  versionNotes: [
    'The 2026-05-31 fix corrected the descriptor shape from a hand-rolled wrong form to the canonical ClrC/Clrs/{C,M,Y,K-percent} form. Before that, the snippet emitted `Clrs` as a stringID on a different parent class — silently no-opped.',
    'Mthd correctionMethod enum likely belongs on each ClrC entry per Adobe forum lore, but ground-truth capture never showed it. Defer until a verifying capture lands.',
  ],
  events: [
    {
      index: 1,
      event: charID('Mk  '),
      comment:
        'Creates the empty Selective Color adjustment layer. Mk typeDesc holds only presetKindDefault. Editmamei embeds the ClrC list inline via create-with-values.',
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
                  name: 'Type (the SlcC type descriptor)',
                  typeID: charID('Type'),
                  kind: 'object',
                  required: true,
                  innerShape: {
                    classID: charID('SlcC'),
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
        'Applies the per-family CMYK adjustments. ClrC list holds one ClrC-class entry per color family the user touched.',
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
            name: 'T (the SlcC values descriptor)',
            typeID: charID('T   '),
            kind: 'object',
            required: true,
            innerShape: {
              classID: charID('SlcC'),
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
                  name: 'Correction Method (relative vs absolute) — placement UNVERIFIED',
                  typeID: stringID('Mthd'),
                  kind: 'enum',
                  required: false,
                  enumType: stringID('correctionMethod'),
                  enumValues: [
                    {
                      typeID: stringID('relative'),
                      context: 'Default when Mthd is absent. Smooth, less aggressive correction.',
                    },
                    { typeID: stringID('absolute'), context: 'Stronger, less natural correction.' },
                  ],
                  description:
                    'Placement (top-level vs per-entry) is UNVERIFIED. Ground truth omits Mthd entirely; snippet emits it at the top level. Defer fix until a verifying capture exists.',
                },
                {
                  name: 'Color corrections list',
                  typeID: charID('ClrC'),
                  kind: 'list',
                  required: true,
                  itemSchema: {
                    classID: charID('ClrC'),
                    fields: [
                      {
                        name: 'Colors family selector',
                        typeID: charID('Clrs'),
                        kind: 'enum',
                        required: true,
                        enumType: charID('Clrs'),
                        enumValues: [
                          { typeID: charID('Rds '), label: 'Reds' },
                          { typeID: charID('Yllw'), label: 'Yellows' },
                          { typeID: charID('Grn '), label: 'Greens' },
                          { typeID: charID('Cyn '), label: 'Cyans' },
                          { typeID: charID('Bl  '), label: 'Blues' },
                          { typeID: charID('Mgnt'), label: 'Magentas' },
                          { typeID: charID('Wht '), label: 'Whites' },
                          { typeID: charID('Ntrl'), label: 'Neutrals' },
                          { typeID: charID('Blks'), label: 'Blacks' },
                        ],
                      },
                      {
                        name: 'Cyan adjustment',
                        typeID: charID('Cyn '),
                        kind: 'unitDouble',
                        required: false,
                        unit: { charID: '#Prc' },
                        range: { min: -100, max: 100, default: 0 },
                      },
                      {
                        name: 'Magenta adjustment',
                        typeID: charID('Mgnt'),
                        kind: 'unitDouble',
                        required: false,
                        unit: { charID: '#Prc' },
                        range: { min: -100, max: 100, default: 0 },
                      },
                      {
                        name: 'Yellow adjustment (charID Ylw — note no double l)',
                        typeID: charID('Ylw '),
                        kind: 'unitDouble',
                        required: false,
                        unit: { charID: '#Prc' },
                        range: { min: -100, max: 100, default: 0 },
                        description:
                          "Note: charID `Ylw ` (NOT `Yllw` — that's the Yellows family enum value).",
                      },
                      {
                        name: 'Black adjustment',
                        typeID: charID('Blck'),
                        kind: 'unitDouble',
                        required: false,
                        unit: { charID: '#Prc' },
                        range: { min: -100, max: 100, default: 0 },
                      },
                    ],
                  },
                  gotchas: [
                    'Entry class is `ClrC` (same charID as the outer list key). Easy to typo.',
                    'PS only emits CMYK keys the user actually touched. Empty entries are absent.',
                    'Yellow value key is `Ylw ` (charID), distinct from the `Yllw` family enum value.',
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
