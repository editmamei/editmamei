import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import type { GimpBackend } from '../backends/gimp/backend.js';
import { validateArgs, type JsonSchemaObject } from '../utils/validate.js';
import { toolGimpErrorResult, unknownDiscriminator } from '../utils/tool-helpers.js';
import { pickSchemaDeclaredKeys } from './gimp-shared.js';

/**
 * gimp_inspect — read-only state reader, the gimp_* twin of ps_inspect.
 *
 * `what: 'documents'` answers from the bridge's `ping` op: ids only, nothing else. The other four
 * targets reach the bridge's `describe` op (`ops.py`'s `op_describe`) for an already-open image's
 * own structure:
 *   - `document` — dims/base_type/precision/resolution, the full layer tree, and every channel by
 *     id/name only (no coverage — see `channels` below for that).
 *   - `layers` — just the layer tree, when the rest of `document` isn't needed.
 *   - `channels` — every named channel WITH coverage (`selected_pixels`/`fraction`) — the one
 *     thing `document` deliberately leaves out, since coverage reads each channel's full pixel
 *     buffer; ask for this only when coverage itself is what's needed.
 *   - `filter` — one filter by `filter_id`, in the exact shape `gimp_filter` (op=list) reports it
 *     in — the cheap way to re-check one filter without listing the whole stack.
 * `image` is required for all four; `filter_id` is required for `filter` only. Both requirements
 * are enforced by the bridge (`lib.require`), not this schema, the same posture `gimp_filter`'s
 * own op-conditional fields take.
 *
 * `what: 'fonts'` needs no image: it lists the installed font names (sorted, optionally narrowed
 * by a case-insensitive `filter` substring, capped at 200 with the true `total`), the names a text
 * layer's font accepts.
 *
 * Layer tree nodes address by `layer_id`, not name — GIMP allows duplicate layer names, so a name
 * can't tell two layers apart the way an id always can. Every node also flags `is_text_layer`, and a text layer's node
 * also carries its `text`, `font`, `font_size` (points), `color` ({red, green, blue}) and
 * `alignment`.
 * `document`/`layers` cap the tree at 2000 nodes total (`ops.py`'s `MAX_DESCRIBE_LAYER_NODES`) and
 * report `truncated: true` if the cap was hit, rather than risk unbounded output on a
 * pathologically large or deep document — alongside `top_level_count` (the image's real top-level
 * layer count, from the bridge's own `get_layers()`, true even when truncation cut the tree off
 * early) and `total_nodes` (how many nodes this particular response carries).
 *
 * `channels` can itself run long on a document with many named channels (`_channel_coverage` reads
 * a full pixel buffer per channel), so the bridge stops after its own internal time budget
 * (`CHANNELS_DESCRIBE_DEADLINE_S`, ops.py) and returns the channels already read, `truncated:
 * true`, and `channels_skipped` (how many named channels were never reached) — rather than risk
 * gimp_inspect's own dispatch timeout, which would tree-kill the GIMP session and lose every open
 * image's unsaved work.
 */

const INSPECT_WHATS = ['documents', 'document', 'layers', 'channels', 'filter', 'fonts'] as const;

const inspectSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    what: {
      type: 'string',
      enum: [...INSPECT_WHATS],
      description:
        "What to inspect. 'documents' lists every image currently open in this headless session " +
        "(id only). 'document' describes ONE open image by id: dims, base_type, precision, " +
        'resolution, its full layer tree, and its channels by id/name only (no coverage). ' +
        "'layers' returns just that image's layer tree; 'channels' returns its named channels " +
        "WITH coverage (selected_pixels/fraction) — the cost 'document' skips — reading each " +
        "channel's full pixel buffer in turn; on a document with many named channels this can " +
        'stop early, reporting `truncated: true` and `channels_skipped` (how many were never ' +
        "read). 'filter' returns one filter by `filter_id`, in the same shape gimp_filter " +
        '(op=list) reports it in. Layer tree nodes are addressed by `layer_id` (canonical — GIMP ' +
        "allows duplicate layer names) and flag `is_text_layer`. 'document'/'layers' cap the tree " +
        'at 2000 nodes total and report `truncated: true` if the cap was hit, alongside ' +
        '`top_level_count` and `total_nodes`; if it times out the GIMP session restarts and ' +
        "unsaved work is lost, so save (gimp_save_xcf) first. A text layer's node also reports " +
        "its text, font, font_size (points), color and alignment. 'fonts' lists the installed " +
        'font names (no image needed), optionally narrowed by `filter`.',
    },
    image: {
      type: 'integer',
      description:
        'Image id, as returned by gimp_open_document. Required for every `what` except ' +
        "'documents' and 'fonts'.",
    },
    filter: {
      type: 'string',
      description:
        "what='fonts' only: case-insensitive substring to narrow the font names by. The list is " +
        'sorted and capped at 200 names; `total` counts every match.',
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

interface FontsBridgeResult {
  fonts: string[];
  total: number;
}

interface PingBridgeResult {
  images: number[];
}

/** A one-line human-readable summary for a describe-by-id result — `documents` keeps its own. */
function describeSummary(
  what: 'document' | 'layers' | 'channels' | 'filter',
  args: Record<string, unknown>,
  result: Record<string, unknown>
): string {
  const truncatedSuffix = result.truncated ? ' (truncated at the node cap)' : '';
  if (what === 'filter') {
    return `Filter ${result.filter_id} ("${result.name as string}"): ${result.operation as string}.`;
  }
  if (what === 'layers') {
    const layers = (result.layers as unknown[] | undefined) ?? [];
    // top_level_count is the image's REAL top-level count -- layers.length falls back to it only
    // for a mocked/older result missing the field, but is itself just the (possibly truncated)
    // list this response happens to carry.
    const topLevelCount = (result.top_level_count as number | undefined) ?? layers.length;
    return `${topLevelCount} top-level layer(s) on image ${args.image}${truncatedSuffix}.`;
  }
  if (what === 'channels') {
    const channels = (result.channels as unknown[] | undefined) ?? [];
    const skipped = result.channels_skipped as number | undefined;
    const stoppedEarlySuffix =
      result.truncated && skipped ? ` (stopped early, ${skipped} channel(s) skipped)` : '';
    return `${channels.length} channel(s) on image ${args.image}${stoppedEarlySuffix}.`;
  }
  const layers = (result.layers as unknown[] | undefined) ?? [];
  const channels = (result.channels as unknown[] | undefined) ?? [];
  const topLevelCount = (result.top_level_count as number | undefined) ?? layers.length;
  return (
    `Document ${result.image}: ${result.width}x${result.height} ${result.base_type as string} ` +
    `${result.precision as string}, ${topLevelCount} top-level layer(s)${truncatedSuffix}, ` +
    `${channels.length} channel(s).`
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
    if (what === 'fonts') {
      const result = await gimp.call<FontsBridgeResult & Record<string, unknown>>(
        'fonts',
        pickSchemaDeclaredKeys(inspectSchema, args)
      );
      const shown = result.fonts.length;
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `${result.total} font(s) installed` +
              (args.filter ? ` matching "${String(args.filter).slice(0, 100)}"` : '') +
              (shown < result.total ? `, showing the first ${shown}` : '') +
              `: ${result.fonts.join(', ') || '(none)'}.`,
          },
        ],
        structuredContent: { what, ...result },
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
          'image (dims, base_type, precision, resolution, full layer tree, channels by id/name ' +
          "only — no coverage); 'layers' returns just the tree; 'channels' returns the channels " +
          "WITH coverage (selected_pixels/fraction), the cost 'document' skips, and can stop " +
          'early on a document with many named channels (`truncated: true`, `channels_skipped`). ' +
          "'filter' describes one filter by filter_id, in the same shape gimp_filter (op=list) " +
          "reports it in. 'fonts' lists the installed font names (no image needed), sorted, " +
          'optionally narrowed by `filter` (substring), capped at 200 with a `total`. Layer tree ' +
          'nodes are addressed by `layer_id` (canonical — GIMP allows duplicate layer names) and ' +
          "flag `is_text_layer`; a text layer's node also reports its text, font, font_size " +
          "(points), color and alignment. 'document'/'layers' cap the tree at " +
          '2000 nodes total and report `truncated: true` if the cap was hit, alongside ' +
          '`top_level_count` and `total_nodes`; if it times out the GIMP session restarts and ' +
          'unsaved work is lost, so save (gimp_save_xcf) first.',
        inputSchema: inspectSchema,
        outputSchema: {
          type: 'object',
          properties: {
            what: { type: 'string' },
            fonts: { type: 'array', items: { type: 'string' } },
            total: { type: 'number' },
            returned: { type: 'number' },
            default: { type: ['string', 'null'] },
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
              properties: {
                x: { type: ['number', 'null'] },
                y: { type: ['number', 'null'] },
              },
            },
            layers: { type: 'array', items: { type: 'object' } },
            truncated: { type: 'boolean' },
            top_level_count: { type: 'number' },
            total_nodes: { type: 'number' },
            channels: { type: 'array', items: { type: 'object' } },
            channels_skipped: { type: 'number' },
            filter_id: { type: 'number' },
            layer: { type: 'string' },
            layer_id: { type: 'number' },
            name: { type: 'string' },
            operation: { type: 'string' },
            type: { type: ['string', 'null'] },
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
