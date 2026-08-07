/**
 * Create Group (layer section) — wraps layers into a named layer group.
 *
 * Ground truth: PS 27.7.0 Windows, captured 2026-06-03.
 * Capture log: JS-30-Create-Group.log
 *
 * The user selected two layers and chose Layer > New > Group from Layers
 * (Ctrl+G), accepted the "New Group" dialog defaults (name "Group 1").
 *
 * PS emits a SINGLE `Mk  ` (Make) event creating a `layerSection`
 * (stringID) — the class for a Photoshop layer group. The capture form
 * also carries `layerSectionStart` and `layerSectionEnd` Integer keys
 * that specify the absolute layer-index range to wrap.
 *
 * **Two valid forms — Editmamei uses the simpler one (2026-06-03 audit
 * Group C, STEP 30 — OK, intentional divergence).**
 *
 * 1. **Capture form (wrap existing layers):**
 *    `Mk  ` with target class `layerSection`, sibling keys
 *    `layerSectionStart`/`layerSectionEnd` Integer (absolute layer indices)
 *    plus `Nm  ` String for the group name. Used by the PS menu when the
 *    user has pre-selected layers to group.
 *
 * 2. **Editmamei snippet form (create empty group, then move layers in):**
 *    `Mk  ` with target class `layerSection`, then a `Usng → layerSection{Nm}`
 *    nested descriptor carrying just the name. Creates an EMPTY group above
 *    the active layer. The snippet then does `ltarget.move(newGroup,
 *    ElementPlacement.INSIDE)` per layer name supplied in the tool
 *    `layer_names` parameter.
 *
 * Both forms are well-documented AM idioms. The Editmamei form is
 * semantically equivalent for the tool's documented behavior (create a
 * named group and move named layers into it) and avoids needing to
 * compute absolute layer indices in ExtendScript, which would require
 * walking the document's layer tree first. The `Usng → <class>` pattern
 * matches the same shape used by `Mk AdjL → Usng → Type{...}` for
 * adjustment layers — it's the canonical "make-with-init-descriptor" form.
 */

import type { AmEventSpec } from '../../types.js';
import { charID, stringID } from '../../types.js';

export const createGroupSpec: AmEventSpec = {
  id: 'layer-ops/create-group',
  displayName: 'Create layer group',
  category: 'layer-ops',
  emittedBy: ['ps_create_group'],
  snippetRef:
    'go-core/cmd/buildtemplates/fragments_groups.go (vault.CreateGroup — Mk → layerSection)',
  groundTruth: {
    capturedAt: '2026-06-03',
    psVersion: '27.7.0',
    platform: 'Windows',
    sourceLog: 'JS-30-Create-Group.log',
    menuPath: 'Layer > New > Group from Layers (Ctrl+G)',
  },
  knownGotchas: [
    'The PS menu emits the `layerSectionStart` / `layerSectionEnd` form (wrap an existing layer-index range). The Editmamei snippet uses the `Usng → layerSection{Nm}` form to create an EMPTY group, then moves named layers in via `ltarget.move(newGroup, ElementPlacement.INSIDE)`. Both forms are valid AM idioms; the Editmamei choice is intentional to avoid computing absolute layer indices.',
    'The reference uses `putClass(layerSection)` ONLY — no enumerated `Ordn/Trgt`. This is the standard pattern for `Mk  ` events ("make a new instance of class X").',
    '`layerSection` is a stringID (the modern PS form); older docs sometimes reference a charID equivalent — stick with stringID for the class reference.',
    'The `Nm  ` (Name) charID key in the inner descriptor is what shows up in the Layers panel. If omitted, PS assigns an auto-incrementing default ("Group 1", "Group 2", etc.).',
  ],
  versionNotes: [
    'Capture from PS 27.7.0 Windows; `layerSection` as the group class has been stable across recent PS majors.',
  ],
  events: [
    {
      index: 1,
      event: charID('Mk  '),
      comment:
        'Create a new layer group (layerSection). Two valid descriptor shapes documented below — the Editmamei snippet uses the `Usng → layerSection{Nm}` form; the menu capture uses the `layerSectionStart`/`layerSectionEnd` + `Nm  ` siblings form.',
      descriptor: {
        classID: charID('null'),
        fields: [
          {
            name: 'target (class reference to layerSection)',
            typeID: charID('null'),
            kind: 'reference',
            required: true,
            referenceShape: {
              classID: stringID('layerSection'),
              variant: 'class',
            },
            description:
              'putClass(stringIDToTypeID("layerSection")). The "Make a new layer group" reference.',
          },
          {
            name: 'Using (the layerSection init descriptor — Editmamei snippet form)',
            typeID: charID('Usng'),
            kind: 'object',
            required: false,
            innerShape: {
              classID: stringID('layerSection'),
              fields: [
                {
                  name: 'Name',
                  typeID: charID('Nm  '),
                  kind: 'string',
                  required: true,
                  description: 'The group name shown in the Layers panel.',
                },
              ],
            },
            description:
              'The Editmamei snippet form. Creates an empty group with just a name; the snippet then moves layers in via DOM `ltarget.move(newGroup, ElementPlacement.INSIDE)`. Mutually exclusive with the `layerSectionStart`/`layerSectionEnd` form below.',
          },
          {
            name: 'Layer Section Start (menu-capture form)',
            typeID: stringID('layerSectionStart'),
            kind: 'integer',
            required: false,
            range: { min: 0 },
            description:
              'Absolute layer index marking the bottom of the range to wrap (menu form only). Mutually exclusive with the `Usng → layerSection{Nm}` form above.',
            gotchas: [
              "Integer indices count Photoshop layers in the document's absolute order — requires walking the layer tree to compute. The Editmamei snippet avoids this by using the empty-group + move pattern.",
            ],
          },
          {
            name: 'Layer Section End (menu-capture form)',
            typeID: stringID('layerSectionEnd'),
            kind: 'integer',
            required: false,
            range: { min: 0 },
            description:
              'Absolute layer index marking the top of the range to wrap (menu form only). Mutually exclusive with the `Usng → layerSection{Nm}` form above.',
          },
          {
            name: 'Name (menu-capture form)',
            typeID: charID('Nm  '),
            kind: 'string',
            required: false,
            description:
              'Group name (menu form only). Sits as a sibling of `layerSectionStart`/`End` at the top level of the Mk descriptor. The Editmamei snippet puts the name inside the `Usng → layerSection` inner descriptor instead.',
          },
        ],
      },
    },
  ],
};
