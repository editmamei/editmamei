/**
 * Camera Raw Filter (Filter > Camera Raw Filter) as a re-editable Smart Filter.
 *
 * Ground truth: PS 27.x Windows, Camera Raw 18.2.2, captured 2026-06-29
 * across a 10-step capture session.
 *
 * This spec pins the ACR `Fltr` descriptor (91 distinct charID keys were
 * captured; this models the high/med-confidence, user-meaningful subset the
 * v1 tool exposes). ALL keys are charID (4-char) and live inside the `Fltr`
 * object of class stringID("Adobe Camera Raw Filter").
 *
 * TWO invocation shapes, both captured:
 *   event[0] APPLY    — executeAction(stringID("Adobe Camera Raw Filter"), desc, NO)
 *                       where `desc` carries the handshake + ACR keys DIRECTLY.
 *                       Applied to the active Smart Object.
 *   event[1] RE-EDIT  — executeAction(charID("setd"), desc, NO) where
 *                       desc.null = reference -> filterFX index 1 on target Lyr,
 *                       desc.filterFX = object(class filterFX){ Fltr = object(
 *                       class "Adobe Camera Raw Filter"){ ...ACR keys... } }.
 *                       The descriptor carries the FULL prior
 *                       state — the tool's re-edit mode reads current `Fltr`,
 *                       mutates only the requested keys, and re-emits the whole
 *                       object so every other slider survives.
 *
 * Emitted-JSX assertions live in the Go golden test (go-core is the runtime
 * engine); this file is the ground-truth key/kind/unit/range record, and the
 * registry-integrity test validates it structurally.
 *
 * Version handshake (PrVN/PrVe/CrVe) is REQUIRED on every emit and pinned
 * verbatim from the capture — Adobe rotates ACR process-version keys between
 * Camera Raw releases (see versionNotes).
 *
 * Owed captures (all maintainer-gated; do NOT guess forum keys): global
 * Saturation, the point tone-curve list, As-Shot/Auto WBal enum values, and
 * the PCVS vignette-style integer->label map.
 */

import type { AmEventSpec, AmField, AmObjectShape } from '../../types.js';
import { charID, stringID } from '../../types.js';

// ── Version handshake — required on every emit ──────────────────────────────
const handshakeFields: AmField[] = [
  {
    name: 'Camera Raw version (CrVe)',
    typeID: charID('CrVe'),
    kind: 'string',
    required: true,
    stringDefault: '18.2.2',
    description: 'Camera Raw version string. Captured "18.2.2" (PS 27.x Windows).',
    gotchas: [
      'PS emits this putString triple-quoted ("""18.2.2"""). Pin the value from the raw capture; the generic slice parser drops triple-quoted strings.',
    ],
  },
  {
    name: 'Process version number (PrVN)',
    typeID: charID('PrVN'),
    kind: 'integer',
    required: true,
    range: { default: 6 },
    description: 'ACR process-version number. Captured 6.',
  },
  {
    name: 'Process version (PrVe)',
    typeID: charID('PrVe'),
    kind: 'integer',
    required: true,
    range: { default: 251920384 },
    description: 'ACR process version, encoded. Captured 251920384.',
    gotchas: ['Version-fragile — recapture on a new Camera Raw release; do not extrapolate.'],
  },
];

// helper for the many symmetric -100..+100 integer sliders
const bi = (name: string, id: string, cap: string, desc: string): AmField => ({
  name: `${name} (${id.trim()})`,
  typeID: charID(id),
  kind: 'integer',
  required: false,
  range: { min: -100, max: 100, default: 0 },
  description: `${desc} Captured ${cap}.`,
});

// helper for 0..max integer sliders
const uni = (name: string, id: string, max: number, cap: string, desc: string): AmField => ({
  name: `${name} (${id.trim()})`,
  typeID: charID(id),
  kind: 'integer',
  required: false,
  range: { min: 0, max, default: 0 },
  description: `${desc} Captured ${cap}.`,
});

