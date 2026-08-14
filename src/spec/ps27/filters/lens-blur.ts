/**
 * Lens Blur filter (Filter > Blur > Lens Blur).
 *
 * Ground truth: PS 27.7.0 Windows, captured 2026-06-03.
 * Capture log: JS-22-Lens-Blur.log
 *
 * The user opened a fresh PS doc, ran Filter > Blur > Lens Blur, and accepted
 * the dialog with values: iris shape Hexagon, radius 27, blade curvature 13,
 * rotation 43, specular brightness 20, specular threshold 176, noise 0,
 * noise distribution Uniform, monochromatic off, depth source default.
 *
 * PS emits ONE event for this filter: `Bokh` (Bokeh — charID), NOT
 * stringID `lensBlur` as forum-lore gists suggest. The descriptor uses
 * the cryptic `Bk*` / `Bt*` / `Be*` charID family — an internal PS
 * convention where `Bk` = Bokeh-key, `Bt` = Bokeh-type, `Be` = Bokeh-enum.
 *
 * **HIGH severity gotcha (the famous Lens Blur silent-no-op bug):** the
 * pre-audit Editmamei snippet emitted `stringIDToTypeID('lensBlur')` with
 * stringID descriptor keys (`radius`, `irisShape`, `noiseDistribution`,
 * etc.). That snippet was forum-lore CS6-era fiction — PS 27.x either
 * throws "command not currently available" or silently no-ops every
 * descriptor key (none resolve to anything PS recognizes). Descriptor-
 * string unit tests passed on fiction.
 *
 * The iris shape enum is NOT named after the polygon (`triangle`,
 * `hexagon`, etc.) — it's numeric-suffixed: `BeS3` / `BeS4` / `BeS5` /
 * `BeS6` / `BeS7` / `BeS8` (triangle through octagon). The noise
 * distribution enum is similarly cryptic: `BeNu` (Uniform) and (inferred)
 * `BeNg` (Gaussian) — the capture only confirms Uniform, so the Gaussian
 * value remains pending a second capture.
 */

import type { AmEventSpec } from '../../types.js';
import { charID } from '../../types.js';

