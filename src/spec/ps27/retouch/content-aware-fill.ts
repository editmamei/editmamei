/**
 * Content-Aware Fill (Edit > Fill > Content-Aware).
 *
 * Ground truth: PS 27.x Windows, captured 2026-06-08.
 *
 * The user made a rectangular marquee selection (~150×150 px) on a
 * real-photo "Photo" layer, then opened Edit > Fill, set Contents:
 * Content-Aware, Color Adaptation ON, Opacity 100%, Mode Normal, and
 * clicked OK.
 *
 * PS emits ONE event: `Fl  ` (charID for Fill). The descriptor carries
 * five Content-Aware-specific booleans (color adaptation, rotate, scale,
 * mirror, plus the implicit "use this content-aware variant" enum), plus
 * the standard Opct/Mode pair from generic fill.
 *
 * **Selection-driven**: the descriptor targets the current document
 * selection via the global selection state — there is NO explicit
 * selection reference inside the descriptor. PS reads the active
 * selection at execute-time. Snippet must check selection is active
 * before invoking; otherwise PS fills the entire layer (destructive
 * silent surprise).
 */

import type { AmEventSpec } from '../../types.js';
import { charID, stringID } from '../../types.js';

export const contentAwareFillSpec: AmEventSpec = {
  id: 'retouch/content-aware-fill',
  displayName: 'Content-Aware Fill',
  category: 'retouch',
  emittedBy: ['ps_retouch (method=content_aware_fill)'],
  snippetRef: 'go-core/cmd/buildtemplates/fragments_retouch.go (vault.RtCAF)',
  groundTruth: {
    capturedAt: '2026-06-08',
    psVersion: '27.x',
    platform: 'Windows',
    sourceLog: 'STEP-02-content-aware-fill.log',
    menuPath: 'Edit > Fill > Content-Aware',
  },
  knownGotchas: [
    'Event ID is charID `Fl  ` (4 chars, trailing TWO spaces) — the standard Fill event. Content-Aware is selected via the `Usng` (Using) enum value `contentAware`. Easy to write as charID `"Fl"` (no spaces) and silently emit a different event.',
    "No explicit selection reference in the descriptor. PS reads the document's active selection state at execute-time. Snippet MUST verify a selection is active before invoking — otherwise PS fills the entire layer, which is silent-destructive.",
    'The four Content-Aware booleans (color adaptation, rotate, scale, mirror) are stringIDs, not charIDs. `contentAwareColorAdaptationFill`, `contentAwareRotateFill`, `contentAwareScaleFill`, `contentAwareMirrorFill`.',
    'Capture shows opacity unit `#Prc` (percent) and value 100 — even though the dialog accepts 1-100 integer, PS emits as putUnitDouble percent. The dialog rejects 0 with "An integer between 1 and 100 is required."',
    'Blend mode key is `Md  ` (4 chars, trailing TWO spaces — charID) with value enum class `BlnM` and value `Nrml` (Normal). Standard PS blend mode pattern.',
  ],
  versionNotes: [
    'Older planning notes claimed a dedicated AM `cafTM` event. PS 27.x emits standard `Fl  ` with `Usng` enum, NOT a dedicated `cafTM` event. That claim was forum lore; this capture corrects it.',
    "Captured 2026-06-08. New tool lands at 'dev' tier; promote to community/pro after live verification via MCP invocation.",
  ],
  events: [
    {
      index: 1,
      event: charID('Fl  '),
      comment:
        'Single-event Fill dispatch with Content-Aware mode selected via the Usng enum. Reads document selection at execute-time.',
      descriptor: {
        classID: charID('null'),
        fields: [
          {
            name: 'Using (Usng) → contentAware fill content kind',
            typeID: charID('Usng'),
            kind: 'enum',
            required: true,
            enumType: charID('FlCn'),
            enumValues: [
              {
                typeID: stringID('contentAware'),
                label: 'Content-Aware',
                context: 'Edit > Fill > Contents: Content-Aware',
              },
            ],
            description:
              'Selects which fill variant PS runs. `contentAware` is what makes this distinct from solid-color / pattern / history fills.',
            gotchas: [
              'Enum class is charID `FlCn` (FillContent), value is stringID `contentAware`. Mixed charID/stringID in the same enum is normal in PS.',
            ],
          },
          {
            name: 'Color adaptation (contentAwareColorAdaptationFill)',
            typeID: stringID('contentAwareColorAdaptationFill'),
            kind: 'boolean',
            required: true,
            booleanDefault: true,
            description:
              'When ON, PS adjusts the synthesized fill to match the surrounding region\'s color. UI checkbox "Color Adaptation". Capture: true.',
          },
          {
            name: 'Allow rotation (contentAwareRotateFill)',
            typeID: stringID('contentAwareRotateFill'),
            kind: 'boolean',
            required: true,
            booleanDefault: false,
            description:
              'When ON, PS can rotate sample patches to fit. UI: "Rotation Adaptation". Capture: false (UI default).',
          },
          {
            name: 'Allow scaling (contentAwareScaleFill)',
            typeID: stringID('contentAwareScaleFill'),
            kind: 'boolean',
            required: true,
            booleanDefault: false,
            description:
              'When ON, PS can rescale sample patches to fit. UI: "Scale". Capture: false.',
          },
          {
            name: 'Allow mirroring (contentAwareMirrorFill)',
            typeID: stringID('contentAwareMirrorFill'),
            kind: 'boolean',
            required: true,
            booleanDefault: false,
            description:
              'When ON, PS can mirror sample patches to fit. UI: "Mirror". Capture: false.',
          },
          {
            name: 'Opacity (Opct)',
            typeID: charID('Opct'),
            kind: 'unitDouble',
            required: true,
            unit: { charID: '#Prc' },
            range: { min: 1, max: 100, default: 100 },
            description:
              'Fill opacity 1-100%. UI rejects 0 with "An integer between 1 and 100 is required."',
          },
          {
            name: 'Blend mode (Md  )',
            typeID: charID('Md  '),
            kind: 'enum',
            required: true,
            enumType: charID('BlnM'),
            enumValues: [
              {
                typeID: charID('Nrml'),
                label: 'Normal',
                context: 'Edit > Fill > Mode: Normal',
              },
            ],
            description:
              'Standard PS blend mode enum. Snippet should expose a parameter for other blend modes (Multiply, Screen, etc.) and translate to the appropriate charID.',
          },
        ],
      },
    },
  ],
};
