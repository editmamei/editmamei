/**
 * Stroke layer style — applied via the layer's Layer Effects (Lefx) property.
 *
 * Ground truth: PS 27.7.0 Windows, captured 2026-06-03.
 * Capture log: JS-28-Stroke.log
 *
 * The user chose Layer > Layer Style > Stroke with custom values (color
 * red, position Outside, blend mode Normal, opacity 78, size 111 px).
 *
 * PS emits a SINGLE `setd` event targeting the layer's `Lefx` property,
 * exactly mirroring the Drop Shadow shape — outer `Lefx` parent with a
 * `Scl ` global scale and a child `FrFX` (Frame FX) object keyed by
 * charID `FrFX` that carries the stroke values.
 *
 * **Editmamei snippet vs capture (2026-06-03 audit Group C, STEP 28 — LOW).**
 * Solid snippet. Event ID, parent `Lefx` scaffold, child `FrFX` class
 * wrapper, all required keys/types match. Missing-from-snippet but
 * captured-by-PS: `present`, `showInDialog`, `overprint`. All optional;
 * PS supplies defaults. No functional gap.
 *
 * **Position enum mapping.** The `Styl` field uses enum type `FStl`
 * with three values: `OutF` (Outside — capture), `InsF` (Inside), and
 * `CtrF` (Center). The Editmamei snippet maps the tool's
 * `stroke_position` parameter to these via a small lookup.
 *
 * **Paint-type enum.** The `PntT` field uses enum type `FrFl` with
 * values `SClr` (Solid Color — snippet + capture), `GrFl` (Gradient),
 * and `Ptrn` (Pattern). Only solid color is currently exposed by the
 * Editmamei tool.
 */

import type { AmEventSpec } from '../../types.js';
import { charID, stringID } from '../../types.js';

