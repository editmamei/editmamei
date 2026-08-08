/**
 * Color Lookup adjustment layer — Abstract / Device Link path.
 *
 * Ground truth: PS 27.7.0 Windows, captured 2026-06-03.
 * Capture log: JS-19-Color-Lookup-Abstract.log
 *
 * The user opened a fresh PS doc, clicked Layer > New Adjustment Layer >
 * Color Lookup, accepted the dialog, then chose `deviceLinkProfile` from
 * the Device Link section. The capture cut off after the lookupType enum
 * was emitted — the rest of the setd (Nm path, profile binary) wasn\'t
 * captured because the user evidently didn\'t complete a click-through.
 *
 * The Mk envelope is the SAME putClass-only shape as the 3DLUT spec
 * (see color-lookup-3dlut.ts). The setd differs ONLY in the `lookupType`
 * enum value:
 *   - 3DLUT-path: lookupType = `3DLUT`
 *   - Abstract-path: lookupType = `abstractProfile`
 *   - Device-Link path: lookupType = `deviceLinkProfile`
 *
 * **Same irreparable scripting limitation** as the 3DLUT spec — the
 * `profile` putData binary requires PS\'s native parse. Editmamei\'s
 * snippet currently throws for non-3DLUT paths at line ~2970:
 * `throw new Error('Color Lookup ' + clLutTypeRaw + ' is not yet
 * supported. Only 3dlut is verified...')`.
 *
 * Verdict: OK — the refusal is appropriate
 * given the same binary-profile limitation as 3DLUT.
 *
 * This spec documents the descriptor surface for completeness so that
 * IF a future PS version exposes a JS hook to the LUT parser, the
 * snippet can be updated against this contract.
 */

import type { AmEventSpec } from '../../types.js';
import { charID, stringID } from '../../types.js';

export const colorLookupAbstractSpec: AmEventSpec = {
  id: 'adjustments/color-lookup-abstract',
  displayName: 'Color Lookup adjustment layer (Abstract / Device Link)',
  category: 'adjustments',
  emittedBy: ['ps_add_adjustment_layer'],
  snippetRef:
    'go-core/adjustments.go (addAdjustmentLayer, color_lookup case — throws for non-3dlut cl_lut_type; no vault template, the guard returns an error before any JS is built)',
  groundTruth: {
    capturedAt: '2026-06-03',
    psVersion: '27.7.0',
    platform: 'Windows',
    sourceLog: 'JS-19-Color-Lookup-Abstract.log',
    menuPath: 'Layer > New Adjustment Layer > Color Lookup (Device Link section)',
  },
  knownGotchas: [
    "SAME irreparable JS-can't-parse-LUT limitation as 3DLUT. Snippet throws for non-3DLUT paths — appropriate behavior.",
    'Mk envelope IDENTICAL to the 3DLUT spec — putClass(Type, colorLookup), no inner descriptor.',
    'lookupType discriminator values (`3DLUT`/`abstractProfile`/`deviceLinkProfile`) live on the same colorLookupType enum class. Other type-specific keys (Nm path, profile binary) follow the same surface.',
    'Abstract and DeviceLink LUT files are typically .icc (ICC profile) files; PS reads them via its native ICC stack. Same C++ parse path as 3DLUT — same JS-unreachable limitation.',
    "The capture log cut off after lookupType was emitted — the Nm path, profile binary, and any LUT format identifier for the abstract/device-link path are inferred from the 3DLUT spec's shape.",
  ],
  versionNotes: [
    'No PS version (through 27) exposes a JS path to the LUT-profile parser. The limitation has been present since CS6.',
  ],
  events: [
    {
      index: 1,
      event: charID('Mk  '),
      comment: 'Same Mk shape as 3DLUT. putClass(Type, colorLookup) with no inner descriptor.',
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
            name: 'Using (the type-bearing descriptor — putClass-only)',
            typeID: charID('Usng'),
            kind: 'object',
            required: true,
            innerShape: {
              classID: charID('AdjL'),
              fields: [
                {
                  name: 'Type — putClass(colorLookup), NO inner descriptor',
                  typeID: charID('Type'),
                  kind: 'class',
                  required: true,
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
        'Applies the Abstract or Device Link profile. EDITMAMEI CANNOT EMIT THIS — same limitation as 3DLUT. Snippet throws. Documented for spec completeness.',
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
            name: 'T (the colorLookup values descriptor)',
            typeID: charID('T   '),
            kind: 'object',
            required: true,
            innerShape: {
              classID: stringID('colorLookup'),
              fields: [
                {
                  name: 'lookupType (Abstract or Device Link)',
                  typeID: stringID('lookupType'),
                  kind: 'enum',
                  required: true,
                  enumType: stringID('colorLookupType'),
                  enumValues: [
                    { typeID: stringID('abstractProfile'), label: 'Abstract profile' },
                    {
                      typeID: stringID('deviceLinkProfile'),
                      label: 'Device link profile (captured in JS-19 ground truth)',
                    },
                  ],
                },
                {
                  name: 'Profile file path (absolute)',
                  typeID: charID('Nm  '),
                  kind: 'string',
                  required: true,
                  description: 'Absolute filesystem path to the .icc / .icm profile.',
                },
                {
                  name: 'Profile binary (parsed by PS native code)',
                  typeID: stringID('profile'),
                  kind: 'data',
                  required: true,
                  description:
                    'Same LOAD-BEARING binary slot as the 3DLUT path. PS parses the .icc profile natively. NO JavaScript path.',
                },
              ],
            },
          },
        ],
      },
    },
  ],
};