// ── Basic panel ─────────────────────────────────────────────────────────────
const basicFields: AmField[] = [
  {
    name: 'White balance mode (WBal)',
    typeID: charID('WBal'),
    kind: 'enum',
    required: false,
    enumType: charID('WBal'),
    enumValues: [{ typeID: charID('Cst '), label: 'Custom', context: 'Only value captured.' }],
    description:
      'White-balance mode. For the Camera Raw *Filter* (rendered RGB), Custom uses relative Temp/Tint, NOT Kelvin.',
    gotchas: ['As Shot / Auto enum values are NOT captured — owed capture; do not guess.'],
  },
  bi(
    'Temperature',
    'Temp',
    '15',
    'Relative white-balance temperature (Filter: -100..+100, not Kelvin).'
  ),
  bi('Tint', 'Tint', '-8', 'White-balance tint.'),
  {
    name: 'Exposure 2012 (Ex12)',
    typeID: charID('Ex12'),
    kind: 'double',
    required: false,
    range: { min: -5, max: 5, default: 0 },
    description: 'Exposure in EV (-5.00..+5.00). Captured 0.5. putDouble (no unit).',
  },
  bi('Contrast 2012', 'Cr12', '20', 'Contrast.'),
  bi('Highlights 2012', 'Hi12', '-40', 'Highlights recovery.'),
  bi('Shadows 2012', 'Sh12', '30', 'Shadows lift.'),
  bi('Whites 2012', 'Wh12', '10', 'Whites clip point.'),
  bi('Blacks 2012', 'Bk12', '-15', 'Blacks clip point.'),
  bi('Texture', 'CrTx', '7', 'Texture (mid-frequency detail).'),
  bi('Clarity 2012', 'Cl12', '-12', 'Clarity (local contrast).'),
  bi('Dehaze', 'Dhze', '11', 'Dehaze.'),
  bi('Vibrance', 'Vibr', '9', 'Vibrance (saturation of muted colors).'),
  // NOTE: global Saturation key intentionally omitted — never captured.
];

// ── Parametric tone curve (point curve is a putList; not captured) ──────────
const curveFields: AmField[] = [
  bi('Parametric highlights', 'PC_H', '20', 'Tone-curve highlights region.'),
  bi('Parametric lights', 'PC_L', '10', 'Tone-curve lights region.'),
  bi('Parametric darks', 'PC_D', '-10', 'Tone-curve darks region.'),
  bi('Parametric shadows', 'PC_S', '-20', 'Tone-curve shadows region.'),
  uni('Shadow split point', 'PC_1', 100, '25', 'Parametric curve shadow split (default 25).'),
  uni('Midtone split point', 'PC_2', 100, '50', 'Parametric curve midtone split (default 50).'),
  uni('Highlight split point', 'PC_3', 100, '75', 'Parametric curve highlight split (default 75).'),
];

// ── Detail: sharpening + noise reduction ────────────────────────────────────
const detailFields: AmField[] = [
  uni('Sharpening amount', 'Shrp', 150, '50', 'Sharpening amount (0..150).'),
  {
    name: 'Sharpening radius (ShpR)',
    typeID: charID('ShpR'),
    kind: 'double',
    required: false,
    range: { min: 0.5, max: 3, default: 1 },
    description: 'Sharpening radius (0.5..3.0). Captured 1.2. putDouble.',
  },
  uni('Sharpening detail', 'ShpD', 100, '30', 'Sharpening detail.'),
  uni('Sharpening masking', 'ShpM', 100, '20', 'Sharpening edge masking.'),
  uni('Luminance NR', 'LNR ', 100, '25', 'Luminance noise reduction.'),
  uni('Luminance NR detail', 'LNRD', 100, '50', 'Luminance NR detail.'),
  uni('Luminance NR contrast', 'LNRC', 100, '0', 'Luminance NR contrast.'),
  uni('Color NR', 'CNR ', 100, '30', 'Color noise reduction.'),
  uni('Color NR detail', 'CNRD', 100, '50', 'Color NR detail.'),
  uni('Color NR smoothness', 'CNRS', 100, '50', 'Color NR smoothness.'),
];

