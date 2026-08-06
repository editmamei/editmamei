/**
 * Shadows / Highlights filter (Image > Adjustments > Shadows/Highlights).
 *
 * Ground truth: PS 27.7.0 Windows, captured 2026-06-03.
 * Capture log: JS-26-Shadow-Hi.log
 *
 * The user opened Image > Adjustments > Shadows/Highlights (Show More
 * Options enabled), and configured: Shadows Amount 51% / Tonal Width
 * 35% / Radius 155; Highlights Amount 29% / Tonal Width 34% / Radius
 * 218; Color Correction -12; Midtone Contrast -25; Black Clip 18.836%;
 * White Clip 16.781%.
 *
 * (Capture values differ slightly from the user-provided script-
 * listener instructions — the user evidently moved sliders past the
 * spec\'d settings. The STRUCTURAL keys, types, and unit classes are
 * what matter for this audit; values are not load-bearing.)
 *
 * PS emits ONE event: `adaptCorrect` (stringID). The pre-audit
 * Editmamei snippet gets the event ID and the sub-object structure
 * right — including the all-important `adaptCorrectTones` (no "ive")
 * class name. This is VERIFIED by this Windows capture.
 *
 * **MED severity gotcha (the silent parameter-loss bug):** the
 * pre-audit snippet hardcodes both `BlcC` (Black Clip) and `WhtC`
 * (White Clip) to 0.01 — and the tool\'s TypeScript signature accepts
 * no parameter for either. The PS dialog exposes Black Clip and White
 * Clip as user-settable percentages (capture shows 18.836 / 16.781),
 * and the user instructions for the capture even called for 0.05 each.
 * The descriptor structure is right; two real PS parameters are
 * silently inaccessible to the LLM caller. Not a no-op (the filter
 * does apply shadowAmount/highlightAmount/colorCorrection/midtone-
 * Contrast), but the surface is narrower than PS exposes.
 *
 * NOTE: This spec lives in the filters/ subdirectory because the tool
 * surface is `ps_apply_adjustment` (type=shadows_highlights) and the AM event is
 * a single one-shot filter dispatch (not a Mk+setd adjustment-layer
 * sequence). The dialog lives under Image > Adjustments in the PS
 * menu, but the technical category — single bake event with no layer
 * creation — matches the filter family.
 */

import type { AmEventSpec } from '../../types.js';
import { charID, stringID } from '../../types.js';

const adaptCorrectTonesShape = {
  classID: stringID('adaptCorrectTones'),
  fields: [
    {
      name: 'Amount (Amnt)',
      typeID: charID('Amnt'),
      kind: 'unitDouble' as const,
      required: true,
      unit: { charID: '#Prc' as const },
      range: { min: 0, max: 100, default: 50 },
      description: 'Amount for this tonal region (0-100%).',
    },
    {
      name: 'Tonal width (Wdth)',
      typeID: charID('Wdth'),
      kind: 'unitDouble' as const,
      required: true,
      unit: { charID: '#Prc' as const },
      range: { min: 0, max: 100, default: 50 },
      description: 'Tonal width for this tonal region (0-100%).',
    },
    {
      name: 'Radius (Rds )',
      typeID: charID('Rds '),
      kind: 'integer' as const,
      required: true,
      range: { min: 0, max: 2500, default: 30 },
      description:
        'Radius for this tonal region (in pixels). Inner Rds IS putInteger (no unit type).',
    },
  ],
};

