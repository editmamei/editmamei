import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import type { SnippetClient } from '../api/snippet-client.js';
import { validateArgs, type JsonSchemaObject } from '../utils/validate.js';
import { runSnippetTool, toolErrorResult } from '../utils/tool-helpers.js';
import { LAYER_BLEND_MODES } from '../utils/blend-modes.js';

/**
 * ps_smart_filter — read and manage the filter stack on a Smart Object.
 *
 * Smart Filters are Photoshop's re-editable filter layer: the filter is recorded
 * against the Smart Object rather than burned into pixels, so it can be toggled,
 * re-blended, reordered or removed afterwards. Editmamei could previously CREATE
 * a Smart Object and (with `ps_apply_filter as_smart_filter`) put a filter on
 * one, but nothing could read or change the resulting stack.
 *
 * One op-discriminated tool: list / set_visibility / set_blend / remove. This
 * mixes a reader with a destructive op, which the altitude rule discourages —
 * but the ops share one target (a filter on the active layer), one param shape
 * (an index), and one output family, and the sibling structural tools `ps_path`
 * and `ps_vector_mask` already combine list/add/delete the same way. Consistency
 * with the family it belongs to beats consistency with the general rule here.
 *
 * INDEXING (the thing to get right): indices are 1-BASED and index 1 is the
 * FIRST-APPLIED filter — the bottom of the Smart Filters stack in the Layers
 * panel. Photoshop reads the list 0-based but writes it 1-based; the snippet
 * absorbs that asymmetry so `op=list` reports the same numbers the write ops
 * accept. Read an index, pass it straight back.
 */

const SMART_FILTER_OPS = ['list', 'set_visibility', 'set_blend', 'remove'] as const;

const smartFilterInputSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    op: {
      type: 'string',
      enum: [...SMART_FILTER_OPS],
      description:
        'list: read every Smart Filter on the active layer (index, name, type, enabled, opacity, blend mode). Read-only — call it first to get the indices the other ops take. ' +
        'set_visibility: turn one filter on or off without removing it (needs `index` + `enabled`). ' +
        "set_blend: change one filter's `opacity` and/or `blend_mode` (needs `index` + at least one of them). " +
        'remove: delete one filter from the stack (needs `index`).',
    },
    index: {
      // integer, not number: the Go side narrows this with int(), so a
      // fractional 1.5 would silently become filter 1 rather than being refused.
      type: 'integer',
      description:
        "1-based index of the filter to act on, as reported by op=list. 1 is the FIRST-APPLIED filter (bottom of the Smart Filters stack in the Layers panel). Required for every op except 'list'.",
      minimum: 1,
    },
    enabled: {
      type: 'boolean',
      description:
        'set_visibility only: true shows the filter, false hides it. The filter stays in the stack either way and keeps all its settings.',
    },
    opacity: {
      type: 'number',
      description:
        'set_blend only: filter opacity 0-100. Omit to leave the current opacity untouched.',
      minimum: 0,
      maximum: 100,
    },
    blend_mode: {
      type: 'string',
      enum: [...LAYER_BLEND_MODES],
      description:
        'set_blend only: how the filter result composites against the unfiltered layer. Same names as ps_set_layer. Omit to leave the current mode untouched.',
    },
  },
  required: ['op'],
};

export function createSmartObjectTools(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient
): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'ps_smart_filter',
        description:
          "Read and manage the SMART FILTER stack on a Smart Object — the re-editable filters that ride a Smart Object instead of being baked into pixels. Ops: `list` (every filter with its index, name, type, enabled state, opacity and blend mode), `set_visibility` (toggle one filter off/on without losing its settings), `set_blend` (restyle one filter's opacity/blend mode), `remove` (delete one). **Reach for this after applying a filter with `ps_apply_filter as_smart_filter=true`**, or on any layer a user built as a Smart Object. Indices are 1-based and come from `op=list`; index 1 is the first-applied filter at the bottom of the stack. Needs the target Smart Object to be the ACTIVE layer (select it with ps_select_layer first). For whether a layer is a Smart Object at all, use ps_inspect what=smart_object.",
        inputSchema: smartFilterInputSchema,
        outputSchema: {
          type: 'object',
          properties: {
            // list
            is_smart_object: { type: 'boolean' },
            count: { type: 'number' },
            filters: { type: 'array' },
            // set_visibility
            visibility_set: { type: 'boolean' },
            requested_enabled: { type: 'boolean' },
            enabled: { type: 'boolean' },
            // set_blend — no "did it work" flag: the snippet throws if the
            // change did not take, so these ARE the confirmation.
            opacity: { type: 'number' },
            blend_mode: { type: 'string' },
            // remove
            removed: { type: 'boolean' },
            removed_filter_name: { type: 'string' },
            removed_filter_type: { type: 'string' },
            remaining_count: { type: 'number' },
            // shared
            index: { type: 'number' },
            filter_name: { type: 'string' },
            filter_type: { type: 'string' },
            layer_name: { type: 'string' },
            context: { type: 'object' },
          },
        },
        annotations: {
          title: 'Smart Filter',
          // `list` is read-only, but `remove` deletes a filter and the tool
          // carries one annotation set — so it declares the strongest op.
          destructiveHint: true,
          idempotentHint: false,
        },
      },
      handler: async (args) => runSmartFilterOp(connection, snippetClient, args),
    },
  ];
}

