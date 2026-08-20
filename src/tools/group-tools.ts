import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import type { SnippetClient } from '../api/snippet-client.js';
import { runScript } from '../utils/run-script.js';
import { GROUP_BLEND_MODES } from '../utils/blend-modes.js';
import { validateArgs, type JsonSchemaObject } from '../utils/validate.js';
import { toolErrorResult, runSnippetTool, unknownDiscriminator } from '../utils/tool-helpers.js';

// ---------- Schemas ----------

const deleteGroupSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description: 'Name of the group to delete (recursive search).',
    },
    confirm: {
      type: 'boolean',
      description:
        'Must be true to actually delete — guards against accidental loss of all contained layers.',
    },
  },
  required: ['name', 'confirm'],
};

const createGroupSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description: 'Name for the new group.',
    },
    layers: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Optional list of existing layer names to move into the new group. The first listed name ends up on top of the group stack. Layers not found are returned in `not_found`.',
    },
    into_active_group: {
      type: 'boolean',
      description:
        "Photoshop's Mk-layerSection descriptor carries no placement target, so with a GROUP active it would natively nest the new group INSIDE that group. Default false hoists the new group back out so it lands above the active layer/group as a sibling, matching this tool's documented placement. Pass true to keep it nested inside the active group instead.",
      default: false,
    },
  },
  required: ['name'],
};

const moveLayerToGroupSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    layer_name: {
      type: 'string',
      description: 'Name of the layer to move (recursive search).',
    },
    group_name: {
      type: 'string',
      description: 'Name of the destination group (recursive search).',
    },
  },
  required: ['layer_name', 'group_name'],
};

const setGroupBlendModeSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description: 'Group name (recursive search).',
    },
    blend_mode: {
      type: 'string',
      enum: [...GROUP_BLEND_MODES],
      description:
        'Blend mode (Photoshop ExtendScript BlendMode enum). PASSTHROUGH (default for new groups) lets adjustments inside the group affect the layers below the group; NORMAL treats the group as a single composite (use this when applying one mask to a stack of adjustments). Use COLORBLEND for the "Color" blend mode.',
    },
  },
  required: ['name', 'blend_mode'],
};

const ungroupSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description: 'Group name to dissolve (recursive search).',
    },
    confirm: {
      type: 'boolean',
      description:
        'Must be true. Dissolving a group is recoverable only via Edit > Undo and changes the layer stack structure.',
    },
  },
  required: ['name', 'confirm'],
};

const CLIPPING_MASK_OPS = ['create', 'release'] as const;

const clippingMaskSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    op: {
      type: 'string',
      enum: [...CLIPPING_MASK_OPS],
      description:
        'create: clip the active layer to the layer directly below it (that layer becomes the alpha source); no-ops (already_clipped:true) when the layer is already clipped. ' +
        'release: release the active layer from its clipping mask; no-ops (released:false) when the layer is not clipped.',
    },
  },
  required: ['op'],
};

// Both ops are param-free once the discriminator is stripped by the dispatcher.
const clippingMaskOpArgsSchema: JsonSchemaObject = {
  type: 'object',
  properties: {},
};

const GROUP_OPS = ['create', 'delete', 'ungroup', 'add_layer', 'set_blend_mode'] as const;

// The schema each op re-validates against once the discriminator is stripped.
// Exported so a test can assert GROUP_INPUT_SCHEMA below is a superset of all
// five: a param that only the per-op schema knows about is a param the caller
// cannot see in tools/list, and the call fails validation on a field nothing
// advertised.
export const GROUP_OP_SCHEMAS: Record<(typeof GROUP_OPS)[number], JsonSchemaObject> = {
  create: createGroupSchema,
  delete: deleteGroupSchema,
  ungroup: ungroupSchema,
  add_layer: moveLayerToGroupSchema,
  set_blend_mode: setGroupBlendModeSchema,
};

