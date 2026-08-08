/**
 * Photo Filter adjustment layer — custom user color (not preset).
 *
 * Ground truth: PS 27.7.0 Windows, captured 2026-06-03.
 * Capture log: JS-10-Photo-Filter-Color.log
 *
 * The user opened a fresh PS doc, clicked Layer > New Adjustment Layer >
 * Photo Filter, switched the dropdown from preset to Color, opened the
 * picker, set a teal (≈ #3399AA), then set density to 49.
 *
 * Ground truth captured a setd (not a Mk envelope — the Mk was the
 * default preset state). The setd shape:
 *   T → photoFilter → {
 *     Clr → HSBC{ H=#Ang 194.82, Strt=43.14, Brgh=89.80 },
 *     Dnst = 49
 *   }
 *
 * **Critical color-object shape choice:** PS 2026 emits the picker
 * value as an `HSBC` color object (Hue/Saturation/Brightness), NOT as
 * `RGBC`. The current snippet uses `RGBColor`/`RGBC` with Rd/Grn/Bl
 * doubles. Verdict: LOW — both color
 * classes are accepted by PS on the photoFilter `Clr ` slot, and the
 * inner key sets differ in semantics not in correctness.
 *
 * `H` is a unitDouble with #Ang unit (degrees); `Strt`/`Brgh` are plain
 * putDouble percentages (0..100). When a snippet emits RGBC, the inner
 * keys are Rd/Grn/Bl as putDouble (0..255).
 */

import type { AmEventSpec } from '../../types.js';
import { charID, stringID } from '../../types.js';

export const photoFilterColorSpec: AmEventSpec = {
  id: 'adjustments/photo-filter-color',
  displayName: 'Photo Filter adjustment layer (custom color)',
  category: 'adjustments',
  emittedBy: ['ps_add_adjustment_layer'],
  snippetRef:
    'go-core/cmd/buildtemplates/fragments_adjustments_types.go (vault.AdjPFClr — custom color path)',
  groundTruth: {
    capturedAt: '2026-06-03',
    psVersion: '27.7.0',
    platform: 'Windows',
    sourceLog: 'JS-10-Photo-Filter-Color.log',
    menuPath: 'Layer > New Adjustment Layer > Photo Filter (Color picker)',
  },
  knownGotchas: [
    'GROUND TRUTH color-object class: `HSBC` (Hue/Saturation/Brightness). Current snippet emits `RGBC` (RGBColor) instead — PS accepts either on the photoFilter `Clr ` slot. LOW finding in audit STEP 10.',
    'HSBC inner keys: `H` (unitDouble #Ang 0..360), `Strt` (putDouble 0..100 percent), `Brgh` (putDouble 0..100 percent). All three required when using HSBC.',
    'RGBC inner keys (legacy / snippet path): `Rd  ` (putDouble 0..255), `Grn ` (putDouble 0..255), `Bl  ` (putDouble 0..255). All three required when using RGBC.',
    '`Dnst` (Density) is putInteger 0..100. Distinct from photoFilter preset path; both share this key.',
    '`PrsL` Preserve Luminosity is optional in the setd — ground-truth capture omitted it (user did not move the toggle). When emitted, plain boolean.',
    'PS 2026 emits ONLY a setd on this path (no Mk envelope captured) — the photo-filter adjustment layer pre-exists in default state when this setd lands. Editmamei may emit Mk-with-values to create-with-values atomically.',
  ],
  versionNotes: [
    'HSBC emission appears to be the PS 27 default for the color-picker path; older PS used RGBC. Both forms accepted on PS 24+; PS 23 and earlier may have required RGBC.',
  ],
  events: [
    {
      index: 1,
      event: charID('setd'),
      comment:
        'Applies the custom color via the photoFilter Clr slot. Ground truth uses HSBC; snippet currently uses RGBC. Both work on PS 27.',
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
            name: 'T (the photoFilter values descriptor)',
            typeID: charID('T   '),
            kind: 'object',
            required: true,
            innerShape: {
              classID: stringID('photoFilter'),
              fields: [
                {
                  name: 'Color (HSBC HSB color object — ground truth)',
                  typeID: charID('Clr '),
                  kind: 'object',
                  required: true,
                  innerShape: {
                    classID: charID('HSBC'),
                    fields: [
                      {
                        name: 'Hue (#Ang unitDouble)',
                        typeID: charID('H   '),
                        kind: 'unitDouble',
                        required: true,
                        unit: { charID: '#Ang' },
                        range: { min: 0, max: 360 },
                      },
                      {
                        name: 'Saturation (percent putDouble)',
                        typeID: charID('Strt'),
                        kind: 'double',
                        required: true,
                        range: { min: 0, max: 100 },
                      },
                      {
                        name: 'Brightness (percent putDouble)',
                        typeID: charID('Brgh'),
                        kind: 'double',
                        required: true,
                        range: { min: 0, max: 100 },
                      },
                    ],
                  },
                  description:
                    "HSBC is the PS 27 ground-truth color class for the photoFilter Clr slot. RGBC (Rd/Grn/Bl doubles 0..255) is the snippet's current emission — both accepted.",
                },
                {
                  name: 'Density',
                  typeID: charID('Dnst'),
                  kind: 'integer',
                  required: true,
                  range: { min: 0, max: 100, default: 25 },
                },
                {
                  name: 'Preserve Luminosity',
                  typeID: charID('PrsL'),
                  kind: 'boolean',
                  required: false,
                  booleanDefault: true,
                  description: 'PS may emit when user touches the toggle; default true if absent.',
                },
              ],
            },
          },
        ],
      },
    },
  ],
};