export const shadowsHighlightsSpec: AmEventSpec = {
  id: 'filters/shadows-highlights',
  displayName: 'Shadows / Highlights filter',
  category: 'filters',
  emittedBy: ['ps_apply_adjustment (type=shadows_highlights)'],
  snippetRef:
    'go-core/cmd/buildtemplates/fragments_adjustments.go (vault.ShadowsHL — structure verified, black/white clip params not exposed)',
  groundTruth: {
    capturedAt: '2026-06-03',
    psVersion: '27.7.0',
    platform: 'Windows',
    sourceLog: 'JS-26-Shadow-Hi.log',
    menuPath: 'Image > Adjustments > Shadows/Highlights',
  },
  knownGotchas: [
    'Sub-object class typeID for sdwM/hglM is `adaptCorrectTones` (NO "ive"), NOT `adaptiveCorrectTones`. This snippet gets it right — keep it that way. The Smart Sharpen snippet copied the WRONG spelling (`adaptiveCorrectTones`) from a different source and silently drops its shadows/highlights tabs as a result; do not let that drift back into this snippet.',
    'Pre-audit snippet hardcodes `BlcC` and `WhtC` to 0.01. The tool surface accepts no parameter for either. PS exposes both as user-settable percentages (capture: 18.836 / 16.781) — silent parameter loss for the LLM caller. Audit prescribes adding `blackClip` and `whiteClip` parameters with default 0.01 to preserve current behavior.',
    'Outer keys `sdwM` (shadows mode) and `hglM` (highlights mode) are charIDs. The sub-object class `adaptCorrectTones` is stringID. Mixed charID/stringID in a single putObject call is normal in PS descriptors.',
    'Inner `Amnt` and `Wdth` inside sdwM/hglM are putUnitDouble with `#Prc` (percentUnit). Inner `Rds ` is putInteger (no unit type). This is DIFFERENT from Smart Sharpen where root Rds is putUnitDouble pixelsUnit — same charID, different types at different nesting levels.',
    'Root `BlcC` and `WhtC` are putDouble (NO unit type). Pre-audit snippet correctly uses putDouble. Capture: 18.836 / 16.781.',
    'Root `Cntr` (Midtone Contrast) and `ClrC` (Color Correction) are putInteger. Capture: -25 / -12 (both signed).',
  ],
  versionNotes: [
    'The 2026-06-02 fix rewrote this snippet against macOS ScriptListener ground truth after the previous version was discovered to use a fictitious `shadowHighlight` event ID with fully-wrong descriptor structure. The Windows capture (2026-06-03) now CONFIRMS the rewrite cross-platform.',
    'Audit report verdict: MED. Structure is correct; recommended fix: add `blackClip: number = 0.01` and `whiteClip: number = 0.01` parameters to the function signature + tool inputSchema (with defaults preserving current behavior) so the LLM caller can set them. Surface-broadening change → MINOR version bump under the dist-diff test.',
  ],
  events: [
    {
      index: 1,
      event: stringID('adaptCorrect'),
      comment:
        'Single-event filter dispatch. Root descriptor carries two sub-object descriptors (sdwM for shadows, hglM for highlights — each of class adaptCorrectTones with Amount + Width + Radius) plus four root-level scalars: Black Clip, White Clip, Midtone Contrast, Color Correction.',
      descriptor: {
        classID: charID('null'),
        fields: [
          {
            name: 'sdwM (shadows mode sub-object)',
            typeID: charID('sdwM'),
            kind: 'object',
            required: true,
            innerShape: adaptCorrectTonesShape,
            description:
              'Shadows-tab parameters: Amount, Tonal Width, Radius. Held as a sub-descriptor of class `adaptCorrectTones`.',
            gotchas: [
              'Sub-object class typeID MUST be stringID `adaptCorrectTones` (no "ive"). Smart Sharpen snippet has the misspelling — keep this one correct.',
            ],
          },
          {
            name: 'hglM (highlights mode sub-object)',
            typeID: charID('hglM'),
            kind: 'object',
            required: true,
            innerShape: adaptCorrectTonesShape,
            description:
              'Highlights-tab parameters: Amount, Tonal Width, Radius. Same shape as sdwM.',
            gotchas: ['Sub-object class typeID MUST be stringID `adaptCorrectTones` (no "ive").'],
          },
          {
            name: 'Black clip (BlcC)',
            typeID: charID('BlcC'),
            kind: 'double',
            required: true,
            range: { min: 0, max: 50, default: 0.01 },
            description:
              'Black clip percentage (PS dialog: "Black Clip"). putDouble with NO unit type — bare double. Capture: 18.836.',
            gotchas: [
              'Pre-audit snippet hardcodes 0.01 with no caller parameter. PS exposes this as a user-settable percentage in the dialog. Audit recommends adding `black_clip` to the tool inputSchema.',
              'putDouble (no unit), NOT putUnitDouble.',
            ],
          },
          {
            name: 'White clip (WhtC)',
            typeID: charID('WhtC'),
            kind: 'double',
            required: true,
            range: { min: 0, max: 50, default: 0.01 },
            description:
              'White clip percentage (PS dialog: "White Clip"). putDouble with NO unit type. Capture: 16.781.',
            gotchas: [
              'Pre-audit snippet hardcodes 0.01 with no caller parameter. Audit recommends adding `white_clip` to the tool inputSchema.',
              'putDouble (no unit), NOT putUnitDouble.',
            ],
          },
          {
            name: 'Midtone contrast (Cntr)',
            typeID: charID('Cntr'),
            kind: 'integer',
            required: true,
            range: { min: -100, max: 100, default: 0 },
            description: 'Midtone Contrast (-100 to +100). Capture: -25.',
          },
          {
            name: 'Color correction (ClrC)',
            typeID: charID('ClrC'),
            kind: 'integer',
            required: true,
            range: { min: -100, max: 100, default: 20 },
            description: 'Color Correction (-100 to +100). Capture: -12.',
          },
        ],
      },
    },
  ],
};