// ── HSL / Color mixer — 8 channels x {Hue HA_, Sat SA_, Lum LA_} ────────────
const HSL_CHANNELS: Array<[string, string]> = [
  ['R', 'red'],
  ['O', 'orange'],
  ['Y', 'yellow'],
  ['G', 'green'],
  ['A', 'aqua'],
  ['B', 'blue'],
  ['P', 'purple'],
  ['M', 'magenta'],
];
const hslGroup = (prefix: string, label: string): AmField[] =>
  HSL_CHANNELS.map(([ch, name]) => ({
    name: `${label} ${name} (${prefix}${ch})`,
    typeID: charID(`${prefix}${ch}`),
    kind: 'integer' as const,
    required: false,
    range: { min: -100, max: 100, default: 0 },
    description: `HSL ${label.toLowerCase()} adjustment for ${name}.`,
  }));
const hslFields: AmField[] = [
  ...hslGroup('HA_', 'Hue'),
  ...hslGroup('SA_', 'Saturation'),
  ...hslGroup('LA_', 'Luminance'),
];

// ── Color grading (split-toning + 3-way) ────────────────────────────────────
const colorGradeFields: AmField[] = [
  uni('Split shadow hue', 'STSH', 360, '188', 'Color-grade shadow hue (0..360).'),
  uni('Split shadow saturation', 'STSS', 100, '59', 'Color-grade shadow saturation.'),
  uni('Split highlight hue', 'STHH', 360, '15', 'Color-grade highlight hue (0..360).'),
  uni('Split highlight saturation', 'STHS', 100, '66', 'Color-grade highlight saturation.'),
  bi('Split balance', 'STB ', '20', 'Color-grade shadow/highlight balance.'),
  uni('Midtone hue', 'CgMH', 360, '0', 'Color-grade midtone hue.'),
  uni('Midtone saturation', 'CgMS', 100, '0', 'Color-grade midtone saturation.'),
  bi('Shadow luminance', 'CgSL', '0', 'Color-grade shadow luminance.'),
  bi('Midtone luminance', 'CgML', '0', 'Color-grade midtone luminance.'),
  bi('Highlight luminance', 'CgHL', '0', 'Color-grade highlight luminance.'),
  uni('Grade blending', 'CgBl', 100, '50', 'Color-grade blending (default 50).'),
  uni('Global hue', 'CgGH', 360, '0', 'Color-grade global hue.'),
  uni('Global saturation', 'CgGS', 100, '0', 'Color-grade global saturation.'),
  bi('Global luminance', 'CgGL', '0', 'Color-grade global luminance.'),
];

// ── Optics + Effects ────────────────────────────────────────────────────────
const opticsEffectsFields: AmField[] = [
  bi('Lens vignette amount', 'VigA', '-13', 'Lens-correction vignette amount.'),
  uni('Lens vignette midpoint', 'VigM', 100, '58', 'Lens-correction vignette midpoint.'),
  uni('Defringe purple amount', 'DfPA', 20, '4', 'Defringe purple amount (0..20).'),
  uni('Defringe purple hue low', 'DPHL', 100, '24', 'Defringe purple hue low.'),
  uni('Defringe purple hue high', 'DPHH', 100, '70', 'Defringe purple hue high.'),
  uni('Defringe green amount', 'DfGA', 20, '1', 'Defringe green amount (0..20).'),
  uni('Defringe green hue low', 'DPGL', 100, '40', 'Defringe green hue low.'),
  uni('Defringe green hue high', 'DPGH', 100, '69', 'Defringe green hue high.'),
  uni('Grain amount', 'GRNA', 100, '25', 'Effects grain amount.'),
  uni('Grain size', 'GRNS', 100, '25', 'Effects grain size.'),
  uni('Grain frequency', 'GRNF', 100, '50', 'Effects grain frequency/roughness.'),
  bi('Post-crop vignette amount', 'PCVA', '30', 'Post-crop vignette amount.'),
  uni('Post-crop vignette midpoint', 'PCVM', 100, '50', 'Post-crop vignette midpoint.'),
  uni('Post-crop vignette feather', 'PCVF', 100, '50', 'Post-crop vignette feather.'),
  bi('Post-crop vignette roundness', 'PCVR', '0', 'Post-crop vignette roundness.'),
  {
    name: 'Post-crop vignette style (PCVS)',
    typeID: charID('PCVS'),
    kind: 'integer',
    required: false,
    range: { min: 1, max: 3, default: 1 },
    description: 'Post-crop vignette style (enum-as-int). Captured 1.',
    gotchas: ['Integer->style-label mapping is an owed capture; do not guess labels.'],
  },
];

