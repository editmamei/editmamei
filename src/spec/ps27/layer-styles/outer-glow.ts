/**
 * Outer Glow layer style — applied via the layer's Layer Effects (Lefx) property.
 *
 * Ground truth: PS 27.7.0 Windows, captured 2026-06-03.
 * Capture log: JS-29-Outer-Glow.log
 *
 * The user chose Layer > Layer Style > Outer Glow with custom values
 * (color yellow-green ~240/255/0, blend mode Screen, opacity 60, technique
 * Softer, spread 32, size 46, noise 23, range 50).
 *
 * PS emits a SINGLE `setd` event targeting the layer's `Lefx` property,
 * exactly mirroring the Drop Shadow / Stroke shape — outer `Lefx` parent
 * with a `Scl ` global scale and a child `OrGl` object keyed by charID
 * `OrGl` that carries the outer-glow values.
 *
 * **Editmamei snippet vs capture (2026-06-03 audit Group C, STEP 29 — MED).**
 * Event ID, parent `Lefx` scaffold, child `OrGl` class wrapper, and core
 * keys/types match. The MED-severity gap: snippet OMITS two real UI
 * parameters — `Inpr` (the "Range" slider, #Prc, default 50) and `ShdN`
 * (shading noise, #Prc, default 0). The omission means the resulting glow
 * always uses PS defaults rather than what the user might specify; for
 * typical use it's invisible (default Range 50 + default Shading Noise 0
 * match what most users want) but the tool surface is incomplete vs UI.
 * Spec marks both as `required: true` so a future snippet update closes
 * the gap and the snippet-vs-spec test forces the fix.
 *
 * **Cosmetic missing flags (LOW).** Snippet also omits `present`,
 * `showInDialog`, `AntA`, `TrnS` contour. All optional; PS defaults.
 *
 * **Spread unit caveat.** Same as Drop Shadow — capture used `#Pxl` for
 * `Ckmt`; the snippet emits `#Prc`. Keep `#Prc` as the canonical form.
 */

import type { AmEventSpec } from '../../types.js';
import { charID, stringID } from '../../types.js';

