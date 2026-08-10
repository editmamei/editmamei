/**
 * Smart Sharpen filter (Filter > Sharpen > Smart Sharpen).
 *
 * Ground truth: PS 27.7.0 Windows, captured 2026-06-03.
 * Capture log: JS-23-Smart-Sharpen.log
 *
 * The user opened Filter > Sharpen > Smart Sharpen, accepted the dialog
 * with values: Amount 107%, Radius 1.7 px, Reduce Noise 26%, Remove
 * Gaussian Blur, Shadows tab Fade 7% / Tonal Width 39% / Radius 15,
 * Highlights tab Fade 13% / Tonal Width 39% / Radius 24.
 *
 * PS emits ONE event: `smartSharpen` (stringID — matches the pre-audit
 * snippet on this one point, but several other things are wrong).
 *
 * **HIGH severity gotcha (the shadows/highlights silent-drop bug):**
 * the sub-object class typeID is `adaptCorrectTones` (no "ive"), NOT
 * `adaptiveCorrectTones` as the pre-audit Editmamei snippet emitted.
 * PS does not recognize the misspelling — the entire shadows-tab and
 * highlights-tab fade/width/radius descriptors fail to attach, falling
 * silently back to defaults (0% fade). The user's S/H sliders appear to
 * do nothing. Note that `applyShadowsHighlights` got this spelling
 * right; the Smart Sharpen snippet copied the wrong spelling from an
 * unrelated source.
 *
 * **HIGH severity gotcha (the amount/noiseReduction type-coercion bug):**
 * root `Amnt` and `noiseReduction` are putUnitDouble with percentUnit
 * (`#Prc`), NOT putInteger. The pre-audit snippet emitted them as
 * integers — PS may coerce or may default-fallback (the audit suspects
 * the latter, since the dialog control is a 1-500% slider that takes
 * fractional values).
 *
 * Plus root-level keys use mixed charID/stringID: `Amnt`/`Rds ` are
 * charID, `noiseReduction` is stringID, `blur`/`blurType` are
 * stringID, the GsnB Gaussian-blur-type enum value is charID. The
 * sub-object keys `sdwM` (shadows mode) and `hglM` (highlights mode)
 * are charID.
 */

import type { AmEventSpec } from '../../types.js';
import { charID, stringID } from '../../types.js';

const adaptCorrectTonesShape = {
  classID: stringID('adaptCorrectTones'),
  fields: [
    {
      name: 'Fade amount (Amnt)',
      typeID: charID('Amnt'),
      kind: 'unitDouble' as const,
      required: true,
      unit: { charID: '#Prc' as const },
      range: { min: 0, max: 100, default: 0 },
      description: 'Fade amount for this tonal region (0-100%).',
      gotchas: [
        'putUnitDouble with percentUnit, NOT putInteger. Pre-audit snippet emitted inner amount as integer — silent default-fallback to 0%.',
      ],
    },
    {
      name: 'Tonal width (Wdth)',
      typeID: charID('Wdth'),
      kind: 'unitDouble' as const,
      required: true,
      unit: { charID: '#Prc' as const },
      range: { min: 0, max: 100, default: 50 },
      description: 'Tonal width for this tonal region (0-100%).',
      gotchas: [
        'putUnitDouble with percentUnit, NOT putInteger. Pre-audit snippet emitted inner width as integer.',
      ],
    },
    {
      name: 'Radius (Rds )',
      typeID: charID('Rds '),
      kind: 'integer' as const,
      required: true,
      range: { min: 1, max: 100, default: 30 },
      description:
        'Radius for this tonal region (in pixels). Inner Rds IS putInteger (unlike root Rds which is putUnitDouble pixelsUnit).',
    },
  ],
};

