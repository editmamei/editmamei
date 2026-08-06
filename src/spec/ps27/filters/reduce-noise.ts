/**
 * Reduce Noise filter (Filter > Noise > Reduce Noise).
 *
 * Ground truth: PS 27.7.0 Windows, captured 2026-06-03.
 * Capture log: JS-24-Reduce-Noise.log
 *
 * The user opened Filter > Noise > Reduce Noise, switched to Advanced
 * mode, and configured: Strength (Color Noise) 53%, Sharpen Details 41%,
 * Remove JPEG Artifact off, per-channel overrides for Composite/Red/
 * Green/Blue with varying Strength + Preserve Details settings.
 *
 * PS emits ONE event: `denoise` (stringID — matches the pre-audit
 * Editmamei snippet exactly; already audited this on macOS, and Windows
 * now confirms).
 *
 * **OK severity — both platforms agree.** The rewrite (event `denoise`,
 * root `colorNoise`/`sharpen` as putUnitDouble percentUnit, per-channel
 * list of `channelDenoiseParams` objects with Channel reference +
 * Amount + Edge Fidelity) matches the Windows capture cleanly.
 *
 * The root keys `ClNs` (color noise) and `Shrp` (sharpen) are charID in
 * the capture; the pre-audit snippet uses stringIDs `colorNoise` and
 * `sharpen` which alias correctly via PS's typeID resolver. Same for
 * `percentUnit` / `#Prc`. These are equivalent in practice; optional
 * cosmetic switch to charID for byte-identity with the capture.
 */

import type { AmEventSpec } from '../../types.js';
import { charID, stringID } from '../../types.js';

const channelDenoiseParamsShape = {
  classID: stringID('channelDenoiseParams'),
  fields: [
    {
      name: 'Channel reference (Chnl)',
      typeID: charID('Chnl'),
      kind: 'reference' as const,
      required: true,
      referenceShape: {
        classID: charID('Chnl'),
        variant: 'enumerated' as const,
        enumKey: charID('Chnl'),
        // enumValue varies per channel: Cmps / Rd   / Grn  / Bl
      },
      description:
        'Which channel this per-channel override applies to. Enumerated reference: `Cmps` (Composite), `Rd  ` (Red), `Grn ` (Green), `Bl  ` (Blue).',
      gotchas: [
        'The composite entry is ALWAYS emitted by PS — even when the user has not touched a per-channel override, the composite slider values are written as a `Cmps` channel entry. Snippets MUST include the composite entry.',
      ],
    },
    {
      name: 'Amount (Amnt)',
      typeID: charID('Amnt'),
      kind: 'integer' as const,
      required: true,
      range: { min: 0, max: 100, default: 0 },
      description: 'Per-channel strength (0-100). Capture: Composite 3, Red 2, Green 5, Blue 5.',
    },
    {
      name: 'Edge fidelity (EdgF)',
      typeID: charID('EdgF'),
      kind: 'integer' as const,
      required: true,
      range: { min: 0, max: 100, default: 0 },
      description:
        'Per-channel preserve-details / edge-fidelity (0-100). Capture: Composite 52, Red 27, Green 43, Blue 60.',
    },
  ],
};

