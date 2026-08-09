import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import type { SnippetClient } from '../api/snippet-client.js';
import { runScript } from '../utils/run-script.js';
import { validateArgs, type JsonSchemaObject } from '../utils/validate.js';
import { toolErrorResult } from '../utils/tool-helpers.js';

/**
 * ps_vector_mask — vector-mask ops (the path
 * consumer that turns a real editable path into a layer's vector mask). One
 * op-discriminated tool: add / delete / link / unlink.
 *
 * Photoshop exposes NO DOM API for vector masks — these are AM-only, authored
 * from the canonical "make vector mask" idiom. Verified live against PS 27.2.0:
 * add (from_current_path) / delete / link / unlink on 2026-06-24; the
 * reveal_all / hide_all empty-mask `add` variants on 2026-06-29, after a
 * ScriptListener capture pinned their descriptor (Usng = enum
 * vectorMaskEnabled RvlA/HdAl, no path needed).
 */

const VECTOR_MASK_OPS = ['add', 'delete', 'link', 'unlink', 'enable', 'disable'] as const;
// from_current_path seeds from the active path; reveal_all/hide_all make an empty
// reveal/hide mask (no path needed) — all live-verified.
const ADD_SOURCES = ['from_current_path', 'reveal_all', 'hide_all'] as const;

const vectorMaskInputSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    op: {
      type: 'string',
      enum: [...VECTOR_MASK_OPS],
      description:
        'add: create a vector mask on the active layer — seeded from the active path (source=from_current_path, needs a path from ps_path) or as an empty reveal_all/hide_all mask (no path needed). ' +
        "delete: remove the active layer's vector mask. " +
        'link: link the vector mask to the layer (they transform together). ' +
        'unlink: unlink the vector mask from the layer (transform independently). ' +
        'disable: turn the vector mask off (the layer renders unmasked) without deleting it. ' +
        'enable: turn a disabled vector mask back on.',
    },
    source: {
      type: 'string',
      enum: [...ADD_SOURCES],
      description:
        "add only: what the vector mask is seeded from. 'from_current_path' = the active work/saved path (needs a path; the main consumer of ps_path). 'reveal_all' = an empty mask that reveals the whole layer. 'hide_all' = an empty mask that hides the whole layer (paint/draw paths to reveal).",
      default: 'from_current_path',
    },
  },
  required: ['op'],
};

export function createVectorMaskTools(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient
): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'ps_vector_mask',
        description:
          'Attach, remove, (un)link, or (dis/en)able a layer VECTOR MASK — the path-driven, resolution-independent companion to a pixel layer mask. Ops: `add` (from the active path via source=from_current_path — the typical flow after ps_path op=create_from_selection / save — or an empty source=reveal_all/hide_all mask), `delete`, `link`, `unlink`, `disable` (turn the mask off without deleting it), `enable` (turn it back on). **Reach for this when** you want a crisp vector-edged mask rather than a painted pixel mask. `add` needs a non-background layer (and a path for from_current_path); the other ops need a layer that already has a vector mask. (Vector masks are AM-driven; verified live on PS 27.2.0.)',
        inputSchema: vectorMaskInputSchema,
        outputSchema: {
          type: 'object',
          properties: {
            vector_mask_added: { type: 'boolean' },
            vector_mask_deleted: { type: 'boolean' },
            vector_mask_linked: { type: 'boolean' },
            vector_mask_enabled: { type: 'boolean' },
            source: { type: 'string' },
            layer_name: { type: 'string' },
            context: { type: 'object' },
          },
        },
        annotations: {
          title: 'Vector Mask',
          destructiveHint: true,
          idempotentHint: false,
        },
      },
      handler: async (args) => runVectorMaskOp(connection, snippetClient, args),
    },
  ];
}

async function runVectorMaskOp(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(vectorMaskInputSchema, rawArgs);
    const op = args.op as (typeof VECTOR_MASK_OPS)[number];

    let snippet: string;
    let params: Record<string, unknown>;

    switch (op) {
      case 'add':
        snippet = 'addVectorMask';
        params = { source: args.source as string };
        break;
      case 'delete':
        snippet = 'deleteVectorMask';
        params = {};
        break;
      case 'link':
        snippet = 'setVectorMaskLink';
        params = { linked: true };
        break;
      case 'unlink':
        snippet = 'setVectorMaskLink';
        params = { linked: false };
        break;
      case 'enable':
        snippet = 'setVectorMaskEnabled';
        params = { enabled: true };
        break;
      case 'disable':
        snippet = 'setVectorMaskEnabled';
        params = { enabled: false };
        break;
      default:
        return {
          content: [{ type: 'text' as const, text: `Unknown vector-mask op: ${String(op)}` }],
          isError: true,
        };
    }

    const script = await snippetClient.build(snippet, params);
    const result = (await runScript(connection, script)) as Record<string, unknown>;

    return {
      content: [{ type: 'text' as const, text: summarize(op, result) }],
      structuredContent: result,
    };
  } catch (error) {
    return toolErrorResult('Error in ps_vector_mask', error);
  }
}

function summarize(op: string, r: Record<string, unknown>): string {
  const layer = r.layer_name as string | undefined;
  const on = layer ? ` on "${layer}"` : '';
  switch (op) {
    case 'add':
      return `Added a vector mask (${r.source})${on}.`;
    case 'delete':
      return `Deleted the vector mask${on}.`;
    case 'link':
      return `Linked the vector mask to the layer${on}.`;
    case 'unlink':
      return `Unlinked the vector mask from the layer${on}.`;
    case 'enable':
      return `Enabled the vector mask${on}.`;
    case 'disable':
      return `Disabled the vector mask${on}.`;
    default:
      return 'Vector-mask op complete.';
  }
}