async function runSmartFilterOp(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  let args: Record<string, unknown>;
  try {
    args = validateArgs(smartFilterInputSchema, rawArgs);
  } catch (error) {
    return toolErrorResult('Error in ps_smart_filter', error);
  }

  const op = args.op as (typeof SMART_FILTER_OPS)[number];

  // Per-op requirements the JSON schema can't express (it has no conditional
  // `required`). Checked here so the caller gets a message naming the missing
  // param instead of a snippet failing on a defaulted index.
  if (op !== 'list' && args.index === undefined) {
    return toolErrorResult(
      'Error in ps_smart_filter',
      new Error(
        `op=${op} needs an \`index\`. Call op=list first to see the filters and their indices.`
      )
    );
  }

  switch (op) {
    case 'list':
      return runSnippetTool({
        connection,
        snippetClient,
        rawArgs: args,
        schema: smartFilterInputSchema,
        snippet: 'listSmartFilters',
        errorPrefix: 'Error listing Smart Filters',
        successText: (result) => summarizeList(result as Record<string, unknown>),
      });

    case 'set_visibility': {
      if (args.enabled === undefined) {
        return toolErrorResult(
          'Error in ps_smart_filter',
          new Error(
            'op=set_visibility needs `enabled` (true to show the filter, false to hide it).'
          )
        );
      }
      return runSnippetTool({
        connection,
        snippetClient,
        rawArgs: args,
        schema: smartFilterInputSchema,
        snippet: 'setSmartFilterVisibility',
        errorPrefix: 'Error setting Smart Filter visibility',
        params: (a) => ({ index: a.index, enabled: a.enabled }),
        successText: (result) => {
          const r = result as Record<string, unknown>;
          return `${r.enabled ? 'Showed' : 'Hid'} Smart Filter ${String(r.index)} (${String(r.filter_name)}) on "${String(r.layer_name)}".`;
        },
      });
    }

    case 'set_blend': {
      if (args.opacity === undefined && args.blend_mode === undefined) {
        return toolErrorResult(
          'Error in ps_smart_filter',
          new Error('op=set_blend needs at least one of `opacity` or `blend_mode`.')
        );
      }
      return runSnippetTool({
        connection,
        snippetClient,
        rawArgs: args,
        schema: smartFilterInputSchema,
        snippet: 'setSmartFilterBlend',
        errorPrefix: 'Error setting Smart Filter blend',
        // Only forward what the caller supplied: an omitted key is left alone by
        // Photoshop, so changing opacity must not silently reset the mode.
        params: (a) => {
          const p: Record<string, unknown> = { index: a.index };
          if (a.opacity !== undefined) p.opacity = a.opacity;
          if (a.blend_mode !== undefined) p.blendMode = a.blend_mode;
          return p;
        },
        successText: (result) => {
          const r = result as Record<string, unknown>;
          return `Smart Filter ${String(r.index)} (${String(r.filter_name)}) is now ${String(r.blend_mode)} at ${String(r.opacity)}% opacity on "${String(r.layer_name)}".`;
        },
      });
    }

    case 'remove':
      return runSnippetTool({
        connection,
        snippetClient,
        rawArgs: args,
        schema: smartFilterInputSchema,
        snippet: 'removeSmartFilter',
        errorPrefix: 'Error removing Smart Filter',
        params: (a) => ({ index: a.index }),
        successText: (result) => {
          const r = result as Record<string, unknown>;
          return `Removed Smart Filter ${String(r.index)} (${String(r.removed_filter_name)}) from "${String(r.layer_name)}". ${String(r.remaining_count)} remaining.`;
        },
      });

    default:
      return toolErrorResult(
        'Error in ps_smart_filter',
        new Error(
          `Unknown smart-filter op: ${String(op)}. Allowed: ${SMART_FILTER_OPS.join(', ')}.`
        )
      );
  }
}

function summarizeList(r: Record<string, unknown>): string {
  const layer = String(r.layer_name ?? '');
  if (r.is_smart_object !== true) {
    return `"${layer}" is not a Smart Object, so it has no Smart Filters. Convert it with ps_convert_to_smart_object to make filters re-editable.`;
  }
  const filters = Array.isArray(r.filters) ? (r.filters as Record<string, unknown>[]) : [];
  if (filters.length === 0) {
    return `"${layer}" is a Smart Object with no Smart Filters yet. Add one with ps_apply_filter as_smart_filter=true.`;
  }
  const lines = filters.map((f) => {
    const state = f.enabled === false ? ' [hidden]' : '';
    const blend =
      f.blend_mode === 'NORMAL' && f.opacity === 100
        ? ''
        : ` — ${String(f.blend_mode)} @ ${String(f.opacity)}%`;
    return `  ${String(f.index)}. ${String(f.name)} (${String(f.type)})${blend}${state}`;
  });
  return `"${layer}" has ${filters.length} Smart Filter${filters.length === 1 ? '' : 's'} (1 = first applied, bottom of the stack):\n${lines.join('\n')}`;
}

/**
 * ps_inspect what=smart_object. Reports whether the active layer is a Smart
 * Object and, when it is, how its source is stored — `linked: true` means
 * Photoshop reads the pixels through a file on disk (`file_reference`), so
 * replacing that file changes every document that links it; embedded means the
 * source lives inside this PSD and is nobody else's business.
 */
export async function getSmartObjectInfoHandler(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs: {},
    schema: { type: 'object', properties: {} },
    snippet: 'getSmartObjectInfo',
    errorPrefix: 'Error reading Smart Object info',
    successText: (result) => {
      const r = result as Record<string, unknown>;
      const layer = String(r.layer_name ?? '');
      if (r.is_smart_object !== true) {
        return `"${layer}" is not a Smart Object (kind: ${String(r.layer_kind)}).`;
      }
      const storage = r.linked === true ? `linked to ${String(r.file_reference)}` : 'embedded';
      const n = Number(r.smart_filter_count ?? 0);
      return `"${layer}" is a ${storage} Smart Object with ${n} Smart Filter${n === 1 ? '' : 's'}.`;
    },
  });
}
