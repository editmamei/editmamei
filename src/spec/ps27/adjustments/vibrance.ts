/**
 * Vibrance adjustment layer.
 *
 * Ground truth: PS 27.7.0 Windows, captured 2026-06-03.
 * Capture log: JS-11-Vibrance.log
 *
 * The user opened a fresh PS doc, clicked Layer > New Adjustment Layer >
 * Vibrance, accepted defaults, then nudged Vibrance to +19. Saturation
 * was NOT moved in this capture (Strt=0 in the setd).
 *
 * Mk envelope: `useLegacy=false` only (just like Brightness/Contrast).
 * setd: five fields — `temperature`, `tint`, `vibrance`, `Strt`,
 * `useLegacy`. The first two (`temperature`, `tint`) are PS-emitted
 * even when 0 — they appear to be ancestor fields from an older
 * descriptor version that PS still volunteers.
 *
 * Verdict: LOW — snippet matches on `vibrance`
 * and `Strt`/`saturation` (PS aliases), omits `temperature`/`tint`/
 * `useLegacy` (extra fields PS volunteers, no behavior change).
 *
 * Note: `Strt` (charID) and `saturation` (stringID) are PS aliases —
 * same typeID. Snippet uses `sTID('saturation')`, ground truth uses
 * `cTID('Strt')` — interoperable.
 */

import type { AmEventSpec } from '../../types.js';
import { charID, stringID } from '../../types.js';

export const vibranceSpec: AmEventSpec = {
  id: 'adjustments/vibrance',
  displayName: 'Vibrance adjustment layer',
  category: 'adjustments',
  emittedBy: ['ps_add_adjustment_layer'],
  snippetRef: 'go-core/cmd/buildtemplates/fragments_adjustments_types.go (vault.AdjVibTd)',
  groundTruth: {
    capturedAt: '2026-06-03',
    psVersion: '27.7.0',
    platform: 'Windows',
    sourceLog: 'JS-11-Vibrance.log',
    menuPath: 'Layer > New Adjustment Layer > Vibrance',
  },
  knownGotchas: [
    "Type charID is `vibrance` stringID (Adobe alias for the internal type), NOT a separate charID — sTID('vibrance') is what the snippet uses.",
    "Vibrance and Saturation are BOTH integer fields on the same typeDesc. `vibrance` is stringID; `Strt` (saturation) is charID — they're separate fields, not the same one. Both required when emitting the full descriptor.",
    "PS volunteers `temperature` and `tint` integer fields (default 0) on every Vibrance setd. The snippet omits these. Future-proofing: emit them as 0 to match PS's shape.",
    '`useLegacy=false` matches the Brightness/Contrast pattern. The legacy Vibrance algorithm is rarely-used; default false is correct for modern PS.',
    '`saturation` (stringID) and `Strt` (charID) resolve to the same typeID — both work interchangeably.',
  ],
  versionNotes: [
    '`useLegacy` was added in some PS 24+ revision when the Vibrance algorithm was tweaked. Older PS reject it; snippet currently omits it for portability.',
    "temperature + tint appearing in the setd is a relic of the descriptor's shared lineage with Camera Raw's color-grading model — those fields are present-but-unused in Vibrance.",
  ],
  events: [
    {
      index: 1,
      event: charID('Mk  '),
      comment:
        'Creates the empty Vibrance adjustment layer. Mk typeDesc holds only useLegacy=false. PS emits nothing else at creation.',
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
                  name: 'Type (the vibrance type descriptor)',
                  typeID: charID('Type'),
                  kind: 'object',
                  required: true,
                  innerShape: {
                    classID: stringID('vibrance'),
                    fields: [
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
      },
    },
    {
      index: 2,
      event: charID('setd'),
      comment:
        'Applies the Vibrance + Saturation integers. PS volunteers temperature + tint even when 0; useLegacy boolean re-emitted.',
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
            name: 'T (the vibrance values descriptor)',
            typeID: charID('T   '),
            kind: 'object',
            required: true,
            innerShape: {
              classID: stringID('vibrance'),
              fields: [
                {
                  name: 'Temperature (PS-volunteered; usually 0)',
                  typeID: stringID('temperature'),
                  kind: 'integer',
                  required: false,
                  range: { min: -100, max: 100, default: 0 },
                  description:
                    'PS emits this even when 0. Shared lineage with Camera Raw color-grading; functionally unused in Vibrance.',
                },
                {
                  name: 'Tint (PS-volunteered; usually 0)',
                  typeID: stringID('tint'),
                  kind: 'integer',
                  required: false,
                  range: { min: -100, max: 100, default: 0 },
                  description: 'Same caveat as temperature.',
                },
                {
                  name: 'Vibrance',
                  typeID: stringID('vibrance'),
                  kind: 'integer',
                  required: true,
                  range: { min: -100, max: 100, default: 0 },
                  description:
                    'Main vibrance slider. Selective saturation boost on the under-saturated colors.',
                },
                {
                  name: "Saturation (Strt charID; sTID('saturation') alias)",
                  typeID: charID('Strt'),
                  kind: 'integer',
                  required: true,
                  range: { min: -100, max: 100, default: 0 },
                  description:
                    'Plain saturation slider. PS aliases charID `Strt` and stringID `saturation` to the same typeID.',
                },
                {
                  name: 'useLegacy',
                  typeID: stringID('useLegacy'),
                  kind: 'boolean',
                  required: false,
                  booleanDefault: false,
                  description:
                    'False = modern algorithm. Snippet currently omits — emitting false matches PS shape.',
                },
              ],
            },
          },
        ],
      },
    },
  ],
};
