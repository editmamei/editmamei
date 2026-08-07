/**
 * Place Embedded — drop an external image file in as a Smart Object layer.
 *
 * Ground truth: PS 27.7.0 Windows, captured 2026-06-03.
 * Capture log: JS-40-Place-Embed.log
 *
 * The user opened a fresh PS doc and chose File > Place Embedded,
 * picked an image from disk, accepted PS\'s default auto-fit-to-canvas
 * placement, and committed the transform. PS emits a SINGLE `Plc `
 * (charID) event with the file path, a free-transform anchor, an
 * offset (so the image lands centered after the auto-fit scale), and
 * width/height percent-scale values reflecting the auto-fit ratio.
 *
 * **MED severity drift: snippet omits Wdth/Hght percent scale.** The
 * Editmamei snippet (go-core/cmd/buildtemplates/fragments_documents.go, vault.PlaceImg) emits the event ID,
 * file path, FTcs free-transform anchor, and Ofst offset — but skips
 * the `Wdth`/`Hght` percent-scale fields. The capture shows
 * `Wdth=69.230769% / Hght=69.230769%` — the auto-fit-to-canvas scale
 * PS picks when the placed image is larger than the target canvas.
 * Without these fields, PS defaults to 100% (native pixel size). For
 * an LLM placing a large stock photo into a small canvas, the image
 * will land at native size instead of auto-fitting — UX-divergent
 * from the menu equivalent but NOT silently broken.
 *
 * **Snippet also omits `Idnt` and `replaceLayer` — both intentional.**
 * - `Idnt` is a layer-identifier hint PS auto-allocates for fresh
 *   placement. Not worth adding to the schema.
 * - `replaceLayer` is for re-place-into-existing-slot scenarios. Out
 *   of scope for the current "place a new image" tool contract.
 *
 * Group D audit verdict (2026-06-04): **MED**. Missing Wdth/Hght
 * causes UX divergence (native size vs auto-fit) but is not silently
 * broken. Fix prescribed: add optional `scale_percent` schema arg
 * (default: omit → PS uses 100% / native size). Optionally compute
 * the auto-fit-to-canvas scale before placing to match menu behavior
 * exactly — defer until requested.
 */

import type { AmEventSpec } from '../../types.js';
import { charID, stringID } from '../../types.js';

