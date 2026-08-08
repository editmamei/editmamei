/**
 * Gradient FILL layer — Mk contentLayer/gradientLayer + follow-up setd.
 *
 * Ground truth: PS 27.x Windows, captured 2026-06-20 (menu capture of the
 * modern Gradient tool creating a "New Gradient Fill Layer"). Live-verified
 * 2026-08-03 (PS 2026 Windows) with objective pixel checks across all five
 * GrdT types, reverse, and custom color/opacity stops.
 *
 * Two-event shape, mirrored exactly by the `addGradientFillLayer` snippet:
 *   1. Mk  → null(class contentLayer) → Usng(contentLayer) → Type(gradientLayer)
 *      — NO Angl and NO Rvrs on the create-time descriptor (PS omits both;
 *      keeping unverified keys off the Mk avoids the Windows-lenient /
 *      macOS-strict rejection class).
 *   2. setd → null(ref contentLayer/Ordn/Trgt) → T(gradientLayer) — the FULL
 *      descriptor including Angl (#Ang) and, when reverse is on, Rvrs. This
 *      is where PS itself carries the angle.
 *
 * The `Grad → Grdn` payload (Nm/GrdF/Intr + Clrs/Trns stop lists) is
 * byte-identical in shape to the gradient-map spec — see
 * adjustments/gradient-map-default.ts for the fully-annotated stop-list
 * field detail and gotchas (0..4096 locations, Clrt/TrnS classes, the
 * Intr = 4096 scale).
 */

import type { AmEventSpec, AmObjectShape } from '../../types.js';
import { charID, stringID } from '../../types.js';

// The gradientLayer member fields shared by the Mk (create) and setd
// (adjust) envelopes. Angl/Rvrs appear only in the setd instance — flagged
// required:false here with the constraint recorded in the comments above.
const gradientLayerShape: AmObjectShape = {
  classID: stringID('gradientLayer'),
  fields: [
    {
      name: 'Dither',
      typeID: charID('Dthr'),
      kind: 'boolean',
      required: true,
      booleanDefault: true,
    },
    {
      name: 'gradientsInterpolationMethod',
      typeID: stringID('gradientsInterpolationMethod'),
      kind: 'enum',
      required: true,
      enumType: stringID('gradientInterpolationMethodType'),
      enumValues: [{ typeID: charID('Smoo'), label: 'Smooth (default; the only captured value)' }],
    },
    {
      name: 'Angle (setd ONLY — absent from the Mk descriptor in the capture)',
      typeID: charID('Angl'),
      kind: 'unitDouble',
      required: false,
      unit: { charID: '#Ang' },
      range: { min: -180, max: 180, default: 90 },
    },
    {
      name: 'Gradient geometry type',
      typeID: charID('Type'),
      kind: 'enum',
      required: true,
      enumType: charID('GrdT'),
      enumValues: [
        { typeID: charID('Lnr '), label: 'Linear (captured STEP-13)' },
        { typeID: charID('Rdl '), label: 'Radial (captured STEP-14)' },
        { typeID: charID('Angl'), label: 'Angle (live pixel-verified 2026-08-03)' },
        { typeID: charID('Rflc'), label: 'Reflected (live pixel-verified 2026-08-03)' },
        { typeID: charID('Dmnd'), label: 'Diamond (live pixel-verified 2026-08-03)' },
      ],
    },
    {
      name: 'Reverse (setd ONLY, and only when true — PS omits it at the false default)',
      typeID: charID('Rvrs'),
      kind: 'boolean',
      required: false,
      booleanDefault: false,
    },
    {
      name: 'Align with layer',
      typeID: charID('Algn'),
      kind: 'boolean',
      required: true,
      booleanDefault: false,
    },
    {
      name: 'Scale (percent)',
      typeID: charID('Scl '),
      kind: 'unitDouble',
      required: true,
      unit: { charID: '#Prc' },
      range: { min: 10, max: 150, default: 100 },
    },
    {
      name: 'Offset (percent point)',
      typeID: charID('Ofst'),
      kind: 'object',
      required: true,
      innerShape: {
        classID: charID('Pnt '),
        fields: [
          {
            name: 'Horizontal offset',
            typeID: charID('Hrzn'),
            kind: 'unitDouble',
            required: true,
            unit: { charID: '#Prc' },
            range: { min: -100, max: 100, default: 0 },
          },
          {
            name: 'Vertical offset',
            typeID: charID('Vrtc'),
            kind: 'unitDouble',
            required: true,
            unit: { charID: '#Prc' },
            range: { min: -100, max: 100, default: 0 },
          },
        ],
      },
    },
    {
      name: 'Gradient definition (Grdn payload — full field detail in adjustments/gradient-map-default.ts)',
      typeID: charID('Grad'),
      kind: 'object',
      required: true,
      innerShape: {
        classID: charID('Grdn'),
        fields: [
          {
            name: 'Name',
            typeID: charID('Nm  '),
            kind: 'string',
            required: true,
            stringDefault: 'Editmamei Gradient',
          },
          {
            name: 'Gradient Form',
            typeID: charID('GrdF'),
            kind: 'enum',
            required: true,
            enumType: charID('GrdF'),
            enumValues: [{ typeID: charID('CstS'), label: 'Custom Stops' }],
          },
          {
            name: 'Interpolation length (4096 = full scale)',
            typeID: charID('Intr'),
            kind: 'double',
            required: true,
            range: { default: 4096 },
          },
          {
            name: 'Color stops list (Clrt items — see gradient-map-default.ts)',
            typeID: charID('Clrs'),
            kind: 'list',
            required: true,
          },
          {
            name: 'Transparency stops list (TrnS items — see gradient-map-default.ts)',
            typeID: charID('Trns'),
            kind: 'list',
            required: true,
          },
        ],
      },
    },
  ],
};