export const smartSharpenSpec: AmEventSpec = {
  id: 'filters/smart-sharpen',
  displayName: 'Smart Sharpen filter',
  category: 'filters',
  emittedBy: ['ps_filter (type=smart_sharpen)'],
  snippetRef:
    'go-core/cmd/buildtemplates/fragments_filters.go (vault.SmartShrp — sub-object spelling typo, slated for fix)',
  groundTruth: {
    capturedAt: '2026-06-03',
    psVersion: '27.7.0',
    platform: 'Windows',
    sourceLog: 'JS-23-Smart-Sharpen.log',
    menuPath: 'Filter > Sharpen > Smart Sharpen',
  },
  knownGotchas: [
    'Sub-object class typeID for sdwM/hglM is `adaptCorrectTones` (NO "ive"), NOT `adaptiveCorrectTones`. The pre-audit snippet had `adaptiveCorrectTones` — PS silently ignores it and the shadow/highlight fade/width/radius sub-descriptors fail to attach. User sees S/H sliders apparently do nothing.',
    'Root `Amnt` is putUnitDouble with `#Prc` (percentUnit), NOT putInteger. The pre-audit snippet emitted putInteger — type drift that may silently default-fallback the Amount value.',
    'Root `noiseReduction` is putUnitDouble with `#Prc`, NOT putInteger. Same type-coercion concern as Amnt.',
    'Inner `Amnt` and `Wdth` inside sdwM/hglM are also putUnitDouble `#Prc`, NOT putInteger. Inner `Rds ` IS putInteger (unlike the root `Rds ` which is putUnitDouble pixelsUnit).',
    "The blur-type enum value `GsnB` (Gaussian Blur) is a charID. Capture uses `cTID('GsnB')` as the enum value on the stringID `blur` / `blurType` keys.",
    'Pre-audit snippet emits `presetKindCustom` as a stand-alone putBoolean which does not appear in the capture. Likely harmless extra, but unverified.',
    'Sub-object keys `sdwM` (shadows mode) and `hglM` (highlights mode) are charID, NOT stringIDs `shadowMode`/`highlightMode`. PS may alias them via the well-known charID-stringID alias table, but for byte-identity prefer the charID form.',
  ],
  versionNotes: [
    "Audit report prescribes: change `adaptiveCorrectTones` → `adaptCorrectTones` at lines 2025+2032; change root amount/noiseReduction from putInteger to putUnitDouble percentUnit; change inner amount/width from putInteger to putUnitDouble percentUnit (keep inner radius putInteger). Add `.not.toContain('adaptiveCorrectTones')` regression guard.",
    'The same spelling typo was fixed in `applyShadowsHighlights` (which correctly used `adaptCorrectTones`); the Smart Sharpen snippet copied the WRONG spelling from a different source.',
  ],
  events: [
    {
      index: 1,
      event: stringID('smartSharpen'),
      comment:
        'Single-event filter dispatch. Root descriptor carries the sharpen amount, radius, noise reduction, blur type, plus two sub-object descriptors `sdwM` (shadows mode) and `hglM` (highlights mode) — each of class `adaptCorrectTones` (no "ive") holding the per-tonal-region fade/width/radius triple.',
      descriptor: {
        classID: charID('null'),
        fields: [
          {
            name: 'presetKind',
            typeID: stringID('presetKind'),
            kind: 'enum',
            required: true,
            enumType: stringID('presetKindType'),
            enumValues: [
              {
                typeID: stringID('presetKindCustom'),
                context: 'Always presetKindCustom when the user has touched any slider.',
              },
            ],
          },
          {
            name: 'useLegacy',
            typeID: stringID('useLegacy'),
            kind: 'boolean',
            required: true,
            booleanDefault: false,
            description:
              'False = modern Smart Sharpen algorithm. True = legacy CS6-era algorithm (not exposed in UI but accepted by the descriptor).',
          },
          {
            name: 'Amount (Amnt)',
            typeID: charID('Amnt'),
            kind: 'unitDouble',
            required: true,
            unit: { charID: '#Prc' },
            range: { min: 1, max: 500, default: 100 },
            description: 'Sharpen amount (1-500%). Capture: 107.0.',
            gotchas: [
              'putUnitDouble with `#Prc` (percentUnit), NOT putInteger. Pre-audit snippet had this wrong — likely silent type-fallback.',
              'Key is charID `Amnt`, NOT stringID `amount`. Functionally equivalent via PS alias table but the capture uses the charID form.',
            ],
          },
          {
            name: 'Radius (Rds )',
            typeID: charID('Rds '),
            kind: 'unitDouble',
            required: true,
            unit: { charID: '#Pxl' },
            range: { min: 0.1, max: 64, default: 1.0 },
            description: 'Sharpen radius in pixels. Capture: 1.7.',
            gotchas: [
              'Root Rds is putUnitDouble pixelsUnit. Note inner Rds inside sdwM/hglM is putInteger — different type for the same charID at different nesting levels.',
            ],
          },
          {
            name: 'noiseReduction',
            typeID: stringID('noiseReduction'),
            kind: 'unitDouble',
            required: true,
            unit: { charID: '#Prc' },
            range: { min: 0, max: 100, default: 10 },
            description: 'Noise reduction (0-100%). Capture: 26.0.',
            gotchas: [
              'putUnitDouble with `#Prc`, NOT putInteger. Pre-audit snippet emitted as integer.',
            ],
          },
          {
            name: 'blur (blur-removal type)',
            typeID: charID('blur'),
            kind: 'enum',
            required: true,
            enumType: stringID('blurType'),
            enumValues: [
              {
                typeID: charID('GsnB'),
                label: 'Gaussian Blur',
                context: 'Remove Gaussian Blur (default, captured).',
              },
            ],
            description:
              'The blur-removal model. Capture only confirms `GsnB` (Gaussian Blur); the dialog also exposes Lens Blur and Motion Blur but those enum values are unverified by this capture.',
            gotchas: [
              'The enum-value typeID `GsnB` is charID. The enum-type typeID `blurType` is stringID. Mixed charID/stringID in a single putEnumerated call is normal in PS descriptors.',
              'Lens Blur and Motion Blur enum values are NOT in this capture — likely `LnsB` / `MtnB` by naming pattern, but UNVERIFIED.',
            ],
          },
          {
            name: 'sdwM (shadows mode sub-object)',
            typeID: charID('sdwM'),
            kind: 'object',
            required: true,
            innerShape: adaptCorrectTonesShape,
            description:
              'Shadows-tab parameters: fade amount, tonal width, radius. Held as a sub-descriptor of class `adaptCorrectTones`.',
            gotchas: [
              'Sub-object class typeID MUST be stringID `adaptCorrectTones` (no "ive"). Pre-audit snippet emitted `adaptiveCorrectTones` — PS silently ignores it and the entire shadows-tab payload defaults to 0% fade.',
              'Outer key `sdwM` is charID, NOT stringID `shadowMode`.',
            ],
          },
          {
            name: 'hglM (highlights mode sub-object)',
            typeID: charID('hglM'),
            kind: 'object',
            required: true,
            innerShape: adaptCorrectTonesShape,
            description:
              'Highlights-tab parameters: fade amount, tonal width, radius. Same shape as sdwM.',
            gotchas: [
              'Sub-object class typeID MUST be stringID `adaptCorrectTones` (no "ive"). Same silent-no-op as sdwM.',
              'Outer key `hglM` is charID, NOT stringID `highlightMode`.',
            ],
          },
        ],
      },
    },
  ],
};