export const outerGlowSpec: AmEventSpec = {
  id: 'layer-styles/outer-glow',
  displayName: 'Outer Glow layer style',
  category: 'layer-styles',
  emittedBy: ['ps_add_layer_style (style=outer_glow)'],
  snippetRef:
    'go-core/cmd/buildtemplates/fragments_layer_properties.go (vault.AddLayerStyle — outer_glow branch)',
  groundTruth: {
    capturedAt: '2026-06-03',
    psVersion: '27.7.0',
    platform: 'Windows',
    sourceLog: 'JS-29-Outer-Glow.log',
    menuPath: 'Layer > Layer Style > Outer Glow',
  },
  knownGotchas: [
    "The Editmamei snippet is MISSING two real UI parameters that the spec marks REQUIRED: `Inpr` (Range slider, #Prc, default 50) and `ShdN` (shading noise, #Prc, default 0). These need to be added to the snippet + tool schema (`glow_range`, `glow_shading_noise`). The snippet-vs-spec test will fail until they're emitted. Cheap fix; no breaking change since the default values match PS defaults.",
    'The Editmamei snippet also omits `present`, `showInDialog`, `AntA` (anti-alias), and `TrnS` (contour curve). All optional — PS supplies defaults. Documented as `required: false` here.',
    'Capture used `#Pxl` for `Ckmt` (spread); the canonical Outer Glow spec is `#Prc` and the Editmamei snippet emits `#Prc`. Same per-session variance as Drop Shadow — do NOT switch units.',
    'The Glow Technique enum (`GlwT`) uses enum TYPE `BETE` with values `SfBL` (Softer — capture + snippet) and `PrBL` (Precise). Both are documented in the spec; the snippet only emits SfBL today.',
    'The child `OrGl` object is keyed by charID `OrGl` (same charID as its class). Doubled key+class pattern matches Drop Shadow / Stroke.',
    'There is also a separate Glow Source enum (`GlwS`, type — uses `GwSE` for Edge vs `GwSC` for Center) that controls whether the glow emanates from the edge or the center of opaque pixels. The capture omitted this field (PS default = Edge), so it is also not in the snippet; documented as a future spec extension when the UI parameter is exposed.',
  ],
  versionNotes: [
    'Capture from PS 27.7.0 Windows; the OrGl descriptor shape is stable across recent PS majors per prior macOS spot-checks.',
  ],
  events: [
    {
      index: 1,
      event: charID('setd'),
      comment:
        "Set the layer's Lefx (Layer Effects) property to a Lefx descriptor that contains an OrGl child object. The reference points at the current layer's Lefx property (Prpr=Lefx, Lyr/Ordn/Trgt).",
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
                  name: 'OrGl (the Outer Glow child object)',
                  typeID: charID('OrGl'),
                  kind: 'object',
                  required: true,
                  innerShape: {
                    classID: charID('OrGl'),
                    fields: [
                      {
                        name: 'Enabled',
                        typeID: charID('enab'),
                        kind: 'boolean',
                        required: true,
                        booleanDefault: true,
                        description: 'Whether the outer-glow effect is enabled.',
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
                        name: 'Blend Mode',
                        typeID: charID('Md  '),
                        kind: 'enum',
                        required: true,
                        enumType: charID('BlnM'),
                        enumValues: [
                          {
                            typeID: charID('Scrn'),
                            label: 'Screen',
                            context: 'Default Outer Glow blend mode.',
                          },
                          { typeID: charID('Nrml'), label: 'Normal' },
                          { typeID: charID('Mltp'), label: 'Multiply' },
                          { typeID: charID('Ovrl'), label: 'Overlay' },
                          { typeID: charID('Lghn'), label: 'Lighten' },
                        ],
                        description: 'Outer glow blend mode. Defaults to Screen.',
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
                              range: { min: 0, max: 255, default: 255 },
                            },
                            {
                              name: 'Green',
                              typeID: charID('Grn '),
                              kind: 'double',
                              required: true,
                              range: { min: 0, max: 255, default: 255 },
                            },
                            {
                              name: 'Blue',
                              typeID: charID('Bl  '),
                              kind: 'double',
                              required: true,
                              range: { min: 0, max: 255, default: 190 },
                            },
                          ],
                        },
                        description:
                          'Outer glow color, RGBC descriptor. PS default is the classic warm yellow; capture used user-supplied yellow-green. Note PS may emit fractional values like 240.003892 — float-precision artifact.',
                      },
                      {
                        name: 'Opacity',
                        typeID: charID('Opct'),
                        kind: 'unitDouble',
                        required: true,
                        unit: { charID: '#Prc' },
                        range: { min: 0, max: 100, default: 75 },
                        description: 'Outer glow opacity percentage.',
                      },
                      {
                        name: 'Glow Technique',
                        typeID: charID('GlwT'),
                        kind: 'enum',
                        required: true,
                        enumType: charID('BETE'),
                        enumValues: [
                          {
                            typeID: charID('SfBL'),
                            label: 'Softer',
                            context: 'Default; smoother glow falloff.',
                          },
                          {
                            typeID: charID('PrBL'),
                            label: 'Precise',
                            context: 'Sharper glow falloff, preserves edge detail.',
                          },
                        ],
                        description:
                          'Glow rendering technique. The Editmamei snippet hardcodes SfBL today; both values are accepted by PS.',
                      },
                      {
                        name: 'Spread (Choke)',
                        typeID: charID('Ckmt'),
                        kind: 'unitDouble',
                        required: true,
                        unit: { charID: '#Prc' },
                        range: { min: 0, max: 100, default: 0 },
                        description:
                          'Glow spread percentage. NOTE: capture used `#Pxl` for this field; the canonical Outer Glow spec is `#Prc` and the Editmamei snippet emits `#Prc`. Keep `#Prc`.',
                        gotchas: [
                          'Capture used `#Pxl` unit for Ckmt; canonical is `#Prc`. Per-session variance — do NOT flip the snippet based on a single capture.',
                        ],
                      },
                      {
                        name: 'Size (Blur)',
                        typeID: charID('blur'),
                        kind: 'unitDouble',
                        required: true,
                        unit: { charID: '#Pxl' },
                        range: { min: 0, max: 250, default: 5 },
                        description: 'Glow blur size in pixels. UI label is "Size".',
                      },
                      {
                        name: 'Noise',
                        typeID: charID('Nose'),
                        kind: 'unitDouble',
                        required: true,
                        unit: { charID: '#Prc' },
                        range: { min: 0, max: 100, default: 0 },
                        description: 'Glow noise percentage.',
                      },
                      {
                        name: 'Shading Noise',
                        typeID: charID('ShdN'),
                        kind: 'unitDouble',
                        required: true,
                        unit: { charID: '#Prc' },
                        range: { min: 0, max: 100, default: 0 },
                        description:
                          'Glow shading noise (distinct from `Nose`). Editmamei snippet OMITS this — MED audit finding. Add `glow_shading_noise` parameter to addLayerStyle to close the gap.',
                        gotchas: [
                          'Missing from current Editmamei snippet — MED audit finding 2026-06-03. PS default is 0; the omission is invisible for typical use but constrains the tool surface.',
                        ],
                      },
                      {
                        name: 'Anti-alias',
                        typeID: charID('AntA'),
                        kind: 'boolean',
                        required: false,
                        booleanDefault: false,
                        description:
                          'Whether the glow contour is anti-aliased. Optional in the descriptor (PS supplies default), but commonly emitted.',
                      },
                      {
                        name: 'Transfer Spec (contour)',
                        typeID: charID('TrnS'),
                        kind: 'object',
                        required: false,
                        innerShape: {
                          classID: charID('ShpC'),
                          fields: [
                            {
                              name: 'Contour Name',
                              typeID: charID('Nm  '),
                              kind: 'string',
                              required: true,
                              description: 'Contour curve name — PS uses "Linear" for the default.',
                            },
                          ],
                        },
                        description:
                          'Contour curve for the glow falloff. Omitted by the Editmamei snippet — PS supplies the default Linear contour.',
                      },
                      {
                        name: 'Input Range',
                        typeID: charID('Inpr'),
                        kind: 'unitDouble',
                        required: true,
                        unit: { charID: '#Prc' },
                        range: { min: 0, max: 100, default: 50 },
                        description:
                          'Glow input range — the UI\'s "Range" slider that controls which part of the glow contour is used. Editmamei snippet OMITS this — MED audit finding. Add `glow_range` parameter to addLayerStyle to close the gap.',
                        gotchas: [
                          'Missing from current Editmamei snippet — MED audit finding 2026-06-03. PS default is 50; tunes contour input range.',
                        ],
                      },
                    ],
                  },
                  description:
                    'The Outer Glow inner descriptor, keyed by charID `OrGl` under a class of charID `OrGl`.',
                },
              ],
            },
          },
        ],
      },
    },
  ],
};
