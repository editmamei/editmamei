/**
 * Drop Shadow layer style — applied via the layer's Layer Effects (Lefx) property.
 *
 * Ground truth: PS 27.7.0 Windows, captured 2026-06-03.
 * Capture log: JS-27-Drop-Shadow.log
 *
 * The user opened a fresh PS doc, promoted the background layer, and chose
 * Layer > Layer Style > Drop Shadow with custom values (color black, blend
 * mode Multiply, opacity 56, angle 90, distance 14 px, spread 21, size 38 px,
 * noise 21, contour "Cove - Shallow").
 *
 * PS emits a SINGLE `setd` event targeting the layer's `Lefx` property. The
 * outer T payload is a `Lefx`-classed descriptor that contains a global
 * `Scl ` scale and a `gagl` global angle, plus a child `DrSh` object keyed
 * by charID `DrSh` carrying the actual drop-shadow values.
 *
 * **Editmamei snippet vs capture (2026-06-03 audit Group C, STEP 27 — MED).**
 * The snippet matches the event ID, parent `Lefx` scaffold, child `DrSh`
 * class wrapper, and all required keys/types. Missing-from-snippet but
 * captured-by-PS: `present` (effect enabled tri-state), `showInDialog` (UI
 * state), `layerConceals` (knockout), `TrnS` contour curve, and the
 * parent-level `gagl` global angle. None of these are required for the
 * descriptor to take effect — modern PS supplies defaults — so the snippet
 * is functionally correct but cosmetically incomplete vs. menu emission.
 *
 * **Intentional divergence — `uglg` semantics.** The capture has `uglg=true`
 * (use global angle, follows the user's UI session preference). The snippet
 * hardcodes `uglg=false` ("unlink global angle") so the `angle` parameter
 * supplied to the tool is authoritative for THIS drop shadow regardless of
 * the document-wide global-light setting. This is an intentional Editmamei
 * design choice for tool determinism, not a bug — documented in the
 * `knownGotchas` below.
 *
 * **Spread unit caveat.** The capture used `#Pxl` for `Ckmt` (spread); the
 * snippet emits `#Prc`. The audit confirms `#Prc` is the canonical choice
 * for Drop Shadow spread; the `#Pxl` in the capture is a per-version /
 * per-UI-session variance. Keep `#Prc`.
 */

import type { AmEventSpec } from '../../types.js';
import { charID, stringID } from '../../types.js';

