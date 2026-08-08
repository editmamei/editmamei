/**
 * Delete Layer Mask — remove the mask channel WITHOUT baking it into
 * the layer pixels.
 *
 * Ground truth: PS 27.7.0 Windows, captured 2026-06-03.
 * Capture log: JS-37-Mask-Delete.log
 *
 * The user opened a fresh PS doc with a masked layer and chose
 * Layer > Layer Mask > Delete. The mask channel slot is removed; the
 * layer pixels are unaffected (no baking).
 *
 * **Same event as apply-mask, discriminated by absence of `Aply` flag.**
 * Both `apply-mask.ts` and this spec use `Dlt ` as the top-level event
 * with a `null=ref<Chnl/...>` reference. The difference: apply-mask
 * includes `Aply=true` (bake before delete), delete-mask omits the
 * `Aply` key entirely (or sets it false). PS treats absent `Aply` as
 * FALSE.
 *
 * **Reference variant — snippet uses LLM-safer explicit mask reference.**
 * The capture targets `Chnl/Ordn/Trgt` (the current channel — relies
 * on the menu-enabled-when-mask-active gating to ensure the mask is
 * the target). The Editmamei snippet (go-core/cmd/buildtemplates/fragments_masks.go, vault.DeleteMask)
 * targets `Chnl/Chnl/Msk ` (the mask channel specifically). Both
 * work; the snippet\'s explicit form is safer for an LLM-driven
 * invocation where the caller may not have pre-targeted the mask.
 *
 * Spec-vs-snippet verdict: **OK**. Snippet matches the
 * captured event ID exactly; the reference-shape divergence is
 * intentional hardening over the UI\'s "current target" assumption.
 */

import type { AmEventSpec } from '../../types.js';
import { charID } from '../../types.js';

export const deleteMaskSpec: AmEventSpec = {
  id: 'masks/delete-mask',
  displayName: 'Delete Layer Mask',
  category: 'masks',
  emittedBy: ['ps_layer_mask (op=delete)'],
  snippetRef: 'go-core/cmd/buildtemplates/fragments_masks.go (vault.DeleteMask)',
  groundTruth: {
    capturedAt: '2026-06-03',
    psVersion: '27.7.0',
    platform: 'Windows',
    sourceLog: 'JS-37-Mask-Delete.log',
    menuPath: 'Layer > Layer Mask > Delete',
  },
  knownGotchas: [
    'Same `Dlt ` event ID as apply-mask.ts. The discriminator is the `Aply` boolean: present-and-true = bake-into-layer; absent or false = remove without baking (this spec). Don\'t emit `Aply=false` explicitly — the capture omits the key entirely, and that\'s the canonical "delete without baking" form.',
    "Snippet's reference is `Chnl/Chnl/Msk ` (explicit mask channel) vs capture's `Chnl/Ordn/Trgt` (current channel). The snippet form is safer for an LLM-driven invocation — it doesn't depend on the mask being pre-targeted. Both are PS-accepted.",
    "The layer's pixels are NOT affected by this op — only the mask channel slot is removed. To bake the mask before removal use apply-mask.ts.",
  ],
  versionNotes: [
    "The `Dlt ` event with channel-class reference has been stable since at least PS CS6. The snippet's explicit-mask-channel reference variant has been the regression-pinned form since the 2026-05-30 mask descriptor bug fix.",
  ],
  events: [
    {
      index: 1,
      event: charID('Dlt '),
      comment:
        'Removes the mask channel slot from the active layer without affecting layer pixels. Capture uses `Chnl/Ordn/Trgt` reference (relies on mask being current target). Snippet uses `Chnl/Chnl/Msk ` (explicit mask channel) — both are accepted by PS. The `Aply` flag is absent (= false) — this is the discriminator vs apply-mask.ts.',
      descriptor: {
        classID: charID('null'),
        fields: [
          {
            name: 'target (current channel — i.e. the mask, when menu-enabled) — capture form',
            typeID: charID('null'),
            kind: 'reference',
            required: false,
            referenceShape: {
              classID: charID('Chnl'),
              variant: 'enumerated',
              enumKey: charID('Ordn'),
              enumValue: charID('Trgt'),
            },
            description:
              'Capture form: relies on the mask channel being the current target. Marked required:false because the snippet uses the explicit-mask variant below — exactly ONE of the two must be emitted.',
          },
          {
            name: 'target (explicit mask channel) — snippet form',
            typeID: charID('null'),
            kind: 'reference',
            required: false,
            referenceShape: {
              classID: charID('Chnl'),
              variant: 'enumerated',
              enumKey: charID('Chnl'),
              enumValue: charID('Msk '),
            },
            description:
              'Snippet form: `<Chnl, Chnl, Msk >` enumerated reference. Targets the mask channel regardless of which channel is currently active. Safer for LLM-driven invocations. Marked required:false because exactly ONE of the two reference variants must be emitted.',
          },
        ],
      },
    },
  ],
};
