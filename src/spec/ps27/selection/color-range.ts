/**
 * Color Range selection (Select > Color Range).
 *
 * Ground truth: PS 27.7.0 Windows, captured 2026-06-03.
 * Capture log: JS-38-Color-Range.log
 *
 * The user opened a fresh PS doc, chose Select > Color Range, clicked
 * a target color in the canvas with the eyedropper, and accepted the
 * dialog with Fuzziness 79. PS emits a SINGLE `ClrR` (charID) event
 * with a Lab-color target (`LbCl` class, `Lmnc`/`A`/`B` keys) plus
 * a `colorModel` integer selecting which color-matching algorithm to
 * use.
 *
 * **HIGH severity drift: snippet sends RGBC, capture shows LbCl
 * (possible silent no-op).** The Editmamei snippet
 * (go-core/cmd/buildtemplates/fragments_selections_advanced.go, vault.ColorRange) builds `Mnm `/`Mxm ` as `RGBC` (RGB Color)
 * objects with `Rd  `/`Grn `/`Bl  ` doubles. The ground-truth capture
 * shows `LbCl` (Lab Color) objects with `Lmnc`/`A   `/`B   ` doubles,
 * plus a top-level `colorModel` integer (0 in the capture — likely
 * "sampled colors Lab" mode).
 *
 * The `RGBC` form is documented in older Adobe scripting references
 * (CS6-era). Whether modern PS still silently coerces RGBC → LbCl
 * internally is the open verification question. If it does NOT, the
 * snippet either selects nothing or selects something wildly wrong
 * (the classic silent-no-op failure mode the audit was created to
 * catch — see CLAUDE.md "Forum-lore event IDs / descriptors are
 * unverified" and the Lens Blur / Shadows-Highlights / Reduce-Noise
 * pattern). The absence of `colorModel` may also push PS into a
 * non-default color-matching algorithm even if `RGBC` is accepted.
 *
 * **Fix prescribed by audit:**
 *   1. Live-verify the current snippet against real PS 27.x with a
 *      known target color on a known image.
 *   2. If verification fails (or selection is empty / wildly wrong),
 *      rewrite to convert input RGB to Lab in JS (PS exposes no DOM
 *      helper — use the standard RGB→XYZ→Lab matrices) and emit
 *      `LbCl` objects + `colorModel` integer.
 *   3. Add `.not.toContain("RGBC")` regression guard once the
 *      rewrite lands.
 *   4. Mark the tool as `'dev'` tier in `src/core/tool-tiers.ts`
 *      until verification is complete (per the dev-default policy).
 *
 * Group D audit verdict (2026-06-04): **HIGH**. Possible silent no-op.
 * Single biggest fix-now item in the group.
 *
 * **Localized Color Clusters extension (not in current snippet).** The
 * second capture in the log file (lines 252-313) shows the multi-
 * cluster variant emitting additional keys: `dimension`,
 * `posGaussClusters`, `posGaussTolerance`, `posSpaGaussTolerance`,
 * `posGaussParams`, `negGaussClusters`, `negGaussTolerance`,
 * `negSpaGaussTolerance`, `negGaussParams`. Not required for basic
 * Color Range; documented here as an extension surface for future
 * Pro-tier work.
 */

import type { AmEventSpec } from '../../types.js';
import { charID, stringID } from '../../types.js';

