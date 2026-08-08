/**
 * Apply Layer Mask — bake the mask into the layer pixels, then remove
 * the mask slot.
 *
 * Ground truth: PS 27.7.0 Windows, captured 2026-06-03.
 * Capture log: JS-36-Mask-Apply.log
 *
 * The user opened a fresh PS doc with a masked layer and chose
 * Layer > Layer Mask > Apply. PS bakes the mask into the layer (pixels
 * outside the white parts of the mask become transparent / black on
 * the layer\'s alpha) and removes the mask channel slot in one
 * atomic operation.
 *
 * **The "Apply" is actually a Delete with an Apply flag.** Counter-
 * intuitively, modern PS emits a `Dlt ` (Delete) event with a top-
 * level `Aply: true` boolean. The same UI button drives both
 * apply-and-delete and delete-without-apply via this flag — when the
 * flag is true, the mask is baked into the layer before the channel
 * is removed; when false, the mask is discarded without baking
 * (separate spec: delete-mask.ts).
 *
 * **Snippet uses legacy `Aply` event ID (MED severity).** The
 * Editmamei snippet (go-core/cmd/buildtemplates/fragments_masks.go, vault.ApplyMask) sends a top-level
 * `Aply` event with a `null=ref<Chnl/Chnl/Msk >` reference. PS\'s
 * internal dispatcher routes both forms to the same operation, so
 * the snippet works in practice — but the modern UI-emitted form is
 * `Dlt + Aply=true`. A future PS version COULD deprecate the
 * standalone `Aply` event, at which point the snippet would silently
 * no-op.
 *
 * Spec-vs-snippet verdict: **MED**. Snippet uses legacy-
 * but-functional event ID; capture uses the modern unified `Dlt +
 * Aply` form. Both events documented below; recommend migrating the
 * snippet to the captured form (which would unify apply-and-delete
 * with delete-mask under a single AM event differing only by the
 * `Aply` boolean — mirroring PS\'s own internal model).
 */

import type { AmEventSpec } from '../../types.js';
import { charID } from '../../types.js';

export const applyMaskSpec: AmEventSpec = {
  id: 'masks/apply-mask',
  displayName: 'Apply Layer Mask',
  category: 'masks',
  emittedBy: ['ps_layer_mask (op=apply)'],
  snippetRef: 'go-core/cmd/buildtemplates/fragments_masks.go (vault.ApplyMask)',
  groundTruth: {
    capturedAt: '2026-06-03',
    psVersion: '27.7.0',
    platform: 'Windows',
    sourceLog: 'JS-36-Mask-Apply.log',
    menuPath: 'Layer > Layer Mask > Apply',
  },
  knownGotchas: [
    'Counter-intuitive event shape: the "apply" UI action is actually `Dlt ` (Delete) with `Aply=true` boolean — the same event ID as delete-without-apply (delete-mask.ts), discriminated by the `Aply` flag. PS\'s UI button maps both behaviors to one capability and uses the flag to select.',
    'The Editmamei snippet currently emits a top-level `Aply` event (the legacy CS6-era documented form) instead of the modern `Dlt + Aply=true` form. Both reach the same end state on PS 27.x; the legacy `Aply` event has not been observed to silently no-op. Risk: a future PS version could deprecate the standalone `Aply` event.',
    "The snippet's reference is `Chnl/Chnl/Msk ` (target the mask channel specifically); the capture's is `Chnl/Ordn/Trgt` (target whatever channel is currently active). For an LLM-driven invocation the explicit-mask reference is SAFER — it works even if the caller hasn't pre-targeted the mask channel. The UI's `Ordn/Trgt` form relies on the menu-enabled-when-mask-active gating which is absent from a programmatic call.",
    "DESTRUCTIVE: applying a mask is non-reversible without an undo. The mask's white pixels remain visible, black pixels become transparent on the layer. There is no automatic duplicate-first protection (this op is conceptually in-place by nature — the auto-duplicate-first pattern from docs/engineering/tool-design.md does NOT apply here).",
  ],
  versionNotes: [
    'Two AM-event forms accepted by PS 27.x: (a) top-level `Aply` event with `null=ref<Chnl/Chnl/Msk >` — the legacy / documented scripting form; (b) top-level `Dlt ` event with `null=ref<Chnl/Ordn/Trgt>` + `Aply=true` boolean — the modern UI-emitted form. The snippet uses (a); the capture shows (b).',
    'Recommend migrating the snippet to the captured `Dlt + Aply=true` form. Defer until a live verification session confirms the change still works; add a `.not.toContain("executeAction(cTID(\'Aply\')")` regression guard to lock the migration.',
  ],
  events: [
    {
      index: 1,
      event: charID('Dlt '),
      comment:
        'Captured / canonical modern UI form: Delete the mask channel WHILE baking it into the layer. The `Aply=true` boolean is the discriminator that says "bake before delete" — without it, the same event becomes plain delete-mask (see delete-mask.ts). The Editmamei snippet currently uses a different top-level event ID (`Aply`); see versionNotes.',
      descriptor: {
        classID: charID('null'),
        fields: [
          {
            name: 'target (current channel — i.e. the mask, when menu-enabled)',
            typeID: charID('null'),
            kind: 'reference',
            required: true,
            referenceShape: {
              classID: charID('Chnl'),
              variant: 'enumerated',
              enumKey: charID('Ordn'),
              enumValue: charID('Trgt'),
            },
            description:
              'Capture form: `Chnl / Ordn / Trgt` (the current target channel — relies on the mask being active). The snippet uses the safer-for-LLM `Chnl / Chnl / Msk ` enumerated reference instead, which explicitly targets the mask channel regardless of current target.',
          },
          {
            name: 'Apply (bake-into-layer flag)',
            typeID: charID('Aply'),
            kind: 'boolean',
            required: true,
            booleanDefault: false,
            description:
              'TRUE = bake mask into layer pixels then remove the channel slot (this spec). FALSE = remove channel slot without baking (delete-mask.ts).',
            gotchas: [
              'When this flag is missing entirely, PS treats it as FALSE (delete-without-apply). The two operations differ only by this single boolean.',
            ],
          },
        ],
      },
    },
  ],
};
