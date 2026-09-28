import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import type { GimpBackend } from '../backends/gimp/backend.js';
import { validateArgs, type JsonSchemaObject } from '../utils/validate.js';
import { toolGimpErrorResult, unknownDiscriminator } from '../utils/tool-helpers.js';
import { GIMP_IMAGE_PROP, pickSchemaDeclaredKeys } from './gimp-shared.js';

/**
 * gimp_filter — the GIMP twin of ps_filter's stack-management ops. No
 * `apply` op here — creation lives entirely in `gimp_add_adjustment`; this
 * tool only lists / toggles / deletes what already exists. Deliberately NO
 * `reorder`: `Gimp.DrawableFilter` exposes only delete/set_visible/update
 * and the PDB has no raise/lower-filter procedure (verified live, GIMP
 * 3.2.6). Emulating reorder would mean deleting and re-appending every
 * filter above the moved one, changing their ids and losing any mask a
 * filter this bridge didn't create was confined to.
 */

const filterSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    image: GIMP_IMAGE_PROP,
    op: {
      type: 'string',
      enum: ['list', 'set_visibility', 'delete'],
      description:
        "'list' returns every filter on the image (including filters on layers inside groups), " +
        'top of stack first, with layer/layer_id (which layer the filter lives on, and that ' +
        "layer's id), id/name/operation/visible/mask/source and params. source " +
        '"editmamei" = exact ledger record, with params in gimp_add_adjustment\'s own field names ' +
        'and units, so they can be passed straight back on a re-edit. source "readback" = a filter ' +
        "Editmamei did not create; its params are GIMP's raw GEGL property names and units (not " +
        'gimp_add_adjustment fields), lossy for per-channel curves after a reload, and such a ' +
        "filter cannot be re-edited. 'set_visibility' toggles one filter without deleting it. " +
        "'delete' removes one. There is no 'reorder' — GIMP has no API for it; delete and " +
        're-create the filters in the desired order instead.',
    },
    filter_id: {
      type: 'integer',
      description: 'Required for set_visibility / delete.',
    },
    visible: {
      type: 'boolean',
      description: 'Required for set_visibility.',
    },
  },
  required: ['image', 'op'],
};

async function gimpFilter(
  gimp: GimpBackend,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(filterSchema, rawArgs);
    const op = args.op as string;
    // Unreachable while the schema's own enum stands (validateArgs already
    // refused anything outside it) — kept as defense-in-depth, the same
    // posture every other consolidated dispatcher takes.
    if (op !== 'list' && op !== 'set_visibility' && op !== 'delete') {
      return unknownDiscriminator('op', op, ['list', 'set_visibility', 'delete']);
    }
    const result = await gimp.call<Record<string, unknown>>(
      'filter',
      pickSchemaDeclaredKeys(filterSchema, args)
    );
    let text: string;
    if (op === 'list') {
      const filters = (result.filters as unknown[] | undefined) ?? [];
      text = `${filters.length} filter(s) on image ${args.image}.`;
    } else if (op === 'set_visibility') {
      text = `Filter ${result.filter_id} visibility set to ${result.visible}.`;
    } else {
      text = `Deleted filter ${result.filter_id} ("${result.name as string}").`;
    }
    return {
      content: [{ type: 'text' as const, text }],
      structuredContent: result,
    };
  } catch (error) {
    return toolGimpErrorResult('Error managing GIMP filter stack', error);
  }
}

export function createGimpFilterTools(gimp: GimpBackend): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'gimp_filter',
        description:
          'Headless GIMP: manage the live filter stack: op list | set_visibility | delete. ' +
          '`delete` permanently removes that filter (there is no undo). No `apply` op — ' +
          "creating or re-editing a filter is gimp_add_adjustment's job; this tool only inspects " +
          'or manages what already exists. No `reorder` (GIMP has no API for it) — delete and ' +
          're-create in the desired order instead. `list` is the way to check what a stack of ' +
          "gimp_add_adjustment calls actually produced, and to find a filter's id for a re-edit.",
        inputSchema: filterSchema,
        outputSchema: {
          type: 'object',
          properties: {
            filters: { type: 'array', items: { type: 'object' } },
            filter_id: { type: 'number' },
            visible: { type: 'boolean' },
            name: { type: 'string' },
            deleted: { type: 'boolean' },
          },
        },
        annotations: {
          title: 'Manage GIMP Filter Stack',
          readOnlyHint: false,
          destructiveHint: true, // op=delete removes a filter with no undo
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      handler: async (args) => gimpFilter(gimp, args),
    },
  ];
}
