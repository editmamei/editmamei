import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import type { GimpBackend } from '../backends/gimp/backend.js';
import { validateArgs, type JsonSchemaObject } from '../utils/validate.js';
import { toolGimpErrorResult } from '../utils/tool-helpers.js';
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
        "'list' returns every filter on the image, top of stack first, with id/name/operation/" +
        "visible/mask/source (editmamei = exact ledger record; readback = GIMP's own config, " +
        "lossy for per-channel curves after a reload) and params. 'set_visibility' toggles one " +
        "filter without deleting it. 'delete' removes one. There is no 'reorder' — GIMP has no API " +
        'for it; delete and re-create the filters in the desired order instead.',
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
          'Manage the live filter stack: op list | set_visibility | delete. No `apply` op — ' +
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
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      handler: async (args) => gimpFilter(gimp, args),
    },
  ];
}