export const strokeSpec: AmEventSpec = {
  id: 'layer-styles/stroke',
  displayName: 'Stroke layer style',
  category: 'layer-styles',
  emittedBy: ['ps_add_layer_style (style=stroke)'],
  snippetRef:
    'go-core/cmd/buildtemplates/fragments_layer_properties.go (vault.AddLayerStyle — stroke branch)',
  groundTruth: {
    capturedAt: '2026-06-03',
    psVersion: '27.7.0',
    platform: 'Windows',
    sourceLog: 'JS-28-Stroke.log',
    menuPath: 'Layer > Layer Style > Stroke',
  },
  knownGotchas: [
    'The Editmamei snippet omits `present`, `showInDialog`, and `overprint` Booleans. These are all OPTIONAL — PS supplies defaults — so the descriptor takes effect either way. Documented as `required: false` fields here for an exact-reproduction snippet.',
    'The child `FrFX` object is keyed by charID `FrFX` (same charID as its class) inside the parent `Lefx` descriptor. Both the key typeID and the inner classID are `FrFX`. Matches the Drop Shadow / Outer Glow pattern (doubled key+class charID).',
    'Position uses enum TYPE `FStl` with values `OutF` / `InsF` / `CtrF`. Forum lore sometimes lists `OutsetFrame` / `InsetFrame` as the enum values — those are stringID aliases; use the charIDs to match the canonical capture.',
    'Paint type `PntT` accepts `SClr` (Solid Color), `GrFl` (Gradient), and `Ptrn` (Pattern). Only `SClr` is currently exposed by the Editmamei tool; gradient and pattern strokes would need additional schema fields and a different inner descriptor shape.',
  ],
  versionNotes: [
    'Capture from PS 27.7.0 Windows; the FrFX descriptor shape is stable across recent PS majors per prior macOS spot-checks.',
  ],
  events: [
    {
      index: 1,
      event: charID('setd'),
      comment:
        "Set the layer's Lefx (Layer Effects) property to a Lefx descriptor that contains a FrFX child object. The reference points at the current layer's Lefx property (Prpr=Lefx, Lyr/Ordn/Trgt).",
      descriptor: {
        classID: charID('null'),
        fields: [
          {
            name: "target (reference to current layer's Lefx property)",
            typeID: charID('null'),
            kind: 'reference',
            required: true,
            referenceShape: {
              classID: charID('Lyr '),
              variant: 'property',
              property: charID('Lefx'),
            },
            description:
              "Compound reference: putProperty(Lyr, Lefx) THEN putEnumerated(Lyr, Ordn, Trgt). Targets the active layer's Layer Effects property.",
          },
          {
            name: 'T (the Lefx values descriptor)',
            typeID: charID('T   '),
            kind: 'object',
            required: true,
            innerShape: {
              classID: charID('Lefx'),
              fields: [
                {
                  name: 'Scale (effect scale)',
                  typeID: charID('Scl '),
                  kind: 'unitDouble',
                  required: true,
                  unit: { charID: '#Prc' },
                  range: { min: 0, max: 1000, default: 100 },
                  description: 'Layer-effects scale percentage.',
                },
                {
                  name: 'FrFX (the Frame FX / Stroke child object)',
                  typeID: charID('FrFX'),
                  kind: 'object',
                  required: true,
                  innerShape: {
                    classID: charID('FrFX'),
                    fields: [
                      {
                        name: 'Enabled',
                        typeID: charID('enab'),
                        kind: 'boolean',
                        required: true,
                        booleanDefault: true,
                        description: 'Whether the stroke effect is enabled.',
                      },
                      {
                        name: 'present',
                        typeID: stringID('present'),
                        kind: 'boolean',
                        required: false,
                        booleanDefault: true,
                        description:
                          "Whether the effect slot is present in the layer's effects list. PS supplies true by default.",
                      },
                      {
                        name: 'showInDialog',
                        typeID: stringID('showInDialog'),
                        kind: 'boolean',
                        required: false,
                        booleanDefault: true,
                        description:
                          'Whether the effect shows in the Layer Style dialog UI. Cosmetic.',
                      },
                      {
                        name: 'Stroke Position',
                        typeID: charID('Styl'),
                        kind: 'enum',
                        required: true,
                        enumType: charID('FStl'),
                        enumValues: [
                          {
                            typeID: charID('OutF'),
                            label: 'Outside',
                            context: "Stroke renders outside the layer's opaque pixels.",
                          },
                          {
                            typeID: charID('InsF'),
                            label: 'Inside',
                            context: "Stroke renders inside the layer's opaque pixels.",
                          },
                          {
                            typeID: charID('CtrF'),
                            label: 'Center',
                            context: 'Stroke renders centered on the edge of the opaque pixels.',
                          },
                        ],
                        description:
                          "Stroke position. Editmamei snippet maps the tool's `stroke_position` parameter via a lookup that defaults to OutF when unset.",
                      },
                      {
                        name: 'Paint Type',
                        typeID: charID('PntT'),
                        kind: 'enum',
                        required: true,
                        enumType: charID('FrFl'),
                        enumValues: [
                          {
                            typeID: charID('SClr'),
                            label: 'Solid Color',
                            context: 'Only paint type currently exposed by the Editmamei tool.',
                          },
                          {
                            typeID: charID('GrFl'),
                            label: 'Gradient',
                            context: 'Not currently exposed.',
                          },
                          {
                            typeID: charID('Ptrn'),
                            label: 'Pattern',
                            context: 'Not currently exposed.',
                          },
                        ],
                        description:
                          'Stroke fill type. Solid color is the only supported value today.',
                      },
                      {
                        name: 'Blend Mode',
                        typeID: charID('Md  '),
                        kind: 'enum',
                        required: true,
                        enumType: charID('BlnM'),
                        enumValues: [
                          {
                            typeID: charID('Nrml'),
                            label: 'Normal',
                            context: 'Default Stroke blend mode.',
                          },
                          { typeID: charID('Mltp'), label: 'Multiply' },
                          { typeID: charID('Scrn'), label: 'Screen' },
                          { typeID: charID('Ovrl'), label: 'Overlay' },
                        ],
                        description: 'Stroke blend mode. Defaults to Normal.',
                      },
                      {
                        name: 'Opacity',
                        typeID: charID('Opct'),
                        kind: 'unitDouble',
                        required: true,
                        unit: { charID: '#Prc' },
                        range: { min: 0, max: 100, default: 100 },
                        description: 'Stroke opacity percentage.',
                      },
                      {
                        name: 'Size',
                        typeID: charID('Sz  '),
                        kind: 'unitDouble',
                        required: true,
                        unit: { charID: '#Pxl' },
                        range: { min: 0, max: 250, default: 3 },
                        description: 'Stroke size (thickness) in pixels.',
                      },
                      {
                        name: 'Color',
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
                              range: { min: 0, max: 255, default: 0 },
                            },
                            {
                              name: 'Green',
                              typeID: charID('Grn '),
                              kind: 'double',
                              required: true,
                              range: { min: 0, max: 255, default: 0 },
                            },
                            {
                              name: 'Blue',
                              typeID: charID('Bl  '),
                              kind: 'double',
                              required: true,
                              range: { min: 0, max: 255, default: 0 },
                            },
                          ],
                        },
                        description:
                          'Stroke color, RGBC descriptor. Required when PntT=SClr. Capture used red (255/~0/~0); note PS may emit fractional values like 0.003891 instead of exact 0 — this is a PS UI float-precision artifact, not meaningful.',
                      },
                      {
                        name: 'Overprint',
                        typeID: stringID('overprint'),
                        kind: 'boolean',
                        required: false,
                        booleanDefault: false,
                        description:
                          'CMYK overprint flag for the stroke. Optional; PS supplies false by default.',
                      },
                    ],
                  },
                  description:
                    'The Stroke (Frame FX) inner descriptor, keyed by charID `FrFX` under a class of charID `FrFX`.',
                },
              ],
            },
          },
        ],
      },
    },
  ],
};
