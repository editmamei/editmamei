/**
 * Invert Mask — parameterless invert applied to the current mask channel.
 *
 * Ground truth: PS 27.7.0 Windows, captured 2026-06-03.
 * Capture log: JS-35-Mask-Invert.log
 *
 * The user opened a fresh PS doc, added a layer mask, ensured the mask
 * channel was targeted, then chose Image > Adjustments > Invert (or
 * Cmd/Ctrl+I with the mask channel active). PS emits a SINGLE
 * parameterless `Invr` event with NO descriptor at all.
 *
 * Capture excerpt:
 * ```
 * var idInvr = charIDToTypeID( "Invr" );
 * executeAction( idInvr, undefined, DialogModes.NO );
 * ```
 *
 * **The deliberate empty-descriptor variance.** Editmamei's snippet
 * (called inline from `addAdjustmentLayer` — go-core/cmd/buildtemplates/fragments_adjustments.go,
 * vault.AdjLOuter, mask-invert block — for the "create adjustment
 * layer with inverted mask" path) passes
 * `new ActionDescriptor()` (an empty descriptor) instead of `undefined`.
 * The inline comment there documents the reason:
 * ExtendScript's `executeAction` rejects `undefined` for the
 * descriptor arg with "Bad argument 2" in some runtime contexts; an
 * empty `ActionDescriptor()` is the safe equivalent. PS sees no keys
 * either way — the two forms are semantically identical.
 *
 * **Pre- and post-step bracketing (LLM safety).** The snippet wraps
 * the invert with: (1) explicit pre-step `slct Chnl=Msk` to ensure
 * the mask channel is the target before invert runs, and (2) a
 * post-step to restore the composite RGB/CMYK/Gray channel so
 * subsequent ops don\'t accidentally paint into the mask. The
 * capture does NOT show these because the user had already targeted
 * the mask channel manually. The snippet\'s bracketing is correct
 * defensive programming for an LLM-driven invocation.
 *
 * Spec-vs-snippet verdict: **OK**. The empty-descriptor
 * variance is documented and semantically equivalent; pre/post
 * channel-target dance is the right safety net.
 */

import type { AmEventSpec } from '../../types.js';
import { charID } from '../../types.js';

export const invertMaskSpec: AmEventSpec = {
  id: 'masks/invert-mask',
  displayName: 'Invert Mask',
  category: 'masks',
  emittedBy: [
    'ps_add_adjustment_layer (when caller requests inverted-mask preset; inline in go-core/cmd/buildtemplates/fragments_adjustments.go, vault.AdjLOuter)',
  ],
  snippetRef:
    'go-core/cmd/buildtemplates/fragments_adjustments.go (vault.AdjLOuter — inline mask-invert block inside addAdjustmentLayer)',
  groundTruth: {
    capturedAt: '2026-06-03',
    psVersion: '27.7.0',
    platform: 'Windows',
    sourceLog: 'JS-35-Mask-Invert.log',
    menuPath: 'Image > Adjustments > Invert (with mask channel active)',
  },
  knownGotchas: [
    'The `Invr` event is PARAMETERLESS. PS emits `executeAction(Invr, undefined, ...)`; the Editmamei snippet passes `new ActionDescriptor()` (empty) instead of `undefined` because ExtendScript rejects `undefined` for arg 2 in some runtime paths ("Bad argument 2"). Semantically identical — PS sees zero descriptor keys either way.',
    'PRECONDITION: the mask channel must be the active target. The snippet handles this with a `slct Chnl=Msk ` pre-step; the capture does not show this because the user pre-targeted the mask manually via the menu UI.',
    "POST-STEP: the snippet restores the composite channel (RGB/CMYK/Gray) after invert so subsequent paint ops don't accidentally write into the mask. Critical for LLM-driven sequences where the next call may not re-target deliberately.",
    'Invert is fully reversible — calling it twice restores the original mask. No need for a separate "uninvert" tool.',
  ],
  versionNotes: [
    'The `Invr` charID has been stable across PS versions back to CS6. No version drift expected. This is one of the simpler captures in Group D.',
    "A separate `invertSelection` AM op exists for inverting selections (not masks) — different event ID, different target. Don't confuse them.",
  ],
  events: [
    {
      index: 1,
      event: charID('Invr'),
      noDescriptor: true,
      descriptor: null,
      comment:
        'Inverts pixel values of the currently-targeted channel. PS dispatches with `undefined` as the descriptor arg; Editmamei passes an empty `new ActionDescriptor()` for ExtendScript runtime-compatibility — both are accepted by PS and produce the same effect.',
    },
  ],
};
