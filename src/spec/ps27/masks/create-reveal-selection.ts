/**
 * Create Layer Mask — Reveal Selection variant.
 *
 * Ground truth (canonical): PS 27.7.0 macOS, captured 2026-06-08.
 * Earlier reference capture: PS 27.7.0 Windows, captured 2026-06-03.
 *
 * The user opened a fresh PS doc, made a rectangular marquee selection
 * over part of a pixel layer, then chose Layer > Layer Mask > Reveal
 * Selection. PS uses the current selection's geometry to populate the
 * mask: selected pixels stay visible (white in mask), unselected pixels
 * are hidden (black).
 *
 * PS emits a SINGLE `make` event with the SAME descriptor shape as the
 * Reveal All variant — only the `using` enumerated value differs
 * (`revealSelection` instead of `revealAll`). See create-reveal-all.ts
 * for the canonical class-slot shape discussion and the v0.5.8 fix
 * rationale.
 *
 * **Snippet behavior.** Editmamei's `createLayerMask` snippet
 * automatically picks `revealSelection` when an active selection is
 * detected (probed via `executeActionGet(fsel)` — the PS 2024+
 * ActionReference pattern that avoids the uncatchable error 1302 from
 * `doc.selection.bounds`). Otherwise it falls back to `revealAll`. The
 * caller does not need to specify the mode explicitly — selection
 * presence is the discriminator.
 */

import type { AmEventSpec } from '../../types.js';
import { stringID } from '../../types.js';

export const createRevealSelectionMaskSpec: AmEventSpec = {
  id: 'masks/create-reveal-selection',
  displayName: 'Create Layer Mask — Reveal Selection',
  category: 'masks',
  emittedBy: ['ps_layer_mask (op=create)'],
  snippetRef:
    'go-core/cmd/buildtemplates/fragments_masks.go (vault.CreateMask — non-adjustment-layer branch)',
  groundTruth: {
    capturedAt: '2026-06-08',
    psVersion: '27.7.0',
    platform: 'macOS',
    sourceLog: 'user-pasted ScriptListener capture B (Layer > Layer Mask > Reveal Selection)',
    menuPath: 'Layer > Layer Mask > Reveal Selection',
  },
  knownGotchas: [
    'PRECONDITION: an active selection must exist when this event is emitted. The Editmamei snippet probes via `executeActionGet(fsel)` to detect selection presence, then chooses `revealSelection` vs `revealAll` automatically — the caller does not pass the mode. If no selection exists when `revealSelection` is sent directly, PS 27.x throws.',
    'Class slot MUST be `desc.putClass(sTID("new"), sTID("channel"))` — see create-reveal-all.ts for the full bug history. The legacy null/putReference(class) form is rejected on macOS PS 27.7.',
    'The selection geometry is NOT passed in this descriptor — PS reads the current selection state (the `fsel` channel) at event-dispatch time. This is why the snippet does NOT need to capture selection bounds before invoking.',
  ],
  versionNotes: [
    'Selection probing uses the ActionReference `fsel` pattern (not `doc.selection.bounds`) per docs/engineering/extendscript-contract.md "Known runtime quirk: selection state" — PS 2024+ throws an uncatchable error 1302 from `doc.selection.bounds` when no selection exists.',
    'v0.5.8 (2026-06-08): switched to stringID/`new`-putClass shape matching the macOS capture. See create-reveal-all.ts for the full fix narrative.',
  ],
  events: [
    {
      index: 1,
      event: stringID('make'),
      comment:
        'Creates a new mask channel populated from the current selection. White inside the selection, black outside. Descriptor is structurally identical to Reveal All except for the `using` enum value (`revealSelection` vs `revealAll`).',
      descriptor: {
        classID: stringID('null'),
        fields: [
          {
            name: 'New (the class of thing to create)',
            typeID: stringID('new'),
            kind: 'class',
            required: true,
            description:
              'Exact form: `desc.putClass(sTID("new"), sTID("channel"))`. Declares that the thing being created is a Channel. The only accepted class-slot form on macOS PS 27.7.',
          },
          {
            name: 'At (where to attach the new channel)',
            typeID: stringID('at'),
            kind: 'reference',
            required: true,
            referenceShape: {
              classID: stringID('channel'),
              variant: 'enumerated',
              enumKey: stringID('channel'),
              enumValue: stringID('mask'),
            },
            description:
              "Targets the layer's mask channel slot via enumerated reference `<channel, channel, mask>`. Wrap in an ActionReference; do NOT send as a bare putEnumerated on the outer descriptor.",
          },
          {
            name: 'Using (the kind of mask + fill)',
            typeID: stringID('using'),
            kind: 'enum',
            required: true,
            enumType: stringID('userMaskEnabled'),
            enumValues: [
              {
                typeID: stringID('revealSelection'),
                label: 'Reveal Selection',
                context:
                  'Mask geometry is initialized from the current selection — white inside selection, black outside.',
              },
            ],
            description:
              'For Reveal Selection this is `userMaskEnabled / revealSelection`. PS reads the live `fsel` channel at dispatch time to populate the mask; the descriptor does NOT carry selection bounds.',
          },
        ],
      },
    },
  ],
};