/** All ACR keys the v1 tool exposes, in a stable panel order. */
const acrFields: AmField[] = [
  ...handshakeFields,
  ...basicFields,
  ...curveFields,
  ...detailFields,
  ...hslFields,
  ...colorGradeFields,
  ...opticsEffectsFields,
];

/** The shared inner shape: an `Adobe Camera Raw Filter` object descriptor. */
const acrFilterShape: AmObjectShape = {
  classID: stringID('Adobe Camera Raw Filter'),
  fields: acrFields,
};

export const cameraRawFilterSpec: AmEventSpec = {
  id: 'filters/camera-raw',
  displayName: 'Camera Raw Filter (re-editable Smart Filter)',
  category: 'filters',
  emittedBy: ['ps_apply_camera_raw'],
  groundTruth: {
    capturedAt: '2026-06-29',
    psVersion: '27.x (Camera Raw 18.2.2)',
    platform: 'Windows',
    sourceLog: 'STEP-01-acr-filter-basic-panel.log',
    menuPath: 'Filter > Camera Raw Filter',
  },
  knownGotchas: [
    'Applies to a SMART OBJECT only. The tool must convert the target layer to a Smart Object first (non-destructive; report it in the payload). Applying to a raster layer bakes the filter in — not re-editable.',
    'Every ACR key is a charID (4-char) inside the `Fltr` object of class stringID("Adobe Camera Raw Filter"). Note the trailing-space charIDs: `LNR `, `CNR `, `STB `.',
    'RE-EDIT is read-modify-write: read the existing `Fltr` descriptor via the filterFX list, mutate only the requested keys, then re-emit the WHOLE object. Emitting a partial descriptor resets every unlisted slider to default.',
    'Local/AI masks inside ACR are OUT of scope: scripted masks do not recompute (coords bake in) and there is no updateAiMasks param.',
  ],
  versionNotes: [
    'PrVN/PrVe/CrVe are the Camera-Raw process-version handshake. Adobe rotates these across ACR releases; recapture and re-pin on a Camera Raw major bump rather than extrapolating.',
    'Slider 4-char keys are ScriptListener-derived, not from a published table — pinned from the 2026-06-29 self-capture per the AM-event discipline.',
    'Owed captures before promotion: global Saturation key, point tone-curve list, As-Shot/Auto WBal enum values, PCVS style labels, plus a macOS parity pass (Windows-lenient shapes can macOS-strict-reject).',
  ],
  events: [
    {
      index: 1,
      event: stringID('Adobe Camera Raw Filter'),
      comment:
        'APPLY: the ACR handshake + slider keys are carried DIRECTLY in the executeAction descriptor and applied to the active Smart Object as a Smart Filter.',
      descriptor: {
        classID: charID('null'),
        fields: acrFields,
      },
    },
    {
      index: 2,
      event: charID('setd'),
      comment:
        'RE-EDIT: set the existing ACR Smart Filter via filterFX index 1. The `Fltr` sub-object (class "Adobe Camera Raw Filter") carries the full re-emitted state.',
      descriptor: {
        classID: charID('null'),
        fields: [
          {
            name: 'target (null reference)',
            typeID: charID('null'),
            kind: 'reference',
            required: true,
            referenceShape: {
              classID: stringID('filterFX'),
              variant: 'index',
            },
            description: 'Reference to filterFX index 1 on the target layer (Lyr /Ordn/Trgt).',
          },
          {
            name: 'filterFX wrapper',
            typeID: stringID('filterFX'),
            kind: 'object',
            required: true,
            innerShape: {
              classID: stringID('filterFX'),
              fields: [
                {
                  name: 'Fltr (Camera Raw Filter object)',
                  typeID: charID('Fltr'),
                  kind: 'object',
                  required: true,
                  innerShape: acrFilterShape,
                  description: 'The ACR filter descriptor — full re-emitted slider state.',
                },
              ],
            },
            description: 'filterFX object wrapping the Fltr Camera-Raw descriptor.',
          },
        ],
      },
    },
  ],
};
