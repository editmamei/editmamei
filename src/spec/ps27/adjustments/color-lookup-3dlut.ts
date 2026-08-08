/**
 * Color Lookup adjustment layer — 3DLUT (cube/3DL/look files).
 *
 * Ground truth: PS 27.7.0 Windows, captured 2026-06-03.
 * Capture log: JS-18-Color-Lookup-3DLUT.log
 *
 * The user opened a fresh PS doc, clicked Layer > New Adjustment Layer >
 * Color Lookup, accepted the dialog (creates empty layer), then in the
 * Properties panel chose a 3DLUT preset (e.g. HorrorBlue.3DL).
 *
 * Two events:
 *   1. Mk: `using.putClass(Type, colorLookup)` — **no inner descriptor**,
 *      the canonical PS shape for adjustment layers that own a file-
 *      resource (Invert uses the same pattern; see invert.ts).
 *   2. setd: `T → colorLookup → { lookupType=3DLUT enum, Nm  = absolute
 *      path to the .3DL file, profile = putData binary blob (parsed
 *      from the file by PS\'s native code), LUTFormat = LUTFormat3DL
 *      enum, LUT3DFileData = putData binary blob of the raw .3DL bytes }`.
 *
 * **Known irreparable limitation**: The `profile` putData binary is
 * parsed from the .3DL/.cube/.look file by Photoshop\'s C++ ADBE-linker
 * code BEFORE the setd dispatches.
 * That parser has NO JavaScript / ExtendScript entry point. Therefore
 * Editmamei CANNOT emit the setd from a snippet — only the Mk creates
 * an empty Color Lookup layer; the LLM/user must apply the LUT via a
 * pre-recorded PS Action invoked through `ps_play_action`.
 *
 * The snippet handles this by validating the LUT file exists, creating
 * the empty layer, and emitting guidance — explicitly NOT emitting a
 * broken setd. Verdict: OK by design.
 */

import type { AmEventSpec } from '../../types.js';
import { charID, stringID } from '../../types.js';

export const colorLookup3DLUTSpec: AmEventSpec = {
  id: 'adjustments/color-lookup-3dlut',
  displayName: 'Color Lookup adjustment layer (3DLUT)',
  category: 'adjustments',
  emittedBy: ['ps_add_adjustment_layer'],
  snippetRef:
    'go-core/cmd/buildtemplates/fragments_adjustments_types.go (vault.AdjCLTd — 3DLUT path-resolution)',
  groundTruth: {
    capturedAt: '2026-06-03',
    psVersion: '27.7.0',
    platform: 'Windows',
    sourceLog: 'JS-18-Color-Lookup-3DLUT.log',
    menuPath: 'Layer > New Adjustment Layer > Color Lookup (3DLUT preset)',
  },
  knownGotchas: [
    "CRITICAL irreparable scripting limitation: The `profile` putData binary is parsed from the LUT file by PS's C++ code BEFORE the setd. There is NO JavaScript path to that parse. Editmamei CANNOT emit the setd — only creates the empty Mk layer and points the LLM to play_action.",
    'Mk shape: `using.putClass(Type, colorLookup)` with **NO inner descriptor**. NOT putObject. The same shape as Invert (see invert.ts). Calling putObject with a typeDesc{presetKindDefault} also works on PS 27 but is the wrong canonical shape — the audit flagged a similar mismatch on Invert.',
    'setd `lookupType` enum values: `3DLUT`, `abstractProfile`, `deviceLinkProfile`. Only 3DLUT is verifiable end-to-end from the JS side (and even then, only through play_action, not direct scripting).',
    "`Nm  ` (charID with two trailing spaces) holds the LUT file's ABSOLUTE path as a string. Required by PS for the setd to apply.",
    "`profile` putData is the parsed ICC-like profile binary — the load-bearing field. Bytes come from PS's native parse, not from Editmamei.",
    '`LUTFormat` enum (`LUTFormat3DL`/`LUTFormatCUBE`/`LUTFormatLook`) signals the source file format. PS emits when the format is unambiguous.',
    '`LUT3DFileData` is the raw bytes of the original .3DL/.cube/.look file (PS keeps a copy for re-application after document round-trip). PS emits as putData blob.',
  ],
  versionNotes: [
    'The C++ profile-parsing limitation has been present since Color Lookup landed in PS CS6. No JS hook has been added in any subsequent PS major version.',
    'PS 25+ added the LUT3DFileData round-trip blob; older PS could lose the LUT on save/reopen.',
  ],
  events: [
    {
      index: 1,
      event: charID('Mk  '),
      comment:
        'Creates the empty Color Lookup adjustment layer. CANONICAL SHAPE: putClass(Type, colorLookup) with no inner descriptor. Snippet validates the LUT file exists before emitting, then emits guidance after.',
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
                  name: 'Type — putClass(colorLookup), NO inner descriptor',
                  typeID: charID('Type'),
                  kind: 'class',
                  required: true,
                  description:
                    "putClass(Type, sTID('colorLookup')) only. No nested descriptor. Same shape as Invert.",
                },
              ],
            },
          },
        ],
      },
    },
    {
      index: 2,
      event: charID('setd'),
      comment:
        "Applies the LUT. EDITMAMEI CANNOT EMIT THIS — the `profile` binary requires PS's native parse of the LUT file, which has no JS entry point. Documented for completeness; snippet emits guidance pointing to play_action instead.",
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
            name: 'T (the colorLookup values descriptor)',
            typeID: charID('T   '),
            kind: 'object',
            required: true,
            innerShape: {
              classID: stringID('colorLookup'),
              fields: [
                {
                  name: 'lookupType',
                  typeID: stringID('lookupType'),
                  kind: 'enum',
                  required: true,
                  enumType: stringID('colorLookupType'),
                  enumValues: [
                    { typeID: stringID('3DLUT'), label: '3D LUT (.3DL/.cube/.look)' },
                    { typeID: stringID('abstractProfile'), label: 'Abstract profile' },
                    { typeID: stringID('deviceLinkProfile'), label: 'Device link profile' },
                  ],
                },
                {
                  name: 'LUT file path (absolute)',
                  typeID: charID('Nm  '),
                  kind: 'string',
                  required: true,
                  description: 'Absolute filesystem path to the LUT file PS parsed.',
                },
                {
                  name: 'Profile binary (ICC-like, parsed by PS native code)',
                  typeID: stringID('profile'),
                  kind: 'data',
                  required: true,
                  description:
                    'LOAD-BEARING binary blob. PS parses the LUT file natively and stores the linker profile here. NO JavaScript path to this parse — this is why the setd is unemittable from Editmamei. Bytes are NOT inlined in the spec; the field describes the slot.',
                },
                {
                  name: 'LUT source format',
                  typeID: stringID('LUTFormat'),
                  kind: 'enum',
                  required: false,
                  enumType: stringID('LUTFormatType'),
                  enumValues: [
                    { typeID: stringID('LUTFormat3DL') },
                    { typeID: stringID('LUTFormatCUBE') },
                    { typeID: stringID('LUTFormatLook') },
                  ],
                },
                {
                  name: 'LUT file raw bytes (round-trip preservation)',
                  typeID: stringID('LUT3DFileData'),
                  kind: 'data',
                  required: false,
                  description:
                    'Raw bytes of the .3DL/.cube/.look file. PS keeps a copy so the LUT survives document save/reopen. Bytes NOT inlined in spec.',
                },
              ],
            },
          },
        ],
      },
    },
  ],
};