export const dropShadowSpec: AmEventSpec = {
  id: 'layer-styles/drop-shadow',
  displayName: 'Drop Shadow layer style',
  category: 'layer-styles',
  emittedBy: ['ps_add_layer_style (style=drop_shadow)'],
  snippetRef:
    'go-core/cmd/buildtemplates/fragments_layer_properties.go (vault.AddLayerStyle — drop_shadow branch)',
  groundTruth: {
    capturedAt: '2026-06-03',
    psVersion: '27.7.0',
    platform: 'Windows',
    sourceLog: 'JS-27-Drop-Shadow.log',
    menuPath: 'Layer > Layer Style > Drop Shadow',
  },
  knownGotchas: [
    'The `uglg` field (use global light angle) is hardcoded to `false` in the Editmamei snippet by design — the tool exposes an `angle` parameter and treating it as authoritative requires unlinking from the document-wide global light. The menu capture shows `uglg=true` because the user did not unlink in the UI. This is an intentional Editmamei design choice, not a snippet bug.',
    'The Editmamei snippet omits `present`, `showInDialog`, `layerConceals`, `TrnS` (contour), and the parent-level `gagl` (global angle on Lefx). These are all OPTIONAL — modern PS supplies sensible defaults — so the descriptor takes effect either way. Documented as `required: false` fields here for completeness; an exact-reproduction snippet would emit them.',
    'Capture used `#Pxl` for `Ckmt` (spread); the canonical Drop Shadow spec is `#Prc` and the Editmamei snippet emits `#Prc`. Do NOT switch to `#Pxl` based on a single capture — the PS UI may emit either depending on session state, but `#Prc` is the documented canonical form.',
    'The child `DrSh` object is keyed by charID `DrSh` (same charID as its class) inside the parent `Lefx` descriptor. Both the key typeID and the inner classID are `DrSh`. Forum lore sometimes lists this as a single key — both forms appear, but the doubled `(DrSh, DrSh)` shape matches the menu capture.',
  ],
  versionNotes: [
    'Capture from PS 27.7.0 Windows; macOS captures from earlier audits show the same descriptor shape for layer styles.',
  ],
  events: [
    {
      index: 1,
      event: charID('setd'),
      comment:
        "Set the layer's Lefx (Layer Effects) property to a Lefx descriptor that contains a DrSh child object. The reference points at the current layer's Lefx property (Prpr=Lefx, Lyr/Ordn/Trgt).",
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
                  description:
                    'Layer-effects scale percentage. PS emits 100 by default; affects size-of-effect proportionally.',
                },
                {
                  name: 'DrSh (the Drop Shadow child object)',
                  typeID: charID('DrSh'),
                  kind: 'object',
                  required: true,
                  innerShape: {
                    classID: charID('DrSh'),
                    fields: [
                      {
                        name: 'Enabled',
                        typeID: charID('enab'),
                        kind: 'boolean',
                        required: true,
                        booleanDefault: true,
                        description: 'Whether the drop shadow effect is enabled (visible).',
                      },
                      {
                        name: 'present',
                        typeID: stringID('present'),
                        kind: 'boolean',
                        required: false,
                        booleanDefault: true,
                        description:
                          "Whether the effect is present in the layer's effects list (distinct from enabled — present-but-disabled keeps the slot). PS supplies true by default.",
                      },
                      {
                        name: 'showInDialog',
                        typeID: stringID('showInDialog'),
                        kind: 'boolean',
                        required: false,
                        booleanDefault: true,
                        description:
                          'Whether the effect shows in the Layer Style dialog UI. Cosmetic; PS supplies true by default.',
                      },
                      {
                        name: 'Blend Mode',
                        typeID: charID('Md  '),
                        kind: 'enum',
                        required: true,
                        enumType: charID('BlnM'),
                        enumValues: [
                          {
                            typeID: charID('Mltp'),
                            label: 'Multiply',
                            context: 'Default Drop Shadow blend mode.',
                          },
                          { typeID: charID('Nrml'), label: 'Normal' },
                          { typeID: charID('Scrn'), label: 'Screen' },
                          { typeID: charID('Drkn'), label: 'Darken' },
                          { typeID: charID('Lghn'), label: 'Lighten' },
                          { typeID: charID('Ovrl'), label: 'Overlay' },
                        ],
                        description:
                          'Drop shadow blend mode. Drop Shadow defaults to Multiply; the BlnM enum accepts the full PS blend-mode set.',
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
                          'Drop shadow color, RGBC descriptor. Defaults to pure black (0/0/0).',
                      },
                      {
                        name: 'Opacity',
                        typeID: charID('Opct'),
                        kind: 'unitDouble',
                        required: true,
                        unit: { charID: '#Prc' },
                        range: { min: 0, max: 100, default: 75 },
                        description: 'Drop shadow opacity percentage.',
                      },
                      {
                        name: 'Use Global Light',
                        typeID: charID('uglg'),
                        kind: 'boolean',
                        required: true,
                        booleanDefault: true,
                        description:
                          'Whether this drop shadow follows the document-wide global light angle. Editmamei snippet hardcodes FALSE so the `angle` param is authoritative for this effect; PS UI defaults to TRUE. Capture shows TRUE because the user did not unlink — see knownGotchas.',
                      },
                      {
                        name: 'Local Angle',
                        typeID: charID('lagl'),
                        kind: 'unitDouble',
                        required: true,
                        unit: { charID: '#Ang' },
                        range: { min: -180, max: 180, default: 90 },
                        description:
                          'Light angle (degrees). When `uglg=false`, this value is authoritative.',
                      },
                      {
                        name: 'Distance',
                        typeID: charID('Dstn'),
                        kind: 'unitDouble',
                        required: true,
                        unit: { charID: '#Pxl' },
                        range: { min: 0, max: 30000, default: 5 },
                        description: 'Shadow offset distance in pixels.',
                      },
                      {
                        name: 'Spread (Choke)',
                        typeID: charID('Ckmt'),
                        kind: 'unitDouble',
                        required: true,
                        unit: { charID: '#Prc' },
                        range: { min: 0, max: 100, default: 0 },
                        description:
                          'Spread (a.k.a. Choke) percentage. NOTE: capture used `#Pxl` for this field; the canonical Drop Shadow spec is `#Prc` and the Editmamei snippet emits `#Prc`. Keep `#Prc`.',
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
                        description: 'Shadow blur size in pixels. UI label is "Size".',
                      },
                      {
                        name: 'Noise',
                        typeID: charID('Nose'),
                        kind: 'unitDouble',
                        required: true,
                        unit: { charID: '#Prc' },
                        range: { min: 0, max: 100, default: 0 },
                        description: 'Shadow noise percentage.',
                      },
                      {
                        name: 'Anti-alias',
                        typeID: charID('AntA'),
                        kind: 'boolean',
                        required: true,
                        booleanDefault: false,
                        description: 'Whether the shadow contour is anti-aliased.',
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
                              description:
                                'Contour curve name — PS uses localized strings like "$$$/Contours/Defaults/CoveShallow=Cove - Shallow" for built-ins, or the user\'s custom contour name.',
                            },
                          ],
                        },
                        description:
                          'Contour curve for the shadow falloff. Omitted by the Editmamei snippet — PS supplies the default Linear contour. Optional.',
                      },
                      {
                        name: 'Layer Conceals',
                        typeID: stringID('layerConceals'),
                        kind: 'boolean',
                        required: false,
                        booleanDefault: true,
                        description:
                          'Whether the underlying layer knocks out the shadow (the "Layer Knocks Out Drop Shadow" checkbox in the UI). Omitted by the Editmamei snippet — PS supplies true by default.',
                      },
                    ],
                  },
                  description:
                    'The Drop Shadow inner descriptor, keyed by charID `DrSh` under a class of charID `DrSh`.',
                },
                {
                  name: 'Global Angle (parent-level)',
                  typeID: charID('gagl'),
                  kind: 'unitDouble',
                  required: false,
                  unit: { charID: '#Ang' },
                  range: { min: -180, max: 180, default: 120 },
                  description:
                    "Document-wide global light angle, emitted on the parent Lefx. Optional — when omitted, PS retains the current document-wide setting. Capture shows 122 (the user's session value).",
                },
              ],
            },
          },
        ],
      },
    },
  ],
};
