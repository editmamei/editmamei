/**
 * Brightness/Contrast adjustment layer.
 *
 * Ground truth: PS 27.7.0 Windows, captured 2026-06-03.
 * Capture log: JS-03-Bright-Cont.log
 *
 * The user opened a fresh PS doc, clicked Layer > New Adjustment Layer >
 * Brightness/Contrast, accepted defaults, then nudged Brightness to +28
 * and Contrast to +11 in the Properties panel.
 *
 * PS emits one Mk envelope followed by one or more setd events as the
 * user moves sliders. The Mk envelope holds ONLY `useLegacy=false` on
 * the typeDesc — no values, no presetKind. The setd carries
 * `Brgh`/`Cntr` as plain putIntegers and re-emits `useLegacy=false`.
 *
 * Shape is very flat compared to Hue/Sat: no `Adjs` list, no per-range
 * objects, just three primitives on the BrgC descriptor.
 *
 * Group A audit (STEP 03) classified this OK — snippet matches ground
 * truth. The only LOW-severity drift is that the snippet emits
 * `presetKindCustom` on the inline Mk-with-values path; ground truth
 * has no presetKind anywhere on the setd. PS tolerates the extra key.
 */

import type { AmEventSpec } from '../../types.js';
import { charID, stringID } from '../../types.js';

export const brightnessContrastSpec: AmEventSpec = {
  id: 'adjustments/brightness-contrast',
  displayName: 'Brightness/Contrast adjustment layer',
  category: 'adjustments',
  emittedBy: ['ps_add_adjustment_layer'],
  snippetRef: 'go-core/cmd/buildtemplates/fragments_adjustments_types.go (vault.AdjBCTd)',
  groundTruth: {
    capturedAt: '2026-06-03',
    psVersion: '27.7.0',
    platform: 'Windows',
    sourceLog: 'JS-03-Bright-Cont.log',
    menuPath: 'Layer > New Adjustment Layer > Brightness/Contrast',
  },
  knownGotchas: [
    'useLegacy MUST be emitted (false unless the user explicitly wants pre-CS3 algorithm). The Mk envelope ground truth shows this is the ONLY field PS emits on the bare creation — without it PS may fall back to legacy algorithm semantics.',
    'Brgh/Cntr are plain putIntegers (not unitDoubles). Range is -150..+150 for Brightness, -50..+100 for Contrast (UI clamps, descriptor accepts wider).',
    'No Adjs list, no per-range nesting — descriptor is flat. Easy to over-engineer if copying the Hue/Sat shape.',
  ],
  versionNotes: [
    'useLegacy was added in CS3 (PS 10) when the algorithm changed. The default false is what modern PS users expect; true reproduces the much-blunter pre-CS3 algorithm.',
  ],
  events: [
    {
      index: 1,
      event: charID('Mk  '),
      comment:
        'Creates the empty Brightness/Contrast adjustment layer. Mk typeDesc holds only useLegacy=false — no values, no presetKind. Editmamei embeds values inline (create-with-values) and skips event 2.',
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
                  name: 'Type (the BrgC type descriptor)',
                  typeID: charID('Type'),
                  kind: 'object',
                  required: true,
                  innerShape: {
                    classID: charID('BrgC'),
                    fields: [
                      {
                        name: 'useLegacy',
                        typeID: stringID('useLegacy'),
                        kind: 'boolean',
                        required: true,
                        booleanDefault: false,
                        description:
                          'False = modern (CS3+) algorithm. True = pre-CS3 legacy algorithm.',
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
        'Applies Brightness + Contrast values. Skipped entirely when using create-with-values pattern (descriptor body lifts into event 1).',
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
            name: 'T (the BrgC values descriptor)',
            typeID: charID('T   '),
            kind: 'object',
            required: true,
            innerShape: {
              classID: charID('BrgC'),
              fields: [
                {
                  name: 'Brightness',
                  typeID: charID('Brgh'),
                  kind: 'integer',
                  required: true,
                  range: { min: -150, max: 150, default: 0 },
                  description: 'Brightness shift. Plain putInteger, not unitDouble.',
                },
                {
                  name: 'Contrast',
                  typeID: charID('Cntr'),
                  kind: 'integer',
                  required: true,
                  range: { min: -50, max: 100, default: 0 },
                  description: 'Contrast shift. Plain putInteger.',
                },
                {
                  name: 'useLegacy',
                  typeID: stringID('useLegacy'),
                  kind: 'boolean',
                  required: true,
                  booleanDefault: false,
                },
              ],
            },
          },
        ],
      },
    },
  ],
};
