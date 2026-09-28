import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import type { GimpBackend } from '../backends/gimp/backend.js';
import { validateArgs, type JsonSchemaObject } from '../utils/validate.js';
import { toolGimpErrorResult, unknownDiscriminator } from '../utils/tool-helpers.js';
import { GIMP_IMAGE_PROP, GIMP_LAYER_PROP, pickSchemaDeclaredKeys } from './gimp-shared.js';

/**
 * gimp_layer / gimp_bake — first-class multi-layer documents. A group is just another kind of
 * layer here: `create_group` + `reorder`'s `parent_group`/`to_top_level` are the whole group
 * story, no separate tool.
 *
 * Addressing: `layer_id` (canonical — an id from gimp_inspect or a prior gimp_layer/gimp_bake
 * result) takes priority over `layer` (name, searched inside groups too, but GIMP allows duplicate
 * names so it cannot always tell two apart); neither given falls back to the selected layer, or
 * the topmost layer if none is selected — `bridge/ops.py`'s `_layer`.
 *
 * Every sub-op except `select` changes pixels or layer structure and therefore drops the preview
 * proxy cache (`bridge/ops.py`'s `_drop_proxies`, the general invariant every structural op
 * follows, not just a non-destructive filter).
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
        "'create' adds a new, empty layer (width/height default to the image size, capped the " +
        "same way gimp_resize_image's target is; fill white/black/transparent, default " +
        "transparent). 'create_group' adds a group layer (a folder for other layers). 'delete' " +
        'removes a layer (a group takes its children with it) and prunes any of its filters from ' +
        "the ledger — REFUSED if it is or contains the image's only remaining layer. 'duplicate' " +
        'copies a layer, inserted directly above the source — REFUSED when the layer (or, for a ' +
        "group, any descendant) carries an Editmamei filter, since the copy's filter would collide " +
        "with the original's own ledger record. 'select' sets the active layer (the default " +
        'target for gimp_add_adjustment and friends when no layer is named) and is the one sub-op ' +
        "that changes nothing else. 'set' changes opacity, mode, visible, and/or name (at least " +
        'one required, name may not be empty) — mode is a blend mode from a fixed list, not a raw ' +
        "GEGL/GIMP name. 'move' repositions a layer to an ABSOLUTE x/y (not a delta), bounded to " +
        'stay near the canvas — REFUSED when the layer, or a group containing it, carries a ' +
        "masked or unverifiable adjustment filter, since a filter's mask does not travel with " +
        "content that moves beneath it. 'reorder' " +
        "changes a layer's stack position and/or moves it into a group (parent_group) or out to " +
        'top-level (to_top_level: true) — neither given keeps the layer in its current group and ' +
        'only changes `position`; REFUSED if parent_group would nest a group inside itself or one ' +
        "of its own descendants. 'merge_down' bakes ONE layer's live filters (masked ones " +
        'included) into pixels and merges it into the first VISIBLE layer below it in the same ' +
        'group/level — REFUSED if the SOURCE layer itself is hidden (GIMP cannot merge a hidden ' +
        'layer down), if that target would be a group, if there is no visible layer below (a ' +
        'hidden one in between is skipped, not merged), or if the merged result would exceed the ' +
        'same size cap gimp_resize_image enforces; a visible text layer involved is ' +
        "rasterized (reported as rasterized_text). 'flatten' collapses the WHOLE image into a " +
        'single layer the same way, always drops alpha (reported as has_alpha: false), and ' +
        'REFUSES by default when any layer is hidden, INCLUDING a layer whose own visibility is ' +
        'on but sits inside a hidden group (GIMP discards a hidden layer outright rather than ' +
        'compositing it in) unless discard_hidden: true is given.',
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
        'target layer; may not be empty. Every case enforces a unique name, suffixing " 2", " 3", ' +
        '... if the name is already taken (GIMP itself allows duplicates; this tool does not).',
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
      type: 'integer',
      description:
        "move only. The layer's new ABSOLUTE horizontal offset in document pixels (not a delta).",
    },
    y: {
      type: 'integer',
      description:
        "move only. The layer's new ABSOLUTE vertical offset in document pixels (not a delta).",
    },
    discard_hidden: {
      type: 'boolean',
      default: false,
      description:
        'flatten only. Without it, flatten REFUSES when any layer is hidden (naming them) rather ' +
        'than silently discarding them — pass true to proceed; the discarded layers are reported ' +
        'back as discarded_hidden_layers.',
    },
  },
  required: ['image', 'op'],
};

interface DiscardedLayer {
  layer_id: number;
  name: string;
}

function layerSuccessText(
  op: string,
  result: Record<string, unknown>,
  args: Record<string, unknown>
): string {
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
        (result.rasterized_text ? ' A visible text layer was rasterized in the process.' : '')
      );
    case 'flatten': {
      const discarded = (result.discarded_hidden_layers as DiscardedLayer[] | undefined) ?? [];
      return (
        `Flattened to a single layer ${result.layer_id} ("${result.name as string}"), alpha dropped.` +
        (result.rasterized_text ? ' A visible text layer was rasterized in the process.' : '') +
        (discarded.length > 0
          ? ` Discarded ${discarded.length} hidden layer(s): ${discarded.map((l) => l.name).join(', ')}.`
          : '')
      );
    }
    default: {
      // 'set' -- `result` always carries `name` as the layer's own current identifier, so a
      // rename can't be told apart from an untouched name by diffing result's own keys. Reading
      // which of opacity/mode/visible/name the caller actually passed reports a name-only set as
      // "updated: name.", not "updated: .".
      const changed = (['opacity', 'mode', 'visible', 'name'] as const).filter((k) => k in args);
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
      content: [{ type: 'text' as const, text: layerSuccessText(op, result, args) }],
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
        'Bake every layer on the image that has any live filter, instead of just one. A group ' +
        'layer is always skipped even when it carries its own filter (GIMP cannot merge filters ' +
        'on a group item) — any such group is reported under skipped_groups_with_filters rather ' +
        'than silently ignored.',
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
      const skipped =
        (result.skipped_groups_with_filters as Array<{ name: string }> | undefined) ?? [];
      text =
        baked.length > 0
          ? `Baked ${baked.length} layer(s): ${baked.map((l) => l.name).join(', ')}.`
          : 'No layer had a live filter to bake.';
      if (skipped.length > 0) {
        text += ` Skipped ${skipped.length} group(s) that carry a filter GIMP cannot bake: ${skipped.map((l) => l.name).join(', ')}.`;
      }
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
          'select | set | move | reorder | merge_down | flatten (a group is created, addressed, ' +
          'and reordered the same as any other layer — there is no separate group tool). ' +
          'Addressed by layer_id (canonical — an id from gimp_inspect or a prior gimp_layer/' +
          'gimp_bake result) or layer (name; GIMP allows duplicate names, so layer_id is the only ' +
          'handle that always tells two apart). Every op except select changes pixels or layer ' +
          'structure, and there is no undo in this session: gimp_checkpoint or gimp_save_xcf ' +
          'first when in doubt. duplicate REFUSES outright when the layer (or, for a group, any ' +
          "descendant) carries an Editmamei filter, since the copy's filter would collide with " +
          "the original's own ledger record; bake it first (gimp_bake) or delete it, then " +
          'duplicate. move takes an ABSOLUTE x/y (not a delta) and REFUSES when the layer, or ' +
          'a group containing it, carries a masked or unverifiable adjustment filter — a ' +
          "filter's mask does not travel with content that moves beneath it, the same physics " +
          'gimp_transform_canvas refuses on. merge_down REFUSES outright when the SOURCE layer ' +
          'itself is hidden (GIMP cannot merge a hidden layer down); it and ' +
          'flatten both bake every live filter they touch into pixels first (masked filters ' +
          'included) and rasterize any VISIBLE text layer in the process (rasterized_text); ' +
          'flatten always drops alpha (has_alpha: false) and, by default, REFUSES outright when ' +
          'any layer is hidden — INCLUDING one whose own visibility is on but sits inside a ' +
          'hidden group — rather than silently discarding it (discard_hidden: true proceeds and ' +
          'reports what was discarded).',
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
            discarded_hidden_layers: {
              type: 'array',
              items: {
                type: 'object',
                properties: { layer_id: { type: 'number' }, name: { type: 'string' } },
              },
            },
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
          "Headless GIMP: bake a layer's live filters into its own pixels without merging it " +
          'into anything else — the layer survives as itself, just with no more re-editable ' +
          'filters; a text layer stays a text layer (baking never rasterizes one). A masked ' +
          "filter's confinement survives the bake exactly. Defaults to the selected layer, or the " +
          'topmost layer if none is selected, the same as any other gimp_layer addressing. Baking ' +
          'clears any masked-filter refusal (gimp_layer op=move, gimp_canvas, gimp_resize_image, ' +
          'gimp_transform_canvas) that filter would otherwise trigger — it is the sanctioned way ' +
          'to make a masked adjustment safe to move, resize, rotate, or flip around. all: true ' +
          'bakes every ordinary layer with a live filter at once; a group layer is always skipped, ' +
          'even one that carries its own filter (GIMP cannot merge filters on a group item) — ' +
          'reported under skipped_groups_with_filters rather than silently ignored. Targeting a ' +
          'group directly (layer/layer_id) is refused outright. IRREVERSIBLE in this session: ' +
          'there is no undo, so gimp_checkpoint or gimp_save_xcf first when in doubt.',
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
            skipped_groups_with_filters: {
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
