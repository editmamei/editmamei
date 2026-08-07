/**
 * Content-Aware Move tool — `recomposeSelection` dispatch.
 *
 * Ground truth: PS 27.x Windows, captured 2026-06-08.
 *
 * The user selected the Content-Aware Move tool, configured Options bar
 * to Mode: Move, Structure 4, Color 5, Sample All Layers OFF, Transform
 * On Drop OFF, drew a selection (~100×100 px), then click-dragged
 * 219 px right and 384 px up. Release fires the single
 * `recomposeSelection` event.
 *
 * PS emits ONE event: `recomposeSelection` (stringID). Same shape as
 * Patch's `patchSelection` BUT with three extra keys:
 *   - `remixMode` enum: `remixMove` (move) vs `remixExtend` (extend)
 *   - `clone: boolean` (extend mode option)
 *   - `transformOnDrop: boolean` (let user transform the moved content)
 *
 * The `T   ` (target) key replaces Patch's `From` key — semantically
 * identical (offset destination), structurally renamed.
 */

import type { AmEventSpec } from '../../types.js';
import { charID, stringID } from '../../types.js';

export const contentAwareMoveSpec: AmEventSpec = {
  id: 'retouch/content-aware-move',
  displayName: 'Content-Aware Move',
  category: 'retouch',
  emittedBy: ['ps_retouch (method=content_aware_move)'],
  snippetRef: 'go-core/cmd/buildtemplates/fragments_retouch.go (vault.RtCAM)',
  groundTruth: {
    capturedAt: '2026-06-08',
    psVersion: '27.x',
    platform: 'Windows',
    sourceLog: 'STEP-04-content-aware-move.log',
    menuPath: 'Toolbar > Content-Aware Move tool (drag selection to destination)',
  },
  knownGotchas: [
    "Event ID is stringID `recomposeSelection`, distinct from Patch's `patchSelection`. Both share the descriptor skeleton (Chnl/fsel target, offset object, patch adaptation integers) but have different event IDs and different inner key names for the offset wrapper.",
    "Offset wrapper key is `T   ` (charID — 4 chars with three trailing spaces!), NOT Patch's `From`. Same `Ofst` inner shape, different outer key.",
    'The `remixMode` enum has TWO values worth handling: `remixMove` (default — move the content to new location, leave the source filled via content-aware) and `remixExtend` (extend by cloning — leaves source intact, duplicates to new location). This v1 hardcodes `remixMove`; `remixExtend` is a logical follow-up.',
    'The `clone` boolean is paired with `remixExtend` mode (it controls whether extend duplicates pixels or composes them). With remixMove the value is false; with remixExtend it depends on user config.',
    'The `transformOnDrop` boolean controls whether PS opens a free-transform after drop. For programmatic invocation, transformOnDrop should be false (no UI for the LLM to interact with).',
    'Capture shows reshuffle=true (CAM defaults to ON) vs Patch reshuffle=false (Patch defaults to OFF). Reshuffle = allow non-contiguous patches.',
  ],
  versionNotes: [
    "Captured 2026-06-08. New tool lands at 'dev' tier; promote after live verification.",
    'This v1 only supports `remixMove` mode. Extend mode (remixExtend + clone) is a future surface-broadening MINOR bump.',
  ],
  events: [
    {
      index: 1,
      event: stringID('recomposeSelection'),
      comment:
        'Single-event Content-Aware Move dispatch. Targets current selection; moves via T/Ofst delta with content-aware fill at the source position.',
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
            description: 'Standard "current selection" reference.',
          },
          {
            name: 'Target offset (T  ) — Ofst sub-object',
            typeID: charID('T   '),
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
                  description: 'Horizontal move delta in pixels.',
                },
                {
                  name: 'Vertical (Vrtc)',
                  typeID: charID('Vrtc'),
                  kind: 'unitDouble',
                  required: true,
                  unit: { charID: '#Pxl' },
                  description: 'Vertical move delta in pixels.',
                },
              ],
            },
            description:
              "Where to move the selection contents to. NOTE: outer key is charID `T   ` (THREE trailing spaces), not Patch's `From`.",
            gotchas: [
              'Key is charID("T   ") — that is 4 chars total: T + 3 spaces. Easy to miscount as charID("T  ") (2 spaces) which is a different typeID.',
            ],
          },
          {
            name: 'Transparent (Trns)',
            typeID: charID('Trns'),
            kind: 'boolean',
            required: true,
            booleanDefault: false,
            description: 'Capture: false.',
          },
          {
            name: 'Patch mode',
            typeID: stringID('patchMode'),
            kind: 'enum',
            required: true,
            enumType: stringID('patchModeType'),
            enumValues: [
              {
                typeID: stringID('patchContentAware'),
                label: 'Content-Aware',
                context: 'Implicit on CAM — always content-aware',
              },
            ],
            description:
              'Same enum as Patch. CAM is always content-aware (no other patchMode variant exposed).',
          },
          {
            name: 'Remix mode (remixMove vs remixExtend)',
            typeID: stringID('remixMode'),
            kind: 'enum',
            required: true,
            enumType: stringID('remixModeType'),
            enumValues: [
              {
                typeID: stringID('remixMove'),
                label: 'Move',
                context: 'Options bar > Mode: Move',
              },
              {
                typeID: stringID('remixExtend'),
                label: 'Extend',
                context: 'Options bar > Mode: Extend',
              },
            ],
            description:
              'Distinguishes Content-Aware Move (move content + fill source) from Content-Aware Extend (clone content). v1 supports remixMove only.',
          },
          {
            name: 'Reshuffle',
            typeID: stringID('reshuffle'),
            kind: 'boolean',
            required: true,
            booleanDefault: true,
            description: 'Capture: true (CAM defaults to allowing recomposition).',
          },
          {
            name: 'Clone',
            typeID: stringID('clone'),
            kind: 'boolean',
            required: true,
            booleanDefault: false,
            description: 'Pairs with remixExtend. With remixMove: false. Capture: false.',
          },
          {
            name: 'Sample all layers',
            typeID: stringID('sampleAllLayers'),
            kind: 'boolean',
            required: true,
            booleanDefault: false,
            description: 'Capture: false.',
          },
          {
            name: 'Transform on drop',
            typeID: stringID('transformOnDrop'),
            kind: 'boolean',
            required: true,
            booleanDefault: false,
            description:
              'Opens free-transform after drop. For programmatic invocation, always false. Capture: false.',
          },
          {
            name: 'Structure (patchStructureAdapt) — 1-7 slider',
            typeID: stringID('patchStructureAdapt'),
            kind: 'integer',
            required: true,
            range: { min: 1, max: 7, default: 4 },
            description:
              'Same key as Patch. CAM default differs from Patch (4 vs 5 per captures). Capture: 4.',
          },
          {
            name: 'Color (patchColorAdaptation) — 0-10 slider',
            typeID: stringID('patchColorAdaptation'),
            kind: 'integer',
            required: true,
            range: { min: 0, max: 10, default: 5 },
            description: 'Same key as Patch. Capture: 5.',
          },
          {
            name: 'Heal smooth factor',
            typeID: stringID('healSmoothFactor'),
            kind: 'integer',
            required: true,
            range: { min: 0, max: 10, default: 5 },
            description: 'Capture: 5.',
          },
          {
            name: 'Use source',
            typeID: stringID('useSource'),
            kind: 'boolean',
            required: true,
            booleanDefault: false,
            description: 'Patch defaults true, CAM defaults false. Capture: false.',
          },
        ],
      },
    },
  ],
};
