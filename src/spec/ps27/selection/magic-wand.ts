/**
 * Magic Wand selection — click-to-select-contiguous-color.
 *
 * Ground truth: PS 27.7.0 Windows, captured 2026-06-03.
 * Capture log: JS-39-Magic-Wand.log
 *
 * The user opened a fresh PS doc, selected the Magic Wand tool, and
 * clicked several points on the canvas. PS emits a TWO-PHASE sequence
 * per canvas click:
 *   - Phase 1 (one-time tool selection): `slct` event with
 *     `null=ref<class=magicWandTool>` — picks up the Magic Wand tool.
 *   - Phase 2 (per click): `setd Chnl/fsel` with a `Pnt ` object
 *     carrying `Hrzn`/`Vrtc` pixel coordinates plus `Tlrn` (tolerance)
 *     integer and `AntA` (anti-alias) boolean.
 *
 * **Editmamei snippet correctly skips Phase 1.** The snippet
 * (go-core/cmd/buildtemplates/fragments_selections_advanced.go, vault.MagicWand) sends the `setd Chnl/fsel + Pnt + Tlrn +
 * AntA` event directly via executeAction, bypassing the tool-state
 * dependency. The UI\'s two-phase flow is an artifact of canvas-click
 * UX (the user must "be holding the Magic Wand tool" when they click),
 * not a requirement of the underlying AM event. The snippet\'s direct
 * AM-only path is the correct LLM-driven approach — `Document.magic
 * WandSelect()` does NOT exist in the PS DOM, so the AM seam is the
 * only available implementation.
 *
 * **Extras: snippet adds Cntg / Mrgd, capture doesn\'t.** The snippet
 * emits `Cntg` (Contiguous) and `Mrgd` (Sample all layers) booleans
 * inside the `setd` descriptor. The capture omits these because the
 * UI picks them up from the tool\'s persistent state (a session-scoped
 * tool-options panel). Modern PS accepts both keys directly in the
 * `setd` payload — they\'re tolerated as per-call overrides. This is
 * BETTER than the capture for an LLM-driven API: the caller can
 * specify Contiguous and Sample-All-Layers per-call without the
 * persistent-tool-state coupling.
 *
 * Group D audit verdict (2026-06-04): **OK**. Snippet exactly matches
 * the captured `setd Chnl/fsel + Pnt + Tlrn + AntA` shape. The
 * Cntg/Mrgd extras are PS-tolerated per-call overrides. The
 * tool-selection Phase 1 skip is intentional and correct.
 */

import type { AmEventSpec } from '../../types.js';
import { charID } from '../../types.js';