// Consolidated input schema for ps_group (2026-08-13). Merges the five
// per-op schemas above (createGroupSchema, deleteGroupSchema, ungroupSchema,
// moveLayerToGroupSchema, setGroupBlendModeSchema); `name` means "the group
// in question" across create/delete/ungroup/set_blend_mode (the new group's
// name for create, the existing group's for the rest) — no collision, same
// concept. The handler dispatches to the exact same functions the five
// deprecated standalone tools call, so op-routed and name-routed calls are
// byte-identical in behavior.
const GROUP_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    op: {
      type: 'string',
      enum: [...GROUP_OPS],
      description:
        "create: make a new group above the active layer named `name` (hoisted out of an active group by default; into_active_group:true keeps Photoshop's native nesting), optionally moving `layers` into it. " +
        'delete: DESTRUCTIVE — delete group `name` and everything inside it (nested groups and their layers); requires confirm:true. To dissolve a group while keeping its contents, use ungroup instead. ' +
        'ungroup: DESTRUCTIVE structural change — dissolve group `name`, promoting its contents to the parent level in their existing stack order; requires confirm:true. ' +
        'add_layer: move `layer_name` into `group_name` (top of its stack). ' +
        "set_blend_mode: set group `name`'s blend mode to `blend_mode` — PASSTHROUGH (default for new groups) lets adjustments inside affect layers below the group; NORMAL treats the group as a single composite.",
    },
    ...createGroupSchema.properties,
    name: {
      type: 'string',
      description:
        'Group name. create: name for the NEW group. delete/ungroup/set_blend_mode: the EXISTING group to act on (recursive search).',
    },
    confirm: {
      type: 'boolean',
      description:
        'REQUIRED for op=delete and op=ungroup, ignored by the other ops. Must be true — guards against accidental loss of a group and (for delete) everything it contains.',
    },
    ...moveLayerToGroupSchema.properties,
    blend_mode: setGroupBlendModeSchema.properties!.blend_mode,
  },
  required: ['op'],
};

// ---------- Factory ----------