export const colorRangeSpec: AmEventSpec = {
  id: 'selection/color-range',
  displayName: 'Color Range selection',
  category: 'selection',
  emittedBy: ['ps_select (mode=color_range)'],
  snippetRef: 'go-core/cmd/buildtemplates/fragments_selections_advanced.go (vault.ColorRange)',
  groundTruth: {
    capturedAt: '2026-06-03',
    psVersion: '27.7.0',
    platform: 'Windows',
    sourceLog: 'JS-38-Color-Range.log',
    menuPath: 'Select > Color Range',
  },
  knownGotchas: [
    'HIGH SEVERITY: descriptor shape mismatch. The Editmamei snippet emits `Mnm `/`Mxm ` as `RGBC` (RGB Color) objects with `Rd  `/`Grn `/`Bl  ` doubles. The captured PS UI shape is `LbCl` (Lab Color) with `Lmnc`/`A   `/`B   ` doubles, PLUS a top-level `colorModel` integer (0 in capture). Whether the snippet silently no-ops on PS 27.x is the open live-verification question — descriptor-string unit tests cannot detect this kind of semantic drift.',
    'Missing from snippet: top-level `colorModel` integer (stringID). Capture shows `colorModel=0` for sampled-colors-Lab mode; `colorModel=1` appears in the second invocation (likely "skin tones" or another preset). Without this key PS may fall back to a less-precise color-matching default.',
    'When the audit fix lands, RGB inputs to the Editmamei tool must be CONVERTED to Lab before emission. PS exposes no DOM helper for this — implement RGB→XYZ→Lab via the standard matrices in JS.',
    "NO LIVE-VERIFICATION RECORD exists for this snippet. Per the tool-tier-process doc, the tool should be marked `'dev'` tier until verification closes the gap. Recommend immediate tier flip pending the rewrite.",
    'The audit was specifically designed to catch this descriptor-shape divergence. Same failure pattern as Shadows/Highlights, Reduce Noise, and the Lens Blur silent-no-op chain — descriptor-string tests pass on fictional shapes; real PS rejects or silently no-ops.',
  ],
  versionNotes: [
    'Older Adobe scripting references (CS6-era forum posts) document the `RGBC` form for Color Range. Whether modern PS internally accepts and converts RGBC → Lab, or rejects it silently, is unknown without live verification.',
    'The Localized Color Clusters extension (multi-cluster variant) adds eight additional descriptor keys not modeled in this spec. See the second invocation in the capture log (lines 252-313) for the full extension shape if Pro-tier multi-cluster Color Range becomes a target.',
    'Recommended migration once verified: emit `LbCl` objects + `colorModel=0`, add `.not.toContain(charIDToTypeID(\'RGBC\'))` regression guard, lock in the rewritten descriptor with body assertions on `Lmnc`/`A   `/`B   ` and `sTID("colorModel")`.',
  ],
  events: [
    {
      index: 1,
      event: charID('ClrR'),
      comment:
        'Single-event selection dispatch. The captured form uses `LbCl` (Lab Color) for the `Mnm `/`Mxm ` target color objects and includes a `colorModel` integer for algorithm selection. The current Editmamei snippet emits `RGBC` (RGB Color) instead and omits `colorModel` — possible silent no-op, see knownGotchas.',
      descriptor: {
        classID: charID('null'),
        fields: [
          {
            name: 'Fuzziness',
            typeID: charID('Fzns'),
            kind: 'integer',
            required: true,
            range: { min: 0, max: 200, default: 40 },
            description:
              'How tolerant the color match is. 0 = exact pixel-value match only; 200 = very loose match. UI slider clamps to 0-200.',
          },
          {
            name: 'Minimum target color (Mnm) — captured Lab form',
            typeID: charID('Mnm '),
            kind: 'object',
            required: true,
            innerShape: {
              classID: charID('LbCl'),
              fields: [
                {
                  name: 'Luminance (L)',
                  typeID: charID('Lmnc'),
                  kind: 'double',
                  required: true,
                  range: { min: 0, max: 100 },
                  description: 'Lab L* component. 0 = black, 100 = white.',
                },
                {
                  name: 'a* (green-red axis)',
                  typeID: charID('A   '),
                  kind: 'double',
                  required: true,
                  range: { min: -128, max: 127 },
                  description: 'Lab a* component. Negative = greener, positive = redder.',
                },
                {
                  name: 'b* (blue-yellow axis)',
                  typeID: charID('B   '),
                  kind: 'double',
                  required: true,
                  range: { min: -128, max: 127 },
                  description: 'Lab b* component. Negative = bluer, positive = yellower.',
                },
              ],
            },
            description:
              'CAPTURED FORM: Lab Color object. The current Editmamei snippet emits this slot as `RGBC` with `Rd  `/`Grn `/`Bl  ` doubles instead — possible silent no-op per knownGotchas. For basic single-color Color Range, Mnm and Mxm are typically set to the same target color (which is what the capture shows).',
            gotchas: [
              'The snippet emits this as RGBC, not LbCl. If PS does not auto-convert RGBC → LbCl, the selection may be empty or wildly wrong.',
            ],
          },
          {
            name: 'Maximum target color (Mxm) — captured Lab form',
            typeID: charID('Mxm '),
            kind: 'object',
            required: true,
            innerShape: {
              classID: charID('LbCl'),
              fields: [
                {
                  name: 'Luminance (L)',
                  typeID: charID('Lmnc'),
                  kind: 'double',
                  required: true,
                  range: { min: 0, max: 100 },
                },
                {
                  name: 'a* (green-red axis)',
                  typeID: charID('A   '),
                  kind: 'double',
                  required: true,
                  range: { min: -128, max: 127 },
                },
                {
                  name: 'b* (blue-yellow axis)',
                  typeID: charID('B   '),
                  kind: 'double',
                  required: true,
                  range: { min: -128, max: 127 },
                },
              ],
            },
            description:
              'Upper bound of the color-match range. In the basic capture this equals `Mnm ` exactly (single-color target). The multi-cluster Localized Color Clusters extension allows distinct Mnm/Mxm for range-based matching.',
          },
          {
            name: 'colorModel (algorithm selector)',
            typeID: stringID('colorModel'),
            kind: 'integer',
            required: true,
            description:
              'Selects the color-matching algorithm. Capture shows `0` for "sampled colors Lab" (the default). A second-capture invocation with a preset shows `1` (likely "skin tones" or another preset). The Editmamei snippet OMITS this key entirely — may push PS into a non-default fallback even if the Mnm/Mxm objects are accepted.',
            gotchas: [
              'Snippet omits this key. Possible silent no-op or fallback to a less-precise matching mode.',
            ],
          },
        ],
      },
    },
  ],
};