export const reduceNoiseSpec: AmEventSpec = {
  id: 'filters/reduce-noise',
  displayName: 'Reduce Noise filter',
  category: 'filters',
  emittedBy: ['ps_apply_filter (type=reduce_noise)'],
  snippetRef:
    'go-core/cmd/buildtemplates/fragments_filters.go (vault.RedNoise — verified by this Windows capture)',
  groundTruth: {
    capturedAt: '2026-06-03',
    psVersion: '27.7.0',
    platform: 'Windows',
    sourceLog: 'JS-24-Reduce-Noise.log',
    menuPath: 'Filter > Noise > Reduce Noise',
  },
  knownGotchas: [
    'Composite (`Cmps`) channel entry is ALWAYS in the channelDenoise list, even if the user has not opened the Advanced tab. The pre-audit snippet correctly always emits the composite entry.',
    "Channel enum values are charIDs with trailing spaces where needed: `Cmps`, `Rd  ` (two trailing spaces), `Grn ` (one trailing space), `Bl  ` (two trailing spaces). The pre-audit snippet uses stringIDs `composite`/`red`/`green`/`blue` which alias correctly via PS's typeID resolver — functionally equivalent.",
    'Root keys `ClNs` (Color Noise) and `Shrp` (Sharpen Details) are charIDs in the capture. Pre-audit snippet uses stringID aliases `colorNoise` / `sharpen` — equivalent in practice, optional cosmetic switch to charID for byte-identity.',
    'Preset string is hardcoded `"Default"` in both the capture and the pre-audit snippet. Other dialog presets (e.g. user-saved custom presets) are unverified.',
    "The dialog's Reduce Color Noise + Strength + Preserve Details (per Advanced channel) all map to the same per-channel object — only `Amnt` and `EdgF` keys per channel; no separate color-noise key per channel.",
    'Grain (the dialog\'s "Strength" / Reduce Noise / Reduce Color Noise interplay) is out of scope here; only the channelDenoise list is exposed. The pre-audit snippet docstring notes this.',
  ],
  versionNotes: [
    'The 2026-06-02 fix rewrote this snippet against macOS ScriptListener ground truth after the previous version was discovered to be forum-lore fiction. The Windows capture (2026-06-03) now CONFIRMS the rewrite cross-platform.',
    'Audit report verdict: OK. No functional changes needed. Optional cosmetic: switch root stringID aliases (`colorNoise`/`sharpen`/`percentUnit`) to charIDs (`ClNs`/`Shrp`/`#Prc`) for byte-identity with the capture.',
  ],
  events: [
    {
      index: 1,
      event: stringID('denoise'),
      comment:
        'Single-event filter dispatch. Root descriptor carries the global Color Noise + Sharpen amounts, the JPEG-artifact toggle, the per-channel override list, and the preset name. The per-channel list ALWAYS includes a Composite entry plus one entry per primary channel.',
      descriptor: {
        classID: charID('null'),
        fields: [
          {
            name: 'Color noise (ClNs)',
            typeID: charID('ClNs'),
            kind: 'unitDouble',
            required: true,
            unit: { charID: '#Prc' },
            range: { min: 0, max: 100, default: 50 },
            description: 'Reduce Color Noise (0-100%). Capture: 53.0.',
            gotchas: [
              'Key is charID `ClNs`. PS aliases stringID `colorNoise` to this — equivalent in practice.',
            ],
          },
          {
            name: 'Sharpen details (Shrp)',
            typeID: charID('Shrp'),
            kind: 'unitDouble',
            required: true,
            unit: { charID: '#Prc' },
            range: { min: 0, max: 100, default: 25 },
            description: 'Sharpen Details (0-100%). Capture: 41.0.',
            gotchas: [
              'Key is charID `Shrp`. PS aliases stringID `sharpen` to this — equivalent in practice.',
            ],
          },
          {
            name: 'removeJPEGArtifact',
            typeID: stringID('removeJPEGArtifact'),
            kind: 'boolean',
            required: true,
            booleanDefault: false,
            description: 'Remove JPEG compression artifacts. Capture: false.',
          },
          {
            name: 'channelDenoise (per-channel overrides list)',
            typeID: stringID('channelDenoise'),
            kind: 'list',
            required: true,
            itemSchema: channelDenoiseParamsShape,
            description:
              'List of per-channel override descriptors. Composite + Red + Green + Blue always present, in that order in the capture.',
            gotchas: [
              'Composite entry MUST be emitted even when the user has not opened the Advanced tab — capture confirms PS always writes it as the first entry.',
              'Items are putObject with class `channelDenoiseParams` (stringID).',
            ],
          },
          {
            name: 'preset',
            typeID: stringID('preset'),
            kind: 'string',
            required: true,
            stringDefault: 'Default',
            description:
              'Preset name. Hardcoded "Default" in this capture; the snippet also hardcodes "Default". User-saved presets are not verified here.',
          },
        ],
      },
    },
  ],
};