export const magicWandSpec: AmEventSpec = {
  id: 'selection/magic-wand',
  displayName: 'Magic Wand selection',
  category: 'selection',
  emittedBy: ['ps_select'],
  snippetRef: 'go-core/cmd/buildtemplates/fragments_selections_advanced.go (vault.MagicWand)',
  groundTruth: {
    capturedAt: '2026-06-03',
    psVersion: '27.7.0',
    platform: 'Windows',
    sourceLog: 'JS-39-Magic-Wand.log',
    menuPath: 'Magic Wand tool (W) + canvas click',
  },
  knownGotchas: [
    "PS DOM does NOT expose a `Document.magicWandSelect()` method. The only available implementation is the raw AM event documented here — the snippet's direct-AM approach is the correct path, NOT a fallback.",
    "The capture's Phase 1 (slct magicWandTool) is a canvas-click UX artifact, NOT a precondition for the underlying `setd Chnl/fsel` event. The snippet correctly skips Phase 1 — sending the `setd` directly bypasses the tool-state dependency and is the right LLM-driven approach.",
    "The snippet adds `Cntg` (Contiguous) and `Mrgd` (Sample all layers) booleans to the `setd` descriptor. The UI capture omits these because the Magic Wand tool reads them from its persistent options panel state — but PS accepts the per-call form in the `setd` payload as well. The snippet's per-call form is BETTER for an LLM-driven API (no persistent-tool-state coupling).",
    "The reference target is `Chnl property fsel` — the selection channel as a property reference, NOT an enumerated reference. Don't confuse `ref.putProperty(idChnl, idfsel)` with `ref.putEnumerated(idChnl, idOrdn, ...)` — different putters, different shapes.",
    'Coordinates are `#Pxl` (pixels), not percentages or document-relative. If the caller passes percentages, the snippet must convert before emission.',
  ],
  versionNotes: [
    'The `setd Chnl/fsel + Pnt + Tlrn + AntA` shape has been stable since at least PS CS6. No version drift expected.',
    'The inline comment in go-core/cmd/buildtemplates/fragments_selections_advanced.go (vault.MagicWand) documents the "Document.magicWandSelect() does NOT exist in the DOM" rationale for the direct-AM approach.',
  ],
  events: [
    {
      index: 1,
      event: charID('setd'),
      comment:
        'Apply the Magic Wand selection algorithm at a specific canvas point. Captured per canvas click in the multi-click session — each click emits a fresh `setd` with new `Pnt` coordinates and current tolerance/anti-alias state.',
      descriptor: {
        classID: charID('null'),
        fields: [
          {
            name: 'target (the selection channel as a property reference)',
            typeID: charID('null'),
            kind: 'reference',
            required: true,
            referenceShape: {
              classID: charID('Chnl'),
              variant: 'property',
              property: charID('fsel'),
            },
            description:
              'Targets the document\'s current-selection channel. Built via `ref.putProperty(cTID("Chnl"), cTID("fsel"))` — property reference, NOT enumerated.',
          },
          {
            name: 'T (the click point — Pnt object with Hrzn/Vrtc in pixels)',
            typeID: charID('T   '),
            kind: 'object',
            required: true,
            innerShape: {
              classID: charID('Pnt '),
              fields: [
                {
                  name: 'Horizontal (x) in pixels',
                  typeID: charID('Hrzn'),
                  kind: 'unitDouble',
                  required: true,
                  unit: { charID: '#Pxl' },
                  description: 'X coordinate of the click point in canvas pixel units.',
                },
                {
                  name: 'Vertical (y) in pixels',
                  typeID: charID('Vrtc'),
                  kind: 'unitDouble',
                  required: true,
                  unit: { charID: '#Pxl' },
                  description: 'Y coordinate of the click point in canvas pixel units.',
                },
              ],
            },
            description:
              'The canvas point being "clicked" by the algorithm. PS reads the pixel at this point and finds contiguous (or all, when Cntg=false) pixels within `Tlrn` of that color.',
          },
          {
            name: 'Tolerance',
            typeID: charID('Tlrn'),
            kind: 'integer',
            required: true,
            range: { min: 0, max: 255, default: 32 },
            description:
              'Color tolerance for the match. 0 = exact pixel-value match; 255 = match everything. The capture shows tolerances 34 and 37 across clicks — typical user range.',
          },
          {
            name: 'Anti-alias',
            typeID: charID('AntA'),
            kind: 'boolean',
            required: true,
            booleanDefault: true,
            description:
              'Whether selection edges are anti-aliased. PS UI default is true. The capture shows AntA=true for every click.',
          },
          {
            name: 'Contiguous (snippet extra — not in capture)',
            typeID: charID('Cntg'),
            kind: 'boolean',
            required: false,
            booleanDefault: true,
            description:
              'When true (default), only contiguous pixels matching the target color are selected. When false, all matching pixels in the layer/document are selected regardless of contiguity. The snippet emits this key directly; the capture omits it (read from tool-options panel state by the UI).',
          },
          {
            name: 'Sample all layers / Merged (snippet extra — not in capture)',
            typeID: charID('Mrgd'),
            kind: 'boolean',
            required: false,
            booleanDefault: false,
            description:
              'When true, the color-match samples the merged composite of all visible layers; when false (default), it samples only the active layer. The snippet emits this key directly; the capture omits it (read from tool-options panel state by the UI).',
          },
        ],
      },
    },
  ],
};
