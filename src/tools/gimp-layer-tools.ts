import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import type { GimpBackend } from '../backends/gimp/backend.js';
import { validateArgs, type JsonSchemaObject } from '../utils/validate.js';
import { toolGimpErrorResult, unknownDiscriminator } from '../utils/tool-helpers.js';
import { GIMP_IMAGE_PROP, GIMP_LAYER_PROP, pickSchemaDeclaredKeys } from './gimp-shared.js';

/**
 * gimp_layer / gimp_bake — first-class multi-layer documents. `gimp_group` (a separately floated
 * tool) is folded into `gimp_layer` as `create_group` + `reorder`'s `parent_group`: nothing a
 * dedicated group tool would do isn't already covered here.
 *
 * Addressing: `layer_id` (canonical — an id from gimp_inspect or a prior gimp_layer/gimp_bake
 * result) takes priority over `layer` (name, searched inside groups too, but GIMP allows duplicate
 * names so it cannot always tell two apart); neither given falls back to the selected layer, or
 * the topmost layer if none is selected — `bridge/ops.py`'s `_layer`.
 *
 * Every sub-op except `select` changes pixels or layer structure and therefore drops the preview
 * proxy cache (`bridge/ops.py`'s `_drop_proxies`, now documented as the general invariant rather
 * than "only non-destructive filters change pixels").
 */

const LAYER_OPS = [
  'create',
  'create_group',
  'delete',
  'duplicate',
  'select',
  'set',
  'move',
  'reorder',
  'merge_down',
  'flatten',
] as const;

const layerSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    image: GIMP_IMAGE_PROP,
    op: {
      type: 'string',
      enum: [...LAYER_OPS],
      description:
        "'create' adds a new, empty layer (width/height default to the image size; fill " +
        "white/black/transparent, default transparent). 'create_group' adds a group layer (a " +
        "folder for other layers) — this is gimp_group, folded in here. 'delete' removes a layer " +
        '(a group takes its children with it) and prunes any of its filters from the ledger. ' +
        "'duplicate' copies a layer, inserted directly above the source — REFUSED when the layer " +
        '(or, for a group, any descendant) carries an Editmamei filter: GIMP has no way to rename ' +
        "a copied filter in this build, and the ledger is keyed by filter name, so the copy's " +
        "filter would silently rewrite the original's own record the next time either is " +
        "re-edited. Bake it first (gimp_bake) or delete it, then duplicate. 'select' sets the " +
        'active layer (the default target for gimp_add_adjustment and friends when no layer is ' +
        "named) and is the one sub-op that changes nothing else. 'set' changes opacity, mode, " +
        'visible, and/or name (at least one required) — mode is a blend mode from a fixed list, ' +
        "not a raw GEGL/GIMP name. 'move' repositions a layer to an ABSOLUTE x/y (not a delta) — " +
        'REFUSED when the layer carries a masked or unverifiable adjustment filter: a ' +
        "filter's mask is a fixed confinement that does not travel with the layer when it moves " +
        "(verified live), so moving first would silently misalign it. 'reorder' changes a " +
        "layer's stack position and/or moves it into a group (parent_group) or out to top-level " +
        '(to_top_level: true) — neither given keeps the layer in its current group and only ' +
        "changes `position`. 'merge_down' bakes ONE layer's live filters (masked ones included — " +
        'verified live that a masked filter renders correctly through the merge) into pixels and ' +
        'merges it into the layer directly below it in the same group/level; text layers are ' +
        "rasterized in the process (reported as rasterized_text). 'flatten' collapses the WHOLE " +
        'image into a single layer the same way, and always drops alpha (reported as has_alpha: ' +
        'false) — say so before relying on transparency afterward.',
    },
    layer: {
      ...GIMP_LAYER_PROP,
      description:
        (GIMP_LAYER_PROP.description ?? '') +
        ' Ignored when layer_id is given. Not used by create, create_group, or flatten.',
    },
    layer_id: {
      type: 'integer',
      description:
        'Canonical layer id (from gimp_inspect or a prior gimp_layer/gimp_bake result) — takes ' +
        'priority over `layer` (name) when both are given, and is the only way to address two ' +
        'layers that happen to share a name. Not used by create, create_group, or flatten.',
    },
    name: {
      type: 'string',
      description:
        "create/create_group: the new layer's name (default 'Layer'/'Group'). set: renames the " +
        'target layer. Every case enforces a unique name, suffixing " 2", " 3", ... if the name ' +
        'is already taken (GIMP itself allows duplicates; this tool does not).',
    },
    width: {
      type: 'integer',
      minimum: 1,
      description: 'create only. Defaults to the image width.',
    },
    height: {
      type: 'integer',
      minimum: 1,
      description: 'create only. Defaults to the image height.',
    },
    fill: {
      type: 'string',
      enum: ['white', 'black', 'transparent'],
      default: 'transparent',
      description: "create only. The new layer's initial content.",
    },
    parent_group: {
      type: 'integer',
      description:
        'create/create_group: the group layer_id to insert the new layer into (omit for ' +
        'top-level). reorder: the group layer_id to move the layer into. Must itself be a group, ' +
        'and cannot be the layer being moved or one of its own descendants. Omit (leaving the ' +
        'layer in its current group) or use to_top_level instead to move it OUT of a group — ' +
        'there is no way to pass "no group" through this field itself.',
    },
    to_top_level: {
      type: 'boolean',
      default: false,
      description:
        'reorder only. Moves the layer to the top level, out of whatever group (if any) it is ' +
        'currently in. Takes priority over parent_group if both are given.',
    },
    position: {
      type: 'integer',
      minimum: 0,
      default: 0,
      description:
        "create/create_group/reorder: index within the target parent's (or top-level) stack, " +
        '0 = topmost.',
    },
    opacity: {
      type: 'number',
      minimum: 0,
      maximum: 100,
      description: 'set only.',
    },
    mode: {
      type: 'string',
      enum: [
        'normal',
        'multiply',
        'screen',
        'overlay',
        'soft_light',
        'hard_light',
        'darken',
        'lighten',
        'difference',
        'exclusion',
        'addition',
        'subtract',
        'divide',
        'dodge',
        'burn',
        'hue',
        'saturation',
        'color',
        'luminosity',
      ],
      description: 'set only. A fixed blend-mode list, not a raw GEGL/GIMP mode name.',
    },
    visible: {
      type: 'boolean',
      description: 'set only.',
    },
    x: {
      type: 'number',
      description:
        "move only. The layer's new ABSOLUTE horizontal offset in document pixels (not a delta).",
    },
    y: {
      type: 'number',
      description:
        "move only. The layer's new ABSOLUTE vertical offset in document pixels (not a delta).",
    },
  },
  required: ['image', 'op'],
};

function layerSuccessText(op: string, result: Record<string, unknown>): string {
  switch (op) {
    case 'create':
      return `Created layer ${result.layer_id} ("${result.name as string}").`;
    case 'create_group':
      return `Created group ${result.layer_id} ("${result.name as string}").`;
    case 'delete':
      return `Deleted layer ${result.layer_id} ("${result.name as string}").`;
    case 'duplicate':
      return `Duplicated as layer ${result.layer_id} ("${result.name as string}").`;
    case 'select':
      return `Selected layer ${result.layer_id} ("${result.name as string}").`;
    case 'move':
      return `Moved layer ${result.layer_id} to (${result.x as number}, ${result.y as number}).`;
    case 'reorder':
      return (
        `Reordered layer ${result.layer_id}` +
        (result.parent_group != null
          ? ` into group ${result.parent_group as number}.`
          : ' to top-level.')
      );
    case 'merge_down':
      return (
        `Merged down into layer ${result.layer_id} ("${result.name as string}").` +
        (result.rasterized_text ? ' A text layer was rasterized in the process.' : '')
      );
    case 'flatten':
      return (
        `Flattened to a single layer ${result.layer_id} ("${result.name as string}"), alpha dropped.` +
        (result.rasterized_text ? ' A text layer was rasterized in the process.' : '')
      );
    default: {
      // 'set'
      const changed = Object.keys(result).filter((k) => k !== 'layer_id' && k !== 'name');
      return `Layer ${result.layer_id} ("${result.name as string}") updated: ${changed.join(', ')}.`;
    }
  }
}

