/**
 * Gradient Map adjustment layer — Reverse + Dither flipped on,
 * plus interpolation method switched to Linear.
 *
 * Ground truth: PS 27.7.0 Windows, captured 2026-06-03.
 * Capture log: JS-16-Grad-Map-RevDither.log
 *
 * The user created a Gradient Map (default Foreground-to-Background),
 * then in the Properties panel ticked Reverse, ticked Dither, and
 * separately picked the Blue_02 preset (which is a slct event, not
 * relevant to this spec). The captured setd carries the three property
 * toggles only — the gradient itself is unchanged from the Mk state.
 *
 * Shape (setd only — no separate Mk; this is a property toggle on an
 * existing layer):
 *   T → GdMp → {
 *     Rvrs = true (boolean),
 *     Dthr = true (boolean),
 *     gradientsInterpolationMethod = Lnr enum
 *   }
 *
 * Group A audit (STEP 16) classified OK — `Rvrs`/`Dthr` are the
 * canonical keys and match the snippet. Interpolation method choice
 * is not currently exposed by the snippet schema.
 *
 * The `Lnr ` value (note trailing space — 4-char charID) is the linear
 * interpolation. `Smoo` is the default. `StrI` is a striped/stripes
 * variant rarely used.
 */

import type { AmEventSpec } from '../../types.js';
import { charID, stringID } from '../../types.js';

export const gradientMapReverseDitherSpec: AmEventSpec = {
  id: 'adjustments/gradient-map-reverse-dither',
  displayName: 'Gradient Map adjustment layer (Reverse + Dither on)',
  category: 'adjustments',
  emittedBy: ['ps_add_adjustment_layer'],
  snippetRef:
    'go-core/cmd/buildtemplates/fragments_adjustments_types.go (vault.AdjGMTd — Rvrs/Dthr emitted up-front)',
  groundTruth: {
    capturedAt: '2026-06-03',
    psVersion: '27.7.0',
    platform: 'Windows',
    sourceLog: 'JS-16-Grad-Map-RevDither.log',
    menuPath: 'Layer > New Adjustment Layer > Gradient Map (then tick Reverse + Dither)',
  },
  knownGotchas: [
    '`Rvrs` (Reverse) and `Dthr` (Dither) are the canonical boolean keys. Snippet emits them up-front in the Mk envelope; ground truth carries them in the setd. Both forms work.',
    'gradientsInterpolationMethod values: `Smoo` (default smooth), `Lnr ` (linear — note trailing space charID), `StrI` (striped/banded). PS emits the enum every time the user changes the dropdown.',
    'This setd carries ONLY the property toggles — the Grdn definition is unchanged. PS does NOT re-emit the Grad → Grdn block in this scenario.',
    'If the snippet pre-creates Reverse + Dither in the Mk envelope, this setd shape is what the LIVE PS UI would emit when the user toggles them later — i.e. it\'s the "post-creation property edit" shape.',
  ],
  versionNotes: [
    '`Lnr ` interpolation method appeared in PS 24 alongside gradientsInterpolationMethod. Older PS hardcoded Smoo.',
  ],
  events: [
    {
      index: 1,
      event: charID('setd'),
      comment:
        'Toggles Reverse + Dither + Linear interpolation on an existing Gradient Map layer. The Grdn definition is NOT re-emitted — just the three property toggles.',
      descriptor: {
        classID: charID('null'),
        fields: [
          {
            name: 'target (active adjustment layer)',
            typeID: charID('null'),
            kind: 'reference',
            required: true,
            referenceShape: {
              classID: charID('AdjL'),
              variant: 'enumerated',
              enumKey: charID('Ordn'),
              enumValue: charID('Trgt'),
            },
          },
          {
            name: 'T (the GdMp values descriptor)',
            typeID: charID('T   '),
            kind: 'object',
            required: true,
            innerShape: {
              classID: charID('GdMp'),
              fields: [
                {
                  name: 'Reverse',
                  typeID: charID('Rvrs'),
                  kind: 'boolean',
                  required: false,
                  booleanDefault: false,
                  description:
                    'When true, gradient direction is flipped (right→left instead of left→right).',
                },
                {
                  name: 'Dither',
                  typeID: charID('Dthr'),
                  kind: 'boolean',
                  required: false,
                  booleanDefault: false,
                  description: 'When true, gradient banding is broken up with stochastic noise.',
                },
                {
                  name: 'Gradients Interpolation Method',
                  typeID: stringID('gradientsInterpolationMethod'),
                  kind: 'enum',
                  required: false,
                  enumType: stringID('gradientInterpolationMethodType'),
                  enumValues: [
                    {
                      typeID: charID('Smoo'),
                      label: 'Smooth (default)',
                      context: 'Anti-banded interpolation.',
                    },
                    {
                      typeID: charID('Lnr '),
                      label: 'Linear',
                      context:
                        'Straight linear interpolation between stops. Note trailing space in charID.',
                    },
                    { typeID: charID('StrI'), label: 'Striped' },
                  ],
                  description:
                    'PS 24+ key. Not currently exposed by the addAdjustmentLayer schema.',
                },
              ],
            },
          },
        ],
      },
    },
  ],
};
