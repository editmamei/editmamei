/**
 * Create Layer Mask — Reveal All variant.
 *
 * Ground truth (canonical): PS 27.7.0 macOS, captured 2026-06-08.
 * Earlier reference capture: PS 27.7.0 Windows, captured 2026-06-03.
 *
 * The user opened a fresh PS doc, selected a pixel layer, and chose
 * Layer > Layer Mask > Reveal All (or clicked the "Add layer mask" icon
 * in the Layers panel with NO active selection).
 *
 * PS emits a SINGLE `make` event creating a new channel positioned at the
 * layer's mask slot, with `using` → `userMaskEnabled` / `revealAll`
 * (User Mask / Reveal All — fully white mask).
 *
 * **The "two equivalent forms" claim from the earlier Windows-only
 * review was WRONG.** It concluded that
 * `desc.putClass(sTID('new'), sTID('channel'))` and the
 * `desc.putReference(cTID('null'), ref<class=channel>)` shapes were
 * routed to the same internal dispatcher. The 2026-06-08 macOS capture
 * proves they are NOT equivalent on macOS PS 27.7: the null/putReference
 * shape is rejected with "command Make is not currently available."
 * The captured shape — putClass directly on the descriptor under the
 * `new` key, stringIDs throughout — is the only form that works on
 * both platforms. The Editmamei snippet was rewritten in v0.5.8 to
 * match the capture verbatim.
 */

import type { AmEventSpec } from '../../types.js';
import { stringID } from '../../types.js';

export const createRevealAllMaskSpec: AmEventSpec = {
  id: 'masks/create-reveal-all',
  displayName: 'Create Layer Mask — Reveal All',
  category: 'masks',
  emittedBy: ['ps_layer_mask (op=create)'],
  snippetRef:
    'go-core/cmd/buildtemplates/fragments_masks.go (vault.CreateMask — non-adjustment-layer branch)',
  groundTruth: {
    capturedAt: '2026-06-08',
    psVersion: '27.7.0',
    platform: 'macOS',
    sourceLog: 'user-pasted ScriptListener capture A (Layer > Layer Mask > Reveal All)',
    menuPath: 'Layer > Layer Mask > Reveal All',
  },
  knownGotchas: [
    'The class-of-thing-to-create slot MUST be `desc.putClass(sTID("new"), sTID("channel"))` — declared directly on the outer descriptor under the `new` key. The legacy `desc.putReference(cTID("null"), ref<class=Chnl>)` form is rejected on macOS PS 27.7 with "command Make is not currently available." Pre-v0.5.8 Editmamei used the legacy form (it was lenient-accepted on Windows but failed on Mac).',
    'All keys + values use stringIDs (`new`, `channel`, `mask`, `at`, `using`, `userMaskEnabled`, `revealAll`, `make`). charID equivalents exist in some PS APIs but the macOS captures use stringIDs and the snippet mirrors them verbatim — do not "modernize" by swapping in charIDs without re-capturing.',
    'The `at` reference targets the layer\'s mask CHANNEL slot via the enumerated reference `<channel, channel, mask>`. This is the "where" of the create — the layer\'s mask slot specifically, not the composite channel.',
    'The `using` enumerated value `userMaskEnabled / revealAll` makes the mask fully WHITE (reveals all layer pixels). For a fully-black mask use the Hide All variant — same descriptor shape with `using` → `userMaskEnabled / hideAll`.',
  ],
  versionNotes: [
    'Pre-v0.5.7: snippet sent `at` as a bare enumerated value on the outer descriptor (`desc.putEnumerated(cTID("At  "), cTID("Chnl"), cTID("Msk "))`). Windows accepted; macOS rejected. v0.5.7 fixed the `at` slot to use ActionReference but kept the broken `null`/putReference shape for the class slot.',
    'v0.5.8 (2026-06-08): switched the entire descriptor to the captured stringID/`new`-putClass shape. ScriptListener capture from macOS PS 27.7 is the canonical reference. The `tests/tools/selection-tools.test.ts` mask-creation tests carry `.not.toContain` regression guards on BOTH the bare-enum `At` shape and the null/putReference(class) shape, plus positive pins on the captured form.',
  ],
  events: [
    {
      index: 1,
      event: stringID('make'),
      comment:
        'Creates a new mask channel on the active layer, fully white (Reveal All). The class slot is `new` → putClass(channel); the legacy null/putReference shape is NOT accepted by macOS PS 27.7.',
      descriptor: {
        classID: stringID('null'),
        fields: [
          {
            name: 'New (the class of thing to create)',
            typeID: stringID('new'),
            kind: 'class',
            required: true,
            description:
              'Exact form: `desc.putClass(sTID("new"), sTID("channel"))`. Declares that the thing being created is a Channel. This is the only accepted class-slot form on macOS PS 27.7 — the legacy null/putReference(class) shape fails.',
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
              'Targets the layer\'s mask channel slot via enumerated reference `<channel, channel, mask>`. This is the "where to install the new channel" — the layer\'s mask slot specifically. Wrap in an ActionReference; do NOT send as a bare putEnumerated on the outer descriptor.',
          },
          {
            name: 'Using (the kind of mask + fill)',
            typeID: stringID('using'),
            kind: 'enum',
            required: true,
            enumType: stringID('userMaskEnabled'),
            enumValues: [
              {
                typeID: stringID('revealAll'),
                label: 'Reveal All',
                context: 'Fully white mask — all layer pixels visible.',
              },
            ],
            description:
              'For Reveal All this is `userMaskEnabled / revealAll`. Companion variants: `revealSelection` (see create-reveal-selection.ts) and `hideAll` (fully black mask).',
          },
        ],
      },
    },
  ],
};