export const placeEmbeddedSpec: AmEventSpec = {
  id: 'place/place-embedded',
  displayName: 'Place Embedded image',
  category: 'place',
  emittedBy: ['ps_place_image'],
  snippetRef: 'go-core/cmd/buildtemplates/fragments_documents.go (vault.PlaceImg)',
  groundTruth: {
    capturedAt: '2026-06-03',
    psVersion: '27.7.0',
    platform: 'Windows',
    sourceLog: 'JS-40-Place-Embed.log',
    menuPath: 'File > Place Embedded',
  },
  knownGotchas: [
    'MED SEVERITY: snippet omits `Wdth`/`Hght` percent-scale fields. Without these PS defaults to 100% (native pixel size of the placed image). The captured menu emission scales to fit-to-canvas (69.23% in the capture). For a large stock photo dropped into a small canvas, the snippet behavior diverges from the menu equivalent — placed image will be huge and require manual transform-to-fit. Not silently broken, but UX-divergent.',
    'Fix prescribed by audit: add optional `scale_percent` schema arg (default: omit). When provided, emit `Wdth` and `Hght` as `#Prc` unit doubles. Optionally compute the auto-fit-to-canvas scale before placing — defer until requested.',
    'Snippet omits `Idnt` (layer identifier hint). PS auto-allocates when missing. Not worth adding to the schema.',
    'Snippet omits `replaceLayer` (existing-layer-slot to overwrite). Out of scope for the current "place new image" tool contract.',
    'The `null` slot here is putPath (file path), NOT a reference. This is unusual — most events use null for a class/reference. Plc uses null as the "what to place" payload directly. Built via `desc.putPath(cTID("null"), file)`.',
    'File path must be an absolute filesystem path. Relative paths and URLs are NOT supported. The snippet validates the file exists before dispatch.',
  ],
  versionNotes: [
    "Capture's `Idnt=34` is an arbitrary integer PS allocated for this session — not a stable value. Don't encode it as a constant.",
    'The `FTcs` (Free Transform Center State) enum `QCSt / Qcsa` controls which anchor PS uses for the place transform. `Qcsa` = "quadrant center all" / center-of-bounding-box anchor. The snippet matches the capture exactly here.',
    'Older PS versions (pre-CC 2014) used a different Place event (`PlcS` for "place with smart object wrapping" vs `Plc ` for raw place). Modern PS emits `Plc ` for embedded smart-object placement; the legacy distinction has been collapsed.',
  ],
  events: [
    {
      index: 1,
      event: charID('Plc '),
      comment:
        'Single-event place. The descriptor carries the file path (as null putPath), the free-transform anchor (FTcs), the offset (Ofst object), and — in the captured menu form — width/height percent scale. The snippet emits the path, FTcs, and Ofst but omits Wdth/Hght and Idnt/replaceLayer.',
      descriptor: {
        classID: charID('null'),
        fields: [
          {
            name: 'Identifier hint (auto-allocated; snippet omits)',
            typeID: charID('Idnt'),
            kind: 'integer',
            required: false,
            description:
              'Layer-identifier hint PS uses when placing into an existing slot. For fresh placement PS auto-allocates if missing. Snippet does not emit; PS handles. Capture happened to allocate 34.',
          },
          {
            name: 'null (the file path to place) — putPath, NOT a reference',
            typeID: charID('null'),
            kind: 'data',
            required: true,
            description:
              'The file to place, as an ExtendScript `File` object passed via `desc.putPath(cTID("null"), file)`. Modeled as `kind: data` since it\'s a path putter (not a reference, object, or scalar). Absolute filesystem path; relative paths and URLs not supported.',
          },
          {
            name: 'Free Transform Center State (anchor)',
            typeID: charID('FTcs'),
            kind: 'enum',
            required: true,
            enumType: charID('QCSt'),
            enumValues: [
              {
                typeID: charID('Qcsa'),
                label: 'Center of bounding box',
                context:
                  'The default anchor PS uses when placing — keeps the placed image centered on its own bounding-box center.',
              },
            ],
            description:
              'Which anchor point PS uses for the placement transform. `Qcsa` (center-of-bounding-box) is the default and what the snippet always emits.',
          },
          {
            name: 'Offset (Ofst object with Hrzn/Vrtc in pixels)',
            typeID: charID('Ofst'),
            kind: 'object',
            required: true,
            innerShape: {
              classID: charID('Ofst'),
              fields: [
                {
                  name: 'Horizontal offset in pixels',
                  typeID: charID('Hrzn'),
                  kind: 'unitDouble',
                  required: true,
                  unit: { charID: '#Pxl' },
                  description:
                    "X-axis offset of the placed image's anchor from canvas center, in pixels. Capture shows -310.15 (image landed left-of-center after auto-fit centering).",
                },
                {
                  name: 'Vertical offset in pixels',
                  typeID: charID('Vrtc'),
                  kind: 'unitDouble',
                  required: true,
                  unit: { charID: '#Pxl' },
                  description: 'Y-axis offset in pixels.',
                },
              ],
            },
            description:
              "Where the placed image's anchor lands relative to canvas center. The snippet emits the Hrzn/Vrtc the caller provides; the capture's values are derived from PS's auto-fit centering math.",
          },
          {
            name: 'Width scale (percent — snippet omits, capture emits)',
            typeID: charID('Wdth'),
            kind: 'unitDouble',
            required: false,
            unit: { charID: '#Prc' },
            range: { min: 0.1, max: 1000, default: 100 },
            description:
              'Horizontal scale of the placed image as a percentage of native size. Capture shows 69.23% (auto-fit). When omitted, PS defaults to 100% (native pixel size). The snippet currently omits this — see knownGotchas MED-severity item.',
            gotchas: [
              'Snippet omits this. Default 100% may surprise an LLM placing a large stock photo into a small canvas.',
            ],
          },
          {
            name: 'Height scale (percent — snippet omits, capture emits)',
            typeID: charID('Hght'),
            kind: 'unitDouble',
            required: false,
            unit: { charID: '#Prc' },
            range: { min: 0.1, max: 1000, default: 100 },
            description:
              'Vertical scale of the placed image as a percentage of native size. Typically equal to Wdth for uniform fit. Capture shows 69.23%. Snippet omits — PS defaults to 100%.',
          },
          {
            name: 'replaceLayer (re-place-into-existing-slot — out of scope)',
            typeID: stringID('replaceLayer'),
            kind: 'object',
            required: false,
            description:
              'When provided, PS places the new image INTO an existing layer slot instead of creating a fresh smart-object layer. The inner descriptor carries a `T   ` key with a layer-identifier reference. Out of scope for the current `place_image` tool contract — snippet omits.',
          },
        ],
      },
    },
  ],
};