/**
 * `validateArgs` collapses an explicit `null` down to "absent" (see its own doc comment: a raw
 * value of `undefined` OR `null` skips straight to the field's default, if any) — so a caller
 * cannot signal "parent_group: null, meaning top-level" through the schema the way `bridge/ops.py`
 * itself would read it. `to_top_level: true` is the tri-state escape hatch: reorder only, and
 * translated HERE into the literal `parent_group: null` the bridge's own `'parent_group' in args`
 * check expects, rather than exposed to the bridge as its own field.
 */
function layerBridgeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const picked = pickSchemaDeclaredKeys(layerSchema, args);
  if (args.op === 'reorder' && args.to_top_level === true) {
    picked.parent_group = null;
  }
  delete picked.to_top_level;
  return picked;
}

async function gimpLayer(gimp: GimpBackend, rawArgs: Record<string, unknown>): Promise<ToolResult> {
  try {
    const args = validateArgs(layerSchema, rawArgs);
    const op = args.op as string;
    // Unreachable while the schema's own enum stands (validateArgs already refused anything
    // outside it) — kept as defense-in-depth, the same posture every other consolidated
    // dispatcher in this file family takes.
    if (!LAYER_OPS.includes(op as (typeof LAYER_OPS)[number])) {
      return unknownDiscriminator('op', op, LAYER_OPS);
    }
    const result = await gimp.call<Record<string, unknown>>('layer', layerBridgeArgs(args));
    return {
      content: [{ type: 'text' as const, text: layerSuccessText(op, result) }],
      structuredContent: result,
    };
  } catch (error) {
    return toolGimpErrorResult('Error managing GIMP layer', error);
  }
}

const bakeSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    image: GIMP_IMAGE_PROP,
    layer: {
      ...GIMP_LAYER_PROP,
      description: (GIMP_LAYER_PROP.description ?? '') + ' Ignored when layer_id or all is given.',
    },
    layer_id: {
      type: 'integer',
      description: 'Canonical layer id. Takes priority over `layer`. Ignored when `all` is given.',
    },
    all: {
      type: 'boolean',
      default: false,
      description:
        'Bake every layer on the image that has any live filter, instead of just one. Group ' +
        'layers themselves are always skipped (GIMP cannot merge filters on a group item; only ' +
        'the ordinary layers inside one ever carry filters).',
    },
  },
  required: ['image'],
};

async function gimpBake(gimp: GimpBackend, rawArgs: Record<string, unknown>): Promise<ToolResult> {
  try {
    const args = validateArgs(bakeSchema, rawArgs);
    const result = await gimp.call<Record<string, unknown>>(
      'bake',
      pickSchemaDeclaredKeys(bakeSchema, args)
    );
    let text: string;
    if (args.all) {
      const baked = (result.baked_layers as Array<{ name: string }> | undefined) ?? [];
      text =
        baked.length > 0
          ? `Baked ${baked.length} layer(s): ${baked.map((l) => l.name).join(', ')}.`
          : 'No layer had a live filter to bake.';
    } else {
      text = result.baked
        ? `Baked every filter on layer ${result.layer_id} ("${result.name as string}") into its pixels.`
        : `Layer ${result.layer_id} ("${result.name as string}") had no live filter to bake.`;
    }
    return {
      content: [{ type: 'text' as const, text }],
      structuredContent: result,
    };
  } catch (error) {
    return toolGimpErrorResult('Error baking GIMP filters', error);
  }
}