export const gradientFillLayerSpec: AmEventSpec = {
  id: 'layer-ops/gradient-fill-layer',
  displayName: 'Gradient fill layer (Mk contentLayer/gradientLayer + setd)',
  category: 'layer-ops',
  emittedBy: ['ps_add_fill_layer'],
  snippetRef: 'go-core/cmd/buildtemplates/fragments_gradients.go (vault.AddGradFill)',
  groundTruth: {
    capturedAt: '2026-06-20',
    psVersion: '27.x',
    platform: 'Windows',
    sourceLog: 'STEP-13-gradient-linear.log (+ STEP-14, 2026-06-08 STEP-59)',
    menuPath: 'Gradient tool drag → "New Gradient Fill Layer" (modern gradient widget)',
  },
  knownGotchas: [
    'Angl is NOT on the Mk descriptor in the capture — PS carries the angle via the follow-up setd (desc846/847). Emitting it at create time is a Windows-lenient shape; the snippet mirrors the capture instead.',
    'Rvrs appears only when reverse is on (PS omits keys at defaults); the snippet emits it setd-only and only when true.',
    'noisePreSeed appears in the capture but is inert for GrdF=CstS gradients — the snippet deliberately omits it (live-verified without it).',
    'Only Lnr /Rdl  are menu-captured; Angl/Rflc/Dmnd were verified by objective pixel measurement (2026-08-03), not capture.',
    'The Grad → Grdn payload shape (Clrs/Trns, 0..4096 locations) is shared with the gradient-map adjustment — one annotated source of truth lives in adjustments/gradient-map-default.ts.',
  ],
  events: [
    {
      index: 1,
      event: charID('Mk  '),
      comment:
        'Creates the gradient fill (content) layer. Capture-shape: no Angl, no Rvrs at create time.',
      descriptor: {
        classID: charID('null'),
        fields: [
          {
            name: 'target (null reference to contentLayer class)',
            typeID: charID('null'),
            kind: 'reference',
            required: true,
            referenceShape: { classID: stringID('contentLayer'), variant: 'class' },
          },
          {
            name: 'Using (the type-bearing descriptor)',
            typeID: charID('Usng'),
            kind: 'object',
            required: true,
            innerShape: {
              classID: stringID('contentLayer'),
              fields: [
                {
                  name: 'Type (the gradientLayer descriptor, sans Angl/Rvrs)',
                  typeID: charID('Type'),
                  kind: 'object',
                  required: true,
                  innerShape: gradientLayerShape,
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
        'Re-writes the full gradientLayer descriptor on the just-created layer, now including Angl (and Rvrs when reverse is on). This is where PS itself puts the angle.',
      descriptor: {
        classID: charID('setd'),
        fields: [
          {
            name: 'target (contentLayer / Ordn / Trgt reference)',
            typeID: charID('null'),
            kind: 'reference',
            required: true,
            referenceShape: { classID: stringID('contentLayer'), variant: 'enumerated' },
          },
          {
            name: 'T (the full gradientLayer descriptor)',
            typeID: charID('T   '),
            kind: 'object',
            required: true,
            innerShape: gradientLayerShape,
          },
        ],
      },
    },
  ],
};