export const lensBlurSpec: AmEventSpec = {
  id: 'filters/lens-blur',
  displayName: 'Lens Blur filter',
  category: 'filters',
  emittedBy: ['ps_filter (type=lens_blur)'],
  snippetRef:
    'go-core/cmd/buildtemplates/fragments_filters.go (vault.LensBlur — forum-lore, slated for full rewrite)',
  groundTruth: {
    capturedAt: '2026-06-03',
    psVersion: '27.7.0',
    platform: 'Windows',
    sourceLog: 'JS-22-Lens-Blur.log',
    menuPath: 'Filter > Blur > Lens Blur',
  },
  knownGotchas: [
    'Event ID MUST be charID `Bokh` (Bokeh). The forum-lore stringID `lensBlur` does NOT resolve to this event on PS 27.x — the call either throws "command not currently available" or silently no-ops. This is the canonical CS6-era-fiction silent-no-op pattern the audit was created to catch.',
    'All descriptor keys MUST use the `Bk*` / `Bt*` / `Be*` charID family (Bokeh-key / Bokeh-type / Bokeh-enum). NONE of the stringIDs `radius` / `irisShape` / `noiseDistribution` / `specularBrightness` / etc. resolve to these keys via PS alias resolution — they are PS-internal charIDs with no friendly stringID names.',
    'Iris shape enum is numeric-suffixed: `BeS3` (triangle), `BeS4` (square), `BeS5` (pentagon), `BeS6` (hexagon), `BeS7` (heptagon), `BeS8` (octagon). The string names "triangle"/"hexagon"/etc. that the pre-audit snippet expected silently fall through to PS defaults.',
    'Noise distribution enum: capture only confirms `BeNu` (Uniform). `BeNg` (Gaussian) is INFERRED from the naming pattern but unverified. A second capture with Gaussian noise selected is needed before treating Gaussian as ground truth.',
    'Radius (`BkIb`) and Specular Brightness (`BkSb`) are putDouble, NOT putInteger. The pre-audit snippet sent integers — depending on PS coercion this is either a silent default-fallback or a noisy type rejection.',
    'Depth source (`BkDi` enum on `BtDi` type) and depth-color (`BkDc` enum on `BtDc` type) are required even when the user is not using a depth map — the capture shows `BeIt` (Image Transparency / default depth source) and `BeCm` (default depth color spec) always emitted.',
  ],
  versionNotes: [
    'Pre-audit Editmamei snippet used stringIDs `lensBlur`, `radius`, `irisShape`, `irisBladeCurvature`, `irisRotation`, `specularBrightness`, `specularThreshold`, `noise`, `noiseDistribution`, `noiseMonochromatic`, `depthMap`, `blurFocalDistance`, `invertDepthMap` — every one of these is wrong against PS 27.7 ScriptListener ground truth. Treat all forum-lore Lens Blur references with extreme suspicion.',
    'Audit report prescribes the full rewrite against this capture. Add `.not.toContain("\'lensBlur\'")` regression guard once the rewrite lands.',
    'Lens Blur joins Shadows/Highlights and Reduce Noise as silently-broken filters that descriptor-string unit tests passed on fiction.',
  ],
  events: [
    {
      index: 1,
      event: charID('Bokh'),
      comment:
        'Single-event filter dispatch. The entire Lens Blur configuration sits in one descriptor — PS does not split this into multiple events the way adjustment-layer creation does. All depth, iris, specular, and noise controls live as siblings under the `Bokh` event descriptor.',
      descriptor: {
        classID: charID('null'),
        fields: [
          {
            name: 'Depth source (BkDi)',
            typeID: charID('BkDi'),
            kind: 'enum',
            required: true,
            enumType: charID('BtDi'),
            enumValues: [
              {
                typeID: charID('BeIt'),
                context:
                  'Default depth source (Image Transparency / no depth map). Always emitted in the no-depth-map capture.',
              },
            ],
            description:
              'Depth source channel for the depth-of-field simulation. Required even when no depth map is in use — PS emits the default value.',
            gotchas: [
              'Pre-audit snippet used stringID `depthMap` with `none`/`transparency`/`layerMask` string values — none of these resolve to the `BkDi`/`BtDi`/`BeIt` charID family.',
            ],
          },
          {
            name: 'Depth-color spec (BkDc)',
            typeID: charID('BkDc'),
            kind: 'enum',
            required: true,
            enumType: charID('BtDc'),
            enumValues: [
              {
                typeID: charID('BeCm'),
                context: 'Default depth-color specification mode. Always emitted in the capture.',
              },
            ],
            description:
              'Depth-color specification mode. Capture only confirms the default value; other values are unverified.',
            gotchas: [
              'Pre-audit snippet did not send this key at all. Capture shows it is required.',
            ],
          },
          {
            name: 'Depth focal distance (BkDp)',
            typeID: charID('BkDp'),
            kind: 'integer',
            required: true,
            range: { min: 0, max: 255, default: 0 },
            description:
              'Focal-plane depth value (0-255 when a depth map is in use). 0 in the no-depth-map default capture.',
          },
          {
            name: 'Depth invert (BkDs)',
            typeID: charID('BkDs'),
            kind: 'boolean',
            required: true,
            booleanDefault: false,
            description: 'Invert the depth map. False in the default capture.',
          },
          {
            name: 'Iris shape (BkIs)',
            typeID: charID('BkIs'),
            kind: 'enum',
            required: true,
            enumType: charID('BtIs'),
            enumValues: [
              {
                typeID: charID('BeS3'),
                label: 'Triangle',
                context: 'Iris shape = triangle (3 sides).',
              },
              {
                typeID: charID('BeS4'),
                label: 'Square',
                context: 'Iris shape = square (4 sides).',
              },
              {
                typeID: charID('BeS5'),
                label: 'Pentagon',
                context: 'Iris shape = pentagon (5 sides).',
              },
              {
                typeID: charID('BeS6'),
                label: 'Hexagon',
                context: 'Iris shape = hexagon (6 sides). The captured value in this audit run.',
              },
              {
                typeID: charID('BeS7'),
                label: 'Heptagon',
                context: 'Iris shape = heptagon (7 sides).',
              },
              {
                typeID: charID('BeS8'),
                label: 'Octagon',
                context: 'Iris shape = octagon (8 sides).',
              },
            ],
            description:
              'Iris (aperture) shape — controls the polygon of out-of-focus bokeh highlights.',
            gotchas: [
              'Enum values are numeric-suffixed (`BeS3`-`BeS8`), NOT polygon-name stringIDs. Pre-audit snippet expected `triangle`/`square`/`pentagon`/`hexagon`/`heptagon`/`octagon` strings — none of these resolve to the charID enum.',
            ],
          },
          {
            name: 'Iris blur radius (BkIb)',
            typeID: charID('BkIb'),
            kind: 'double',
            required: true,
            range: { min: 0, max: 100, default: 15 },
            description: 'Iris radius (blur amount). Capture: 27.0.',
            gotchas: [
              'putDouble, NOT putInteger. Pre-audit snippet emitted as integer — likely silent type-coercion or default-fallback on PS 27.x.',
            ],
          },
          {
            name: 'Iris blade curvature (BkIc)',
            typeID: charID('BkIc'),
            kind: 'integer',
            required: true,
            range: { min: 0, max: 100, default: 0 },
            description:
              'Iris blade curvature (0 = straight blades, higher = more rounded). Capture: 13.',
          },
          {
            name: 'Iris rotation (BkIr)',
            typeID: charID('BkIr'),
            kind: 'integer',
            required: true,
            range: { min: 0, max: 360, default: 0 },
            description: 'Iris rotation angle in degrees. Capture: 43.',
          },
          {
            name: 'Specular brightness (BkSb)',
            typeID: charID('BkSb'),
            kind: 'double',
            required: true,
            range: { min: 0, max: 100, default: 0 },
            description: 'Specular highlight brightness boost. Capture: 20.0.',
            gotchas: ['putDouble, NOT putInteger. Pre-audit snippet emitted as integer.'],
          },
          {
            name: 'Specular threshold (BkSt)',
            typeID: charID('BkSt'),
            kind: 'integer',
            required: true,
            range: { min: 0, max: 255, default: 255 },
            description:
              'Luminance threshold above which highlights count as specular. Capture: 176.',
          },
          {
            name: 'Noise amount (BkNa)',
            typeID: charID('BkNa'),
            kind: 'integer',
            required: true,
            range: { min: 0, max: 100, default: 0 },
            description: 'Noise amount (0-100). Capture: 0.',
          },
          {
            name: 'Noise distribution (BkNt)',
            typeID: charID('BkNt'),
            kind: 'enum',
            required: true,
            enumType: charID('BtNt'),
            enumValues: [
              {
                typeID: charID('BeNu'),
                label: 'Uniform',
                context:
                  'Uniform noise distribution. The only value confirmed by the audit capture.',
              },
              {
                typeID: charID('BeNg'),
                label: 'Gaussian',
                context:
                  'Gaussian noise distribution. INFERRED from naming pattern (`BeNu` + Uniform → `BeNg` + Gaussian) — UNVERIFIED. A second capture with Gaussian selected is needed before treating as ground truth.',
              },
            ],
            description: 'Noise distribution mode for the noise-amount slider.',
            gotchas: [
              'Pre-audit snippet expected `uniform` / `gaussian` stringIDs. Capture shows `BeNu` charID (Uniform).',
              '`BeNg` (Gaussian) is INFERRED from naming pattern, NOT confirmed by capture. Audit recommends a second capture run with Gaussian selected to verify.',
            ],
          },
          {
            name: 'Noise monochromatic (BkNm)',
            typeID: charID('BkNm'),
            kind: 'boolean',
            required: true,
            booleanDefault: false,
            description:
              'Monochromatic noise (true = grayscale noise; false = color noise). Capture: false.',
          },
        ],
      },
    },
  ],
};