export function createGroupTools(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient
): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'ps_group',
        description:
          'Layer group (LayerSet) lifecycle and membership — choose the operation with `op`. create/delete/ungroup/add_layer/set_blend_mode. See the `op` enum for per-operation params. delete and ungroup are DESTRUCTIVE and require confirm:true — delete removes the group AND everything inside it; ungroup dissolves the group but promotes its contents to the parent level (use ungroup, not delete, to keep the layers).',
        inputSchema: GROUP_INPUT_SCHEMA,
        outputSchema: {
          type: 'object',
          properties: {
            created: { type: 'boolean', description: 'op=create: true on success.' },
            deleted: { type: 'boolean', description: 'op=delete: true on success.' },
            ungrouped: { type: 'boolean', description: 'op=ungroup: true on success.' },
            moved: { type: 'boolean', description: 'op=add_layer: true on success.' },
            set: { type: 'boolean', description: 'op=set_blend_mode: true on success.' },
            groupName: { type: 'string' },
            layerName: { type: 'string', description: 'op=add_layer: the moved layer.' },
            blendMode: { type: 'string', description: 'op=set_blend_mode: the mode applied.' },
            moved_count: { type: 'number', description: 'op=create: layers moved into it.' },
            not_found: {
              type: 'array',
              items: { type: 'string' },
              description: 'op=create: requested layer names that were not found.',
            },
            hoisted: {
              type: 'boolean',
              description:
                'op=create: true when the new group had to be moved back out of the previously-active group to honor into_active_group:false.',
            },
            parent_path: {
              type: ['array', 'null'],
              items: { type: 'string' },
              description:
                'op=create: the containing-group name chain (outermost first), empty array at the document root.',
            },
            descendants_deleted: {
              type: 'number',
              description: 'op=delete: total layers removed with the group.',
            },
            children_promoted: {
              type: 'number',
              description: 'op=ungroup: children promoted to the parent level.',
            },
            child_names: {
              type: 'array',
              items: { type: 'string' },
              description: 'op=ungroup: names of the promoted children.',
            },
            context: { type: 'object' },
          },
        },
        annotations: {
          title: 'Group',
          destructiveHint: true,
          idempotentHint: false,
        },
      },
      handler: async (args) => groupDispatch(connection, snippetClient, args),
    },
    {
      tool: {
        name: 'ps_create_group',
        description: `DEPRECATED — use ps_group(op=create) instead (kept for one release for backward compatibility, identical behaviour). Create a new layer group (LayerSet) above the active layer with the given name — hoisted out of the active layer's group by default even though Photoshop's own Mk-layerSection placement rule would otherwise nest it INSIDE that group (pass into_active_group:true to keep that native nesting; this is why groups created one after another land as siblings rather than nested, so bottom-to-top group creation is safe). Optionally moves existing layers into it in one step. Non-destructive. Foundational for structured non-destructive editing — e.g. group all adjustment layers into an "edits" group so you can A/B toggle the whole stack via group visibility.`,
        inputSchema: createGroupSchema,
        outputSchema: {
          type: 'object',
          properties: {
            created: { type: 'boolean' },
            groupName: { type: 'string' },
            moved_count: { type: 'number' },
            not_found: { type: 'array', items: { type: 'string' } },
            hoisted: {
              type: 'boolean',
              description:
                'True when the new group had to be moved back out of the previously-active group to honor into_active_group:false (the default). False when it landed correctly on its own, or when the move-back itself failed — check the layer tree if this matters and hoisted is false.',
            },
            parent_path: {
              type: ['array', 'null'],
              items: { type: 'string' },
              description:
                'The containing-group name chain (outermost first), empty array at the document root.',
            },
            context: { type: 'object' },
          },
        },
        annotations: {
          title: 'Create Layer Group',
          idempotentHint: false,
        },
      },
      handler: async (args) => createGroup(connection, snippetClient, args),
    },
    {
      tool: {
        name: 'ps_move_layer_to_group',
        description:
          'DEPRECATED — use ps_group(op=add_layer) instead (kept for one release for backward compatibility, identical behaviour). Move a named layer into a named group. The layer is placed at the top of the group stack. Both layer_name and group_name are looked up recursively; when a layer and a group share the name given as layer_name, the layer wins, and a group is used only if no layer matches (so nesting a group inside a group still works). Throws if either is not found, or if the layer IS the group itself.',
        inputSchema: moveLayerToGroupSchema,
        outputSchema: {
          type: 'object',
          properties: {
            moved: { type: 'boolean' },
            layerName: { type: 'string' },
            groupName: { type: 'string' },
            context: { type: 'object' },
          },
        },
        annotations: {
          title: 'Move Layer Into Group',
          idempotentHint: false,
        },
      },
      handler: async (args) => moveLayerToGroup(connection, snippetClient, args),
    },
    {
      tool: {
        name: 'ps_set_group_blend_mode',
        description:
          "DEPRECATED — use ps_group(op=set_blend_mode) instead (kept for one release for backward compatibility, identical behaviour). Set a group's blend mode. The default for new groups is PASSTHROUGH (adjustments inside affect layers below the group). Change to NORMAL when treating the group as a single composite — required for masking a stack of adjustments with one mask.",
        inputSchema: setGroupBlendModeSchema,
        outputSchema: {
          type: 'object',
          properties: {
            set: { type: 'boolean' },
            groupName: { type: 'string' },
            blendMode: { type: 'string' },
            context: { type: 'object' },
          },
        },
        annotations: {
          title: 'Set Group Blend Mode',
          idempotentHint: true,
        },
      },
      handler: async (args) => setGroupBlendMode(connection, snippetClient, args),
    },
    {
      tool: {
        name: 'ps_ungroup',
        description:
          'DEPRECATED — use ps_group(op=ungroup) instead (kept for one release for backward compatibility, identical behaviour). DESTRUCTIVE structural change: Dissolve a group, leaving its contents at the parent level in their existing stack order. The group itself is removed. Requires confirm:true. Recoverable only via Edit > Undo.',
        inputSchema: ungroupSchema,
        outputSchema: {
          type: 'object',
          properties: {
            ungrouped: { type: 'boolean' },
            groupName: { type: 'string' },
            children_promoted: { type: 'number' },
            child_names: { type: 'array', items: { type: 'string' } },
            context: { type: 'object' },
          },
        },
        annotations: {
          title: 'Ungroup Layer Set (destructive structural change)',
          destructiveHint: true,
          idempotentHint: false,
        },
      },
      handler: async (args) => ungroup(connection, snippetClient, args),
    },
    {
      tool: {
        name: 'ps_clipping_mask',
        description:
          'Clip or un-clip the active layer against the layer directly below it — choose with `op`. `create`: use the layer below as the alpha source; PS paints the active layer only where the layer below has pixels. Non-destructive — the upper layer is unchanged. Common for constraining a texture/photo to a shape, or masking an effect to a single underlying layer (the add_adjustment_layer tool already accepts clip_to_below for the adjustment-layer-specific case). Equivalent to Layer > Create Clipping Mask (Ctrl+Alt+G). `release`: the inverse — the layer returns to compositing against the whole canvas. Both ops are idempotent: create no-ops (already_clipped:true) on an already-clipped layer; release no-ops (released:false) on a non-clipped layer.',
        inputSchema: clippingMaskSchema,
        outputSchema: {
          type: 'object',
          properties: {
            clipped: { type: 'boolean' },
            already_clipped: { type: 'boolean' },
            released: { type: 'boolean' },
            layerName: { type: 'string' },
            context: { type: 'object' },
          },
        },
        annotations: {
          title: 'Clipping Mask',
          idempotentHint: true,
        },
      },
      handler: async (args) => clippingMask(connection, snippetClient, args),
    },
    {
      tool: {
        name: 'ps_delete_group',
        description:
          'DEPRECATED — use ps_group(op=delete) instead (kept for one release for backward compatibility, identical behaviour). DESTRUCTIVE: Delete a group AND ALL its contents (including nested groups and their layers). Requires confirm:true because the destructive scope is much larger than a single-layer delete. Recoverable only via Edit > Undo. To dissolve a group while keeping its contents, use ps_ungroup instead.',
        inputSchema: deleteGroupSchema,
        outputSchema: {
          type: 'object',
          properties: {
            deleted: { type: 'boolean' },
            groupName: { type: 'string' },
            descendants_deleted: { type: 'number' },
            context: { type: 'object' },
          },
        },
        annotations: {
          title: 'Delete Group (destructive, recursive)',
          destructiveHint: true,
          idempotentHint: false,
        },
      },
      handler: async (args) => deleteGroup(connection, snippetClient, args),
    },
  ];
}

