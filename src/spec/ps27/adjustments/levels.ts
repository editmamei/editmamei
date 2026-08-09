/**
 * Levels adjustment layer — **HIGH-severity spec**.
 *
 * Ground truth: PS 27.7.0 Windows, captured 2026-06-03.
 * Capture log: JS-05-levels.log
 *
 * The user opened a fresh PS doc, clicked Layer > New Adjustment Layer >
 * Levels, accepted defaults, then set Input black to 20, Input white to
 * 240, gamma to 1.2 in the Properties panel.
 *
 * Spec review flagged THREE simultaneous silent-no-op
 * drifts in the current snippet (go-core/cmd/buildtemplates/fragments_adjustments.go, vault.AdjLvlPM):
 *   - `Chnl` MUST be a putReference (NOT putEnumerated)
 *   - `Inpt` MUST be a 2-int LIST [black, white] (NOT separate Inpt + Wht keys)
 *   - `Gmm ` MUST be a putDouble (NOT putInteger of gamma*100)
 *
 * The combination causes the Levels adjustment to silently no-op or
 * apply wildly wrong values on PS 2026. The audit recommends a full
 * snippet rewrite plus `.not.toContain('Wht ')` and
 * `.not.toContain("putInteger(cTID('Gmm '))")` regression guards.
 *
 * The spec below encodes the GROUND TRUTH shape so that when the
 * snippet is rewritten to match, this file is the contract it must
 * satisfy.
 */

import type { AmEventSpec } from '../../types.js';
import { charID, stringID } from '../../types.js';

