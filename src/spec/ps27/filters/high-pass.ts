/**
 * High Pass filter (Filter > Other > High Pass).
 *
 * Ground truth: PS 27.7.0 Windows, captured 2026-06-03.
 * Capture log: JS-25-High-Pass.log
 *
 * The user opened Filter > Other > High Pass and accepted the dialog
 * with Radius 4.5 px. This is the simplest filter in Group B — one
 * descriptor key, no enums, no sub-objects.
 *
 * PS emits ONE event: `HghP` (charID — "High Pass"). The pre-audit
 * Editmamei snippet uses stringID `highPass` which PS aliases to the
 * same `HghP` charID via the well-known camelCase-stringID-of-old-
 * charID-mnemonic correspondence. Equivalent in practice.
 *
 * **OK severity — capture confirms the snippet works.** This is the good
 * case: a forum-lore stringID that DOES correctly
 * resolve to the canonical charID.
 */

import type { AmEventSpec } from '../../types.js';
import { charID } from '../../types.js';

export const highPassSpec: AmEventSpec = {
  id: 'filters/high-pass',
  displayName: 'High Pass filter',
  category: 'filters',
  emittedBy: ['ps_filter (type=high_pass)'],
  snippetRef:
    'go-core/cmd/buildtemplates/fragments_filters.go (vault.HighPass — VERIFIED OK by this Windows capture)',
  groundTruth: {
    capturedAt: '2026-06-03',
    psVersion: '27.7.0',
    platform: 'Windows',
    sourceLog: 'JS-25-High-Pass.log',
    menuPath: 'Filter > Other > High Pass',
  },
  knownGotchas: [
    "Event ID is charID `HghP`. The pre-audit snippet uses stringID `highPass` which PS aliases to this — equivalent in practice via PS's typeID resolver, but byte-non-identical with the capture.",
    'Single key `Rds ` (charID, trailing space) is putUnitDouble with `#Pxl` (pixelsUnit, charID). Pre-audit snippet uses stringID aliases `radius` / `pixelsUnit` — equivalent.',
    'No optional keys, no enums, no sub-objects, no list. This is the simplest filter in Group B.',
  ],
  versionNotes: [
    'Audit report verdict: OK. Snippet works correctly in live PS via PS alias resolution. No code change needed.',
    'Optional cosmetic: switch stringID aliases (`highPass`/`radius`/`pixelsUnit`) to charIDs (`HghP`/`Rds `/`#Pxl`) for byte-identity with the capture — not worth a code change unless the file is being cleaned up for documentation.',
  ],
  events: [
    {
      index: 1,
      event: charID('HghP'),
      comment:
        'Single-event filter dispatch. Single descriptor key — Radius in pixels. The simplest AM event in Group B.',
      descriptor: {
        classID: charID('null'),
        fields: [
          {
            name: 'Radius (Rds )',
            typeID: charID('Rds '),
            kind: 'unitDouble',
            required: true,
            unit: { charID: '#Pxl' },
            range: { min: 0.1, max: 1000, default: 10 },
            description: 'High-pass radius in pixels. Capture: 4.5.',
            gotchas: [
              'Key is charID `Rds ` (trailing space). PS aliases stringID `radius` to this — equivalent in practice.',
              'Unit is charID `#Pxl` (pixelsUnit). PS aliases stringID `pixelsUnit` to this — equivalent.',
            ],
          },
        ],
      },
    },
  ],
};