// ---------- Handlers ----------

// ps_clipping_mask → create / release.
async function clippingMask(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  const op = rawArgs.op;
  const { op: _omit, ...rest } = rawArgs;
  switch (op) {
    case 'create':
      return runSnippetTool({
        connection,
        snippetClient,
        rawArgs: rest,
        schema: clippingMaskOpArgsSchema,
        snippet: 'createClippingMask',
        errorPrefix: 'Error creating clipping mask',
        successText: (result) => {
          const r = result as { already_clipped?: boolean; layerName?: string };
          return r.already_clipped === true
            ? `Layer "${r.layerName ?? ''}" is already clipped — nothing to do.`
            : `Clipped layer "${r.layerName ?? ''}" to the layer below.`;
        },
      });
    case 'release':
      return runSnippetTool({
        connection,
        snippetClient,
        rawArgs: rest,
        schema: clippingMaskOpArgsSchema,
        snippet: 'releaseClippingMask',
        errorPrefix: 'Error releasing clipping mask',
        successText: (result) => {
          const r = result as { released?: boolean; layerName?: string };
          return r.released === false
            ? `Layer "${r.layerName ?? ''}" is not clipped — nothing to release.`
            : `Released clipping mask on layer "${r.layerName ?? ''}".`;
        },
      });
    default:
      return unknownDiscriminator('clipping_mask op', op, CLIPPING_MASK_OPS);
  }
}