export const levelsSpec: AmEventSpec = {
  id: 'adjustments/levels',
  displayName: 'Levels adjustment layer',
  category: 'adjustments',
  emittedBy: ['ps_add_adjustment_layer'],
  snippetRef:
    'go-core/cmd/buildtemplates/fragments_adjustments.go (vault.AdjLvlPM — levels PS27.x setd workaround, fixed 2026-07-27 to target AdjL; knownGotchas records the failure history)',
  groundTruth: {
    capturedAt: '2026-06-03',
    psVersion: '27.7.0',
    platform: 'Windows',
    sourceLog: 'JS-05-levels.log',
    menuPath: 'Layer > New Adjustment Layer > Levels',
  },
  knownGotchas: [
    'HIGH (silent no-op): `Chnl` MUST be a putReference holding an ActionReference→putEnumerated(Chnl, Chnl, Cmps). The snippet currently emits putEnumerated directly on the LvlA descriptor — PS 27 rejects this and drops the entry.',
    'HIGH (silent no-op): `Inpt` is a SINGLE key holding a 2-int LIST `[blackPoint, whitePoint]`. There is NO `Wht ` charID anywhere in the ground truth. The snippet emits Inpt + Wht as two separate integers — PS reads only Inpt (gets black), drops Wht entirely, white-point user input is silently dropped.',
    'HIGH (silent no-op): `Gmm ` is a putDouble carrying the gamma value as a float (e.g. 1.400000). The snippet emits putInteger of gamma*100, so gamma=1.2 becomes 120 — PS coerces the integer to a wildly wrong gamma or drops it silently.',
    '`Otpt` is ALSO a 2-int list `[outputBlack, outputWhite]`. PS emits this when user touches the output sliders. Default is [0, 255]. Same list-of-2-ints shape as Inpt.',
    'Per-channel auto-only entries: when the user clicks the per-channel Auto button, PS emits a LvlA per channel (Rd , Grn , Bl  references) carrying ONLY `Auto=true`. These channel entries are SEPARATE from the Composite entry; do not merge.',
    'PS 24/25 may have accepted some of the wrong shapes (the snippet has been shipping); PS 26/27 tightened validation — confirm against live PS before declaring an alternative form acceptable.',
  ],
  versionNotes: [
    'The Inpt-as-list shape is what PS 27 emits via ScriptListener. Prior captures and forum lore showed Inpt + Wht as separate keys; that historical reading was either wrong or has rotated.',
    'Gmm as putDouble appears to be PS 24+ canonical. Forum posts from CS5/CS6 era showed putInteger; that form is silently broken on modern PS.',
  ],
  events: [
    {
      index: 1,
      event: charID('Mk  '),
      comment:
        'Creates the empty Levels adjustment layer. Mk typeDesc holds only `presetKindDefault` — no values. PS-canonical: bare. Editmamei may embed the setd body inline via create-with-values, but the Mk envelope itself stays bare.',
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
                  name: 'Type (the Lvls type descriptor)',
                  typeID: charID('Type'),
                  kind: 'object',
                  required: true,
                  innerShape: {
                    classID: charID('Lvls'),
                    fields: [
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
                            context: 'Embedded create-with-values.',
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
        "Applies the levels values. Adjs list holds one LvlA entry per affected channel. Composite carries Inpt+Gmm+Otpt; per-channel auto entries carry only Auto=true. THIS IS THE LOAD-BEARING DESCRIPTOR — the audit's 3 HIGH-severity drifts all live here.",
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
            name: 'T (the Lvls values descriptor)',
            typeID: charID('T   '),
            kind: 'object',
            required: true,
            innerShape: {
              classID: charID('Lvls'),
              fields: [
                {
                  name: 'presetKind',
                  typeID: stringID('presetKind'),
                  kind: 'enum',
                  required: false,
                  enumType: stringID('presetKindType'),
                  enumValues: [{ typeID: stringID('presetKindCustom') }],
                  description:
                    'Sometimes emitted by PS, sometimes omitted. Ground truth for the final-commit setd omitted it; the early setd carried presetKindCustom.',
                },
                {
                  name: 'Adjustments list (per-channel level entries)',
                  typeID: charID('Adjs'),
                  kind: 'list',
                  required: true,
                  itemSchema: {
                    classID: charID('LvlA'),
                    fields: [
                      {
                        name: 'Channel (reference — putReference, NOT putEnumerated)',
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
                          'HIGH: ground truth is `desc.putReference(idChnl, ref)` where ref enumerates (Chnl, Chnl, Cmps|Rd|Grn|Bl). Snippet currently emits putEnumerated directly — silent no-op.',
                      },
                      {
                        name: 'Input range [black, white] (2-int list)',
                        typeID: charID('Inpt'),
                        kind: 'list',
                        required: false,
                        itemSchema: { primitive: 'integer' },
                        description:
                          'HIGH: SINGLE Inpt key holding a 2-int list. NO `Wht ` charID anywhere. Default [0, 255]. Snippet currently emits two separate integers (Inpt + Wht); white-point silently dropped.',
                        gotchas: [
                          'List MUST contain exactly two integers: [blackPoint, whitePoint].',
                          'There is NO `Wht ` (white) key in the LvlA descriptor — adding one is silently ignored.',
                          'Omit this key entirely when the channel only carries Auto=true.',
                        ],
                      },
                      {
                        name: 'Gamma',
                        typeID: charID('Gmm '),
                        kind: 'double',
                        required: false,
                        range: { min: 0.01, max: 9.99, default: 1.0 },
                        description:
                          'HIGH: putDouble carrying the float gamma value (e.g. 1.400000). NOT putInteger of gamma*100. Snippet currently emits the integer form — gamma silently dropped or coerced.',
                      },
                      {
                        name: 'Output range [outputBlack, outputWhite] (2-int list)',
                        typeID: charID('Otpt'),
                        kind: 'list',
                        required: false,
                        itemSchema: { primitive: 'integer' },
                        description:
                          'Same 2-int-list shape as Inpt. PS emits when user touches output sliders. Default [0, 255].',
                      },
                      {
                        name: 'Auto (per-channel auto-levels)',
                        typeID: charID('Auto'),
                        kind: 'boolean',
                        required: false,
                        description:
                          'When true, this LvlA entry carries ONLY Chnl + Auto — no Inpt/Gmm/Otpt. PS emits one such entry per channel (Rd , Grn , Bl ) when the user clicks the per-channel auto toggle.',
                      },
                    ],
                  },
                  gotchas: [
                    'Per-channel LvlA entries are emitted separately from the Composite entry — do not merge channels into a single entry.',
                    'When the user only edits gamma on Composite, ONLY the Cmps LvlA appears — no per-channel auto entries.',
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
