/**
 * Invert adjustment layer — **HIGH-severity spec**.
 *
 * Ground truth: PS 27.7.0 Windows, captured 2026-06-03.
 * Capture log: JS-21-Invert.log
 *
 * The user opened a fresh PS doc, clicked Layer > New Adjustment Layer >
 * Invert, accepted the dialog. Invert has no parameters — a single Mk
 * event with no setd.
 *
 * Ground truth shape:
 *   `using.putClass(Type, Invr)` — **NO inner descriptor**.
 *
 * Identical pattern to Color Lookup (the parameterless / type-only
 * adjustment layer pattern). Adjs with no parameters use `putClass`
 * instead of `putObject` with an empty descriptor.
 *
 * **HIGH-severity drift**: snippet currently
 * goes through the general `putObject(Type, Invr, typeDesc{
 * presetKindDefault})` path at line 3023. PS 27 tolerates this — the
 * extra `presetKindDefault` is a no-op on a type-only adjustment — but
 * the canonical shape is putClass, and a future PS version may tighten
 * validation. Audit recommended adding `invert` to the Color-Lookup-
 * style branch and gating the presetKindDefault push.
 */

import type { AmEventSpec } from '../../types.js';
import { charID } from '../../types.js';

export const invertSpec: AmEventSpec = {
  id: 'adjustments/invert',
  displayName: 'Invert adjustment layer',
  category: 'adjustments',
  emittedBy: ['ps_add_adjustment_layer'],
  snippetRef:
    'go-core/cmd/buildtemplates/fragments_adjustments.go (vault.AdjUsingClass — the putClass-only branch shared with color_lookup)',
  groundTruth: {
    capturedAt: '2026-06-03',
    psVersion: '27.7.0',
    platform: 'Windows',
    sourceLog: 'JS-21-Invert.log',
    menuPath: 'Layer > New Adjustment Layer > Invert',
  },
  knownGotchas: [
    'HIGH (canonical-shape divergence): Mk MUST use `using.putClass(Type, Invr)` with NO inner descriptor. Snippet currently uses `putObject(Type, Invr, typeDesc{presetKindDefault})` via the general path. PS 27 tolerates the extra typeDesc but the canonical shape is putClass-only. Audit recommended fixing.',
    'Same putClass-only pattern as Color Lookup — both are type-only adjustments that own no parameters.',
    'NO setd event. Invert is a single-event op — apply happens at Mk.',
    "Audit-recommended snippet fix: extend the existing Color-Lookup-only branch at line 3008 to also include `invert` so it emits `using.putClass(cTID('Type'), typeCharID)` instead of going through the general `putObject` path. Also gate the `presetKindDefault` push at line 2978 behind `adjT !== 'invert'`.",
    "Recommended regression test: `.not.toContain('putObject')` near the Invr path. Audit also suggested a positive `toContain('putClass(cTID(\\'Type\\'), cTID(\\'Invr\\'))')`.",
  ],
  versionNotes: [
    'putClass-only shape has been the canonical Invert pattern since PS CS6. The putObject form has historically been tolerated as a no-op extra-key path. PS may tighten validation in a future major.',
  ],
  events: [
    {
      index: 1,
      event: charID('Mk  '),
      comment:
        'Creates the Invert adjustment layer. CANONICAL: putClass(Type, Invr) with no inner descriptor. This event is the ENTIRE op — no setd follows.',
      descriptor: {
        classID: charID('null'),
        fields: [
          {
            name: 'target (null reference to AdjL class)',
            typeID: charID('null'),
            kind: 'reference',
            required: true,
            referenceShape: {
              classID: charID('AdjL'),
              variant: 'class',
            },
          },
          {
            name: 'Using (the type-bearing descriptor — putClass-only)',
            typeID: charID('Usng'),
            kind: 'object',
            required: true,
            innerShape: {
              classID: charID('AdjL'),
              fields: [
                {
                  name: 'Type — putClass(Invr), NO inner descriptor',
                  typeID: charID('Type'),
                  kind: 'class',
                  required: true,
                  description:
                    "CANONICAL SHAPE: `desc.putClass(cTID('Type'), cTID('Invr'))`. NOT putObject. Snippet currently uses putObject with a typeDesc{presetKindDefault} — works but is the wrong canonical shape (audit HIGH finding).",
                },
              ],
            },
          },
        ],
      },
    },
  ],
};