export function createGimpLayerTools(gimp: GimpBackend): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'gimp_layer',
        description:
          'Headless GIMP: layer management. op: create | create_group | delete | duplicate | ' +
          'select | set | move | reorder | merge_down | flatten (gimp_group is folded in as ' +
          "create_group + reorder's parent_group). Addressed by layer_id (canonical — an id from " +
          'gimp_inspect or a prior gimp_layer/gimp_bake result) or layer (name; GIMP allows ' +
          'duplicate names, so layer_id is the only handle that always tells two apart). Every ' +
          'op except select changes pixels or layer structure, and there is no undo in this ' +
          'session: gimp_checkpoint or gimp_save_xcf first when in doubt. duplicate REFUSES ' +
          'outright when the layer (or, for a group, any descendant) carries an Editmamei ' +
          'filter — DrawableFilter.set_name does not exist in this GIMP build, so a copied ' +
          "filter's name collides with the original's own ledger record; bake it first " +
          '(gimp_bake) or delete it, then duplicate. move takes an ABSOLUTE x/y (not a delta) and ' +
          'REFUSES when the layer carries a masked or unverifiable adjustment filter — a ' +
          "filter's mask does not travel with the layer when it moves (verified live), the same " +
          'physics gimp_transform_canvas refuses on. merge_down and flatten both bake every live ' +
          'filter they touch into pixels first (masked filters included — verified correct through ' +
          'the merge) and rasterize any text layer in the process (rasterized_text); flatten ' +
          'always drops alpha (has_alpha: false).',
        inputSchema: layerSchema,
        outputSchema: {
          type: 'object',
          properties: {
            layer_id: { type: 'number' },
            name: { type: 'string' },
            is_group: { type: 'boolean' },
            deleted: { type: 'boolean' },
            opacity: { type: 'number' },
            mode: { type: 'string' },
            visible: { type: 'boolean' },
            x: { type: ['number', 'null'] },
            y: { type: ['number', 'null'] },
            parent_group: { type: ['number', 'null'] },
            rasterized_text: { type: 'boolean' },
            has_alpha: { type: 'boolean' },
          },
        },
        annotations: {
          title: 'Manage GIMP Layer',
          readOnlyHint: false,
          destructiveHint: true, // delete/merge_down/flatten permanently remove layers or bake filters with no undo
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      handler: async (args) => gimpLayer(gimp, args),
    },
    {
      tool: {
        name: 'gimp_bake',
        description:
          "Headless GIMP: bake a layer's live filters into its own pixels (Drawable.merge_" +
          'filters()) without merging it into anything else — the layer survives as itself, just ' +
          "with no more re-editable filters. Verified live that a MASKED filter's confinement " +
          'survives the bake exactly. Baking clears any masked-filter refusal (gimp_layer ' +
          'op=move, gimp_resize_image, gimp_transform_canvas) that filter would otherwise trigger ' +
          '— it is the sanctioned way to make a masked adjustment safe to move, resize, rotate, or ' +
          'flip around. all: true bakes every ordinary layer with a live filter at once; group ' +
          'layers are always skipped (GIMP cannot merge filters on a group item). IRREVERSIBLE in ' +
          'this session: there is no undo, so gimp_checkpoint or gimp_save_xcf first when in doubt.',
        inputSchema: bakeSchema,
        outputSchema: {
          type: 'object',
          properties: {
            layer_id: { type: 'number' },
            name: { type: 'string' },
            baked: { type: 'boolean' },
            baked_layers: {
              type: 'array',
              items: {
                type: 'object',
                properties: { layer_id: { type: 'number' }, name: { type: 'string' } },
              },
            },
          },
        },
        annotations: {
          title: 'Bake GIMP Layer Filters',
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true, // baking an already-baked layer (no live filters) is a no-op, reported as baked: false
          openWorldHint: true,
        },
      },
      handler: async (args) => gimpBake(gimp, args),
    },
  ];
}
