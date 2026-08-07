/**
 * Patch tool — Content-Aware patch dispatch.
 *
 * Ground truth: PS 27.x Windows, captured 2026-06-08.
 *
 * The user selected the Patch tool, configured Options bar to Patch:
 * Content-Aware, Structure 5, Color 5, drew a selection around a small
 * blemish, then click-dragged the selection ~90 px right and ~6 px up
 * to a clean region. Release fires the single `patchSelection` event.
 *
 * PS emits ONE event: `patchSelection` (stringID). The descriptor
 * targets the current selection via `null → Chnl/fsel` property
 * reference (selection channel). The `From` key carries the drag-offset
 * (Hrzn / Vrtc) as the destination delta. Content-Aware-specific keys
 * carry the structure/color/smooth adaptation integers.
 *
 * **Note on captured `patchColorAdaptation`**: user set Color to 5 in
 * the dialog per the capture instructions, but PS emitted 6. The
 * 0-10 slider value the UI shows is a 0-10 mapping, but the AM
 * descriptor sometimes off-by-ones (PS converts slider position to a
 * different internal scale before emitting). Use the captured integer
 * directly; do not assume slider value == AM value.
 */

import type { AmEventSpec } from '../../types.js';
import { charID, stringID } from '../../types.js';

export const patchSpec: AmEventSpec = {
  id: 'retouch/patch',
  displayName: 'Patch (Content-Aware)',
  category: 'retouch',
  emittedBy: ['ps_retouch (method=patch)'],
  snippetRef: 'go-core/cmd/buildtemplates/fragments_retouch.go (vault.RtPatch)',
  groundTruth: {
    capturedAt: '2026-06-08',
    psVersion: '27.x',
    platform: 'Windows',
    sourceLog: 'STEP-03-patch.log',
    menuPath: 'Toolbar > Patch tool (drag selection to destination)',
  },
  knownGotchas: [
    'Event ID is stringID `patchSelection`, NOT a charID. Forum lore sometimes claims `Ptch` charID — that does not exist as an emitted event on PS 27.x.',
    'Selection reference uses the canonical fsel pattern: `null → Chnl/fsel` property reference. This is the same pattern as selection ops elsewhere in src/spec/ps27/selection/.',
    'The `From` key wraps an `Ofst` (Offset) sub-object with Hrzn / Vrtc — that\'s the destination delta, NOT the source position. Patch moves pixels FROM the selection\'s current position TO selection_position + offset. Confusingly named: "From" means "patch this with content from this offset away."',
    'Capture shows `patchColorAdaptation: 6` even though user set Color to 5 in the dialog. The 0-10 slider value the UI shows maps non-linearly to the emitted integer. Snippet should expose the slider value 0-10 and emit verbatim — DO NOT remap, DO NOT assume linear.',
    'Sample-all-layers `sampleAllLayers` is a stringID; the tool option in PS UI matches verbatim.',
    'The `useSource` boolean controls whether the user-drawn selection becomes the source (true) or destination (false). For our LLM-driven invocation, useSource=true matches the natural "I made a selection around the blemish; patch it from clean nearby pixels" semantics.',
  ],
  versionNotes: [
    "Captured 2026-06-08. New tool lands at 'dev' tier; promote after live verification.",
    'Patch mode is fixed to `patchContentAware` in this v1 — PS UI exposes "Normal" and "Content-Aware" modes via the Options bar, but they emit different event names entirely (Normal patch may use a different event, not yet captured). Snippet should default to content-aware and add the alternative when captured.',
  ],
  events: [
    {
      index: 1,
      event: stringID('patchSelection'),
      comment:
        'Single-event patch dispatch. Targets current selection via Chnl/fsel; moves the patch by the From/Ofst delta.',
      descriptor: {
        classID: charID('null'),
        fields: [
          {
            name: 'Target (null) — current selection via Chnl/fsel reference',
            typeID: charID('null'),
            kind: 'reference',
            required: true,
            referenceShape: {
              classID: charID('Chnl'),
              variant: 'property',
              property: charID('fsel'),
            },
            description:
              'Standard "current selection" reference used by selection ops. PS reads the active selection at execute-time.',
          },
          {
            name: 'From (offset destination) — Ofst sub-object',
            typeID: charID('From'),
            kind: 'object',
            required: true,
            innerShape: {
              classID: charID('Ofst'),
              fields: [
                {
                  name: 'Horizontal (Hrzn)',
                  typeID: charID('Hrzn'),
                  kind: 'unitDouble',
                  required: true,
                  unit: { charID: '#Pxl' },
                  description: 'Horizontal drag delta in pixels (positive = right).',
                },
                {
                  name: 'Vertical (Vrtc)',
                  typeID: charID('Vrtc'),
                  kind: 'unitDouble',
                  required: true,
                  unit: { charID: '#Pxl' },
                  description: 'Vertical drag delta in pixels (positive = down).',
                },
              ],
            },
            description: 'Where to sample the patch from, relative to the current selection.',
          },
          {
            name: 'Transparent (Trns) — output transparency',
            typeID: charID('Trns'),
            kind: 'boolean',
            required: true,
            booleanDefault: false,
            description: 'When true, the patch result respects layer transparency. Capture: false.',
          },
          {
            name: 'Patch mode (patchMode) — fixed to patchContentAware in v1',
            typeID: stringID('patchMode'),
            kind: 'enum',
            required: true,
            enumType: stringID('patchModeType'),
            enumValues: [
              {
                typeID: stringID('patchContentAware'),
                label: 'Content-Aware',
                context: 'Options bar > Patch: Content-Aware',
              },
            ],
            description:
              'Selects the patch algorithm variant. Other modes (Normal, Source/Destination) emit different event shapes; v1 only handles Content-Aware.',
          },
          {
            name: 'Reshuffle',
            typeID: stringID('reshuffle'),
            kind: 'boolean',
            required: true,
            booleanDefault: false,
            description:
              'Allows PS to recompose the patch from non-contiguous source pixels. Capture: false.',
          },
          {
            name: 'Sample all layers',
            typeID: stringID('sampleAllLayers'),
            kind: 'boolean',
            required: true,
            booleanDefault: false,
            description: 'When true, samples from all visible layers. Capture: false.',
          },
          {
            name: 'Structure (patchStructureAdapt) — 1-7 slider',
            typeID: stringID('patchStructureAdapt'),
            kind: 'integer',
            required: true,
            range: { min: 1, max: 7, default: 5 },
            description:
              'PS UI: Options bar > Structure slider (1-7). Higher = preserve structure. Capture: 5.',
          },
          {
            name: 'Color (patchColorAdaptation) — 0-10 slider',
            typeID: stringID('patchColorAdaptation'),
            kind: 'integer',
            required: true,
            range: { min: 0, max: 10, default: 5 },
            description:
              'PS UI: Options bar > Color slider (0-10). Higher = blend color more aggressively. Capture: 6 (UI showed 5).',
            gotchas: [
              'UI slider value off-by-one in emitted integer — PS converts internally. Pass the UI value (0-10) verbatim and accept that the LLM sees what the user dialed.',
            ],
          },
          {
            name: 'Heal smooth factor',
            typeID: stringID('healSmoothFactor'),
            kind: 'integer',
            required: true,
            range: { min: 0, max: 10, default: 5 },
            description: 'Internal smoothing factor. Capture: 5.',
          },
          {
            name: 'Use source',
            typeID: stringID('useSource'),
            kind: 'boolean',
            required: true,
            booleanDefault: true,
            description:
              'When true, the user-drawn selection IS the source (the natural "patch this region" semantic). Capture: true.',
          },
        ],
      },
    },
  ],
};
