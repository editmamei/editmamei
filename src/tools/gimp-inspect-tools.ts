import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import type { GimpBackend } from '../backends/gimp/backend.js';
import { validateArgs, type JsonSchemaObject } from '../utils/validate.js';
import { toolGimpErrorResult, unknownDiscriminator } from '../utils/tool-helpers.js';
import { pickSchemaDeclaredKeys } from './gimp-shared.js';

/**
 * gimp_inspect — read-only state reader, the gimp_* twin of ps_inspect.
 *
 * `what: 'documents'` is unchanged from the original, `ping`-only version of this tool: every
 * open image's id, nothing else. The other four targets reach the bridge's `describe` op
 * (`ops.py`'s `op_describe`) for an already-open image's own structure:
 *   - `document` — dims/base_type/precision/resolution, the full layer tree, and every channel.
 *   - `layers` — just the layer tree, when the rest of `document` isn't needed.
 *   - `channels` — just the named channels (with coverage), same shape `document` embeds.
 *   - `filter` — one filter by `filter_id`, in the exact shape `gimp_filter` (op=list) reports it
 *     in — the cheap way to re-check one filter without listing the whole stack.
 * `image` is required for all four; `filter_id` is required for `filter` only. Both requirements
 * are enforced by the bridge (`lib.require`), not this schema, the same posture `gimp_filter`'s
 * own op-conditional fields take.
 *
 * Layer tree nodes address by `layer_id`, not name — GIMP allows duplicate layer names, so a name
 * can't tell two layers apart the way an id always can. Every node also flags `is_text_layer`.
 */

const INSPECT_WHATS = ['documents', 'document', 'layers', 'channels', 'filter'] as const;

const inspectSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    what: {
      type: 'string',
      enum: [...INSPECT_WHATS],
      description:
        "What to inspect. 'documents' lists every image currently open in this headless session " +
        "(id only). 'document' describes ONE open image by id: dims, base_type, precision, " +
        "resolution, its full layer tree, and its channels. 'layers' returns just that image's " +
        "layer tree; 'channels' returns just its named channels (with coverage). 'filter' returns " +
        'one filter by `filter_id`, in the same shape gimp_filter (op=list) reports it in. Layer ' +
        'tree nodes are addressed by `layer_id` (canonical — GIMP allows duplicate layer names) ' +
        'and flag `is_text_layer`.',
    },
    image: {
      type: 'integer',
      description:
        'Image id, as returned by gimp_open_document. Required for every `what` except ' +
        "'documents'.",
    },
    filter_id: {
      type: 'integer',
      description:
        "Required for what='filter'. The filter id, as returned by gimp_add_adjustment " +
        'or listed by gimp_filter (op=list).',
    },
  },
  required: ['what'],
};

interface PingBridgeResult {
  images: number[];
}

/** A one-line human-readable summary for a describe-by-id result — `documents` keeps its own. */
function describeSummary(
  what: 'document' | 'layers' | 'channels' | 'filter',
  args: Record<string, unknown>,
  result: Record<string, unknown>
): string {
  if (what === 'filter') {
    return `Filter ${result.filter_id} ("${result.name as string}"): ${result.operation as string}.`;
  }
  if (what === 'layers') {
    const layers = (result.layers as unknown[] | undefined) ?? [];
    return `${layers.length} top-level layer(s) on image ${args.image}.`;
  }
  if (what === 'channels') {
    const channels = (result.channels as unknown[] | undefined) ?? [];
    return `${channels.length} channel(s) on image ${args.image}.`;
  }
  const layers = (result.layers as unknown[] | undefined) ?? [];
  const channels = (result.channels as unknown[] | undefined) ?? [];
  return (
    `Document ${result.image}: ${result.width}x${result.height} ${result.base_type as string} ` +
    `${result.precision as string}, ${layers.length} top-level layer(s), ${channels.length} channel(s).`
  );
}

async function gimpInspect(
  gimp: GimpBackend,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(inspectSchema, rawArgs);
    const what = args.what as string;
    if (what === 'documents') {
      const result = await gimp.call<PingBridgeResult>('ping', {});
      const documents = (result.images ?? []).map((image) => ({ image }));
      return {
        content: [
          {
            type: 'text' as const,
            text: `${documents.length} image(s) open: ${documents.map((d) => d.image).join(', ') || '(none)'}.`,
          },
        ],
        structuredContent: { what, documents },
      };
    }
    if (what === 'document' || what === 'layers' || what === 'channels' || what === 'filter') {
      const result = await gimp.call<Record<string, unknown>>(
        'describe',
        pickSchemaDeclaredKeys(inspectSchema, args)
      );
      return {
        content: [{ type: 'text' as const, text: describeSummary(what, args, result) }],
        structuredContent: { what, ...result },
      };
    }
    // Unreachable while the schema's own enum stands (validateArgs already
    // refused anything else) — kept as defense-in-depth, the same posture
    // every other consolidated dispatcher takes.
    return unknownDiscriminator('what', what, INSPECT_WHATS);
  } catch (error) {
    return toolGimpErrorResult('Error inspecting GIMP state', error);
  }
}

export function createGimpInspectTools(gimp: GimpBackend): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'gimp_inspect',
        description:
          "Headless GIMP: read-only state reader. `what`: 'documents' lists every image " +
          "currently open in this headless GIMP session by id. 'document' describes ONE open " +
          "image (dims, base_type, precision, resolution, full layer tree, channels); 'layers' / " +
          "'channels' return just that half. 'filter' describes one filter by filter_id, in the " +
          'same shape gimp_filter (op=list) reports it in. Layer tree nodes are addressed by ' +
          '`layer_id` (canonical — GIMP allows duplicate layer names) and flag `is_text_layer`.',
        inputSchema: inspectSchema,
        outputSchema: {
          type: 'object',
          properties: {
            what: { type: 'string' },
            documents: {
              type: 'array',
              items: { type: 'object', properties: { image: { type: 'number' } } },
            },
            image: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' },
            base_type: { type: 'string' },
            precision: { type: 'string' },
            resolution: {
              type: 'object',
              properties: { x: { type: 'number' }, y: { type: 'number' } },
            },
            layers: { type: 'array', items: { type: 'object' } },
            channels: { type: 'array', items: { type: 'object' } },
            filter_id: { type: 'number' },
            name: { type: 'string' },
            operation: { type: 'string' },
            visible: { type: 'boolean' },
            source: { type: 'string' },
            mask: { type: ['string', 'null'] },
            params: { type: 'object' },
          },
        },
        annotations: {
          title: 'Inspect GIMP State',
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      handler: async (args) => gimpInspect(gimp, args),
    },
  ];
}
