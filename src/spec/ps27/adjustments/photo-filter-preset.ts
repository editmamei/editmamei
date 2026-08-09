/**
 * Photo Filter adjustment layer — built-in preset (Warming Filter 85).
 *
 * Ground truth: PS 27.7.0 Windows, captured 2026-06-03.
 * Capture log: JS-09-Photo-Filter-Preset.log
 *
 * The user opened a fresh PS doc, clicked Layer > New Adjustment Layer >
 * Photo Filter, picked "Warming Filter (85)" from the preset dropdown,
 * set density to 25, left Preserve Luminosity ticked.
 *
 * **Important capture-vs-snippet drift** (MEDIUM):
 * PS 2026 has migrated the built-in preset path to emit a literal
 * `Clr → LbCl{Lmnc, A, B doubles}` Lab-color object that encodes the
 * preset (warming-85 ≈ Lab 67.06/+32/+120). There is **no `Fltr`
 * enum** in the ground truth at all.
 *
 * The current snippet still emits the legacy `putEnumerated(cTID('Fltr'),
 * cTID('Fltr'), sTID(presetId))` form (e.g. `sTID('warmingFilter85')`).
 * PS 2026 still accepts this — the preset enum resolves to the same Lab
 * triple internally — but the trajectory is toward the LbCl form being
 * the only accepted shape.
 *
 * Audit recommended deferring the migration: legacy enum still works.
 */

import type { AmEventSpec } from '../../types.js';
import { charID, stringID } from '../../types.js';

export const photoFilterPresetSpec: AmEventSpec = {
  id: 'adjustments/photo-filter-preset',
  displayName: 'Photo Filter adjustment layer (built-in preset)',
  category: 'adjustments',
  emittedBy: ['ps_add_adjustment_layer'],
  snippetRef:
    'go-core/cmd/buildtemplates/fragments_adjustments_types.go (vault.AdjPFPset — preset path emits Fltr enum)',
  groundTruth: {
    capturedAt: '2026-06-03',
    psVersion: '27.7.0',
    platform: 'Windows',
    sourceLog: 'JS-09-Photo-Filter-Preset.log',
    menuPath: 'Layer > New Adjustment Layer > Photo Filter (Warming Filter 85 preset, density 25)',
  },
  knownGotchas: [
    'GROUND TRUTH on PS 2026: PS emits `Clr → LbCl{Lmnc, A, B}` Lab color object for built-in presets. There is NO `Fltr` enum key in the captured descriptor. Each preset has an internal Lab triple — Warming 85 ≈ (67.06, 32.0, 120.0).',
    "LEGACY (still accepted): snippet emits `putEnumerated(cTID('Fltr'), cTID('Fltr'), sTID(presetId))` where presetId is e.g. `warmingFilter85`, `warmingFilter81`, `coolingFilter82`, `coolingFilter80`. PS 2026 still resolves these to the right Lab — audit MEDIUM finding, deferred fix.",
    'Snippet preset-name casing matters when going the legacy enum route: `warmingFilter85` (camelCase) — `warmingfilter85` or `WarmingFilter85` will be silently rejected by sTID.',
    '`Dnst` (Density) is a plain putInteger, range 0..100. Default 25 (varies with preset). Distinct from Saturation/Strt.',
    '`PrsL` (Preserve Luminosity) is a boolean, default true. Same canonical key family as Color Balance.',
  ],
  versionNotes: [
    'PS 2026 internally migrated preset resolution from enum-lookup to direct Lab emission. The enum form still resolves but is the legacy path; the LbCl form is the modern path.',
    'PS 23 and earlier accepted ONLY the Fltr enum form. PS 24+ accepts both; PS 27 emits the LbCl form natively when the user picks a preset.',
  ],
  events: [
    {
      index: 1,
      event: charID('Mk  '),
      comment:
        'Creates the Photo Filter adjustment layer with the preset values inline (single-event op — no separate setd). Ground truth: Clr → LbCl Lab triple + Dnst + PrsL.',
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
            name: 'Using (the type-bearing descriptor)',
            typeID: charID('Usng'),
            kind: 'object',
            required: true,
            innerShape: {
              classID: charID('AdjL'),
              fields: [
                {
                  name: 'Type (the photoFilter type descriptor)',
                  typeID: charID('Type'),
                  kind: 'object',
                  required: true,
                  innerShape: {
                    classID: stringID('photoFilter'),
                    fields: [
                      {
                        name: 'Color (Lab color encoding the preset)',
                        typeID: charID('Clr '),
                        kind: 'object',
                        required: true,
                        innerShape: {
                          classID: charID('LbCl'),
                          fields: [
                            {
                              name: 'Luminance',
                              typeID: charID('Lmnc'),
                              kind: 'double',
                              required: true,
                              range: { min: 0, max: 100 },
                              description: 'Lab L channel. Warming 85 preset emits 67.060000.',
                            },
                            {
                              name: 'A (green-magenta axis)',
                              typeID: charID('A   '),
                              kind: 'double',
                              required: true,
                              range: { min: -128, max: 127 },
                              description: 'Lab a channel. Warming 85 preset emits 32.000000.',
                            },
                            {
                              name: 'B (blue-yellow axis)',
                              typeID: charID('B   '),
                              kind: 'double',
                              required: true,
                              range: { min: -128, max: 127 },
                              description: 'Lab b channel. Warming 85 preset emits 120.000000.',
                            },
                          ],
                        },
                        description:
                          "GROUND TRUTH shape. The legacy `Fltr` enum (sTID('warmingFilter85') etc.) is an alternative the snippet currently uses; both work but LbCl is the canonical PS 27 emission.",
                      },
                      {
                        name: 'Density',
                        typeID: charID('Dnst'),
                        kind: 'integer',
                        required: true,
                        range: { min: 0, max: 100, default: 25 },
                      },
                      {
                        name: 'Preserve Luminosity',
                        typeID: charID('PrsL'),
                        kind: 'boolean',
                        required: true,
                        booleanDefault: true,
                      },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    },
  ],
};