// ps_group → create / delete / ungroup / add_layer / set_blend_mode. Routes
// to the exact same handler functions the five deprecated standalone tools
// call (createGroup / deleteGroup / ungroup / moveLayerToGroup /
// setGroupBlendMode below) — same function, same schema validation, same
// snippet — so the old and new routes are behaviorally identical by
// construction, not just by matching test coverage.
async function groupDispatch(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  const op = rawArgs.op;
  const { op: _omit, ...rest } = rawArgs;
  switch (op) {
    case 'create':
      return createGroup(connection, snippetClient, rest);
    case 'delete':
      return deleteGroup(connection, snippetClient, rest);
    case 'ungroup':
      return ungroup(connection, snippetClient, rest);
    case 'add_layer':
      return moveLayerToGroup(connection, snippetClient, rest);
    case 'set_blend_mode':
      return setGroupBlendMode(connection, snippetClient, rest);
    default:
      return unknownDiscriminator('group op', op, GROUP_OPS);
  }
}

async function createGroup(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: createGroupSchema,
    snippet: 'createGroup',
    errorPrefix: 'Error creating group',
    params: (args) => {
      const name = args.name as string;
      const layers = args.layers as string[] | undefined;
      const intoActiveGroup = (args.into_active_group as boolean) ?? false;
      const params: Record<string, unknown> = { name, into_active_group: intoActiveGroup };
      if (layers !== undefined) params.layerNames = layers;
      return params;
    },
    successText: (result, args) => {
      const name = args.name as string;
      const layers = args.layers as string[] | undefined;
      return `Group "${name}" created${layers && layers.length ? ` (moved ${(result as { moved_count?: number }).moved_count ?? 0}/${layers.length} layers)` : ''}`;
    },
  });
}

async function moveLayerToGroup(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: moveLayerToGroupSchema,
    snippet: 'moveLayerToGroup',
    errorPrefix: 'Error moving layer to group',
    params: (args) => ({
      layerName: args.layer_name as string,
      groupName: args.group_name as string,
    }),
    successText: (_result, args) =>
      `Layer "${args.layer_name as string}" moved into group "${args.group_name as string}"`,
  });
}

async function setGroupBlendMode(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: setGroupBlendModeSchema,
    snippet: 'setGroupBlendMode',
    errorPrefix: 'Error setting group blend mode',
    params: (args) => ({
      groupName: args.name as string,
      blendMode: args.blend_mode as string,
    }),
    successText: (_result, args) =>
      `Group "${args.name as string}" blend mode set to ${args.blend_mode as string}`,
  });
}

async function ungroup(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(ungroupSchema, rawArgs);
    const name = args.name as string;
    const confirm = args.confirm as boolean;
    if (!confirm) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Refusing to ungroup without confirm:true. This dissolves the group and changes the layer stack structure.',
          },
        ],
        isError: true,
      };
    }

    const script = await snippetClient.build('ungroup', { groupName: name });
    const result = await runScript(connection, script);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Group "${name}" dissolved (${(result as { children_promoted?: number }).children_promoted ?? 0} children promoted)`,
        },
      ],
      structuredContent: result as Record<string, unknown>,
    };
  } catch (error) {
    return toolErrorResult('Error ungrouping', error);
  }
}

async function deleteGroup(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(deleteGroupSchema, rawArgs);
    const name = args.name as string;
    const confirm = args.confirm as boolean;
    if (!confirm) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Refusing to delete group without confirm:true. This deletes the group and all contained layers.',
          },
        ],
        isError: true,
      };
    }

    const script = await snippetClient.build('deleteGroup', { name });
    const result = await runScript(connection, script);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Group "${name}" deleted (${(result as { descendants_deleted?: number }).descendants_deleted ?? 0} descendants removed)`,
        },
      ],
      structuredContent: result as Record<string, unknown>,
    };
  } catch (error) {
    return toolErrorResult('Error deleting group', error);
  }
}
