import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import type { SnippetClient } from '../api/snippet-client.js';
import type { JsonSchemaObject } from '../utils/validate.js';

import { getMetadata, getMetadataSchema } from './metadata-tools.js';
import { getHistory } from './history-tools.js';
import { getLayerTree } from './layer-tools.js';
import { getSelectionInfoHandler } from './selection-tools.js';
import { getSmartObjectInfoHandler } from './smart-object-tools.js';

/**
 * ps_inspect — consolidates the five read-only state readers
 * (`get_metadata`, `get_layer_tree`, `get_history`, `get_selection_info`,
 * `get_smart_object_info`) into one `what`-discriminated tool (Phase 1b,
 * 2026-06-26; `smart_object` added 2026-08-08).
 *
 * Same merge pattern as the Phase-1 consolidations: the discriminator is
 * stripped and the call delegates to the UNCHANGED per-reader handler, which
 * keeps its own snippet, output shape, and (for metadata) its own
 * validation. Only `metadata` carries params (`sections`); the other four
 * are param-free, so the union input schema is just `what` + `sections`.
 *
 * Deliberately NOT merged here (kept as named, prominent tools): the
 * measurement / VERIFICATION primitives `get_preview`, `get_histogram`,
 * `compare_regions`, `get_layer_bounds_diff`, `get_selection_preview`. They
 * have divergent rich inputs + numeric outputs, and they are the surface we
 * most want the model to reach for — burying them in a mega-getter would be
 * anti-steering (§4).
 */

const INSPECT_WHATS = [
  'metadata',
  'layer_tree',
  'history',
  'selection_info',
  'smart_object',
] as const;

const INSPECT_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    what: {
      type: 'string',
      enum: [...INSPECT_WHATS],
      description:
        'Which read-only state to return. ' +
        'metadata: document/IPTC/camera-EXIF/GPS/ACR develop settings + active context (optionally subset with `sections`; sections=["context"] is the cheap orientation probe). ' +
        'layer_tree: the full recursive layer tree (name/kind/visibility/opacity/blend/clipping/bounds) — use whenever you need what is inside a group. ' +
        'history: all history states + the current cursor, for deciding how far to undo. ' +
        'selection_info: current selection bounds/coverage/edge-complexity without modifying anything. ' +
        'smart_object: whether the ACTIVE layer is a Smart Object and, if so, whether its source is embedded or linked to a file on disk, plus how many Smart Filters it carries.',
    },
    // metadata-only param; ignored for the other targets.
    ...getMetadataSchema.properties,
  },
  required: ['what'],
};

export function createInspectTools(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient
): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'ps_inspect',
        description:
          'Read-only document inspection — choose with `what` (metadata / layer_tree / history / selection_info / smart_object). This is the assess/orientation surface: call it at the start of a workflow and whenever you need fresh state. For metadata, pass `sections` to subset (e.g. ["context"] for a cheap probe). For an IMAGE-based check use ps_get_preview; for NUMERIC verification use ps_get_histogram / ps_compare_regions / ps_get_layer_bounds_diff (these stay separate, named tools on purpose). Read-only and idempotent.',
        inputSchema: INSPECT_INPUT_SCHEMA,
        outputSchema: {
          type: 'object',
          properties: {
            // metadata
            document: { type: 'object' },
            iptc: { type: 'object' },
            camera: { type: 'object' },
            gps: { type: 'object' },
            acr: { type: 'object' },
            source_metadata: { type: 'object' },
            context: { type: 'object' },
            // layer_tree
            documentName: { type: 'string' },
            activeLayer: { type: 'string' },
            topLevelCount: { type: 'number' },
            tree: { type: 'array' },
            // history
            totalStates: { type: 'number' },
            currentIndex: { type: 'number' },
            currentState: { type: 'string' },
            canUndo: { type: 'boolean' },
            canRedo: { type: 'boolean' },
            states: { type: 'array' },
            // selection_info
            selection_info: { type: 'object' },
            // smart_object
            is_smart_object: { type: 'boolean' },
            linked: { type: 'boolean' },
            // null for an embedded Smart Object (the common case) — only a
            // LINKED one carries a file_reference/document_id/placed value.
            file_reference: { type: ['string', 'null'] },
            document_id: { type: ['string', 'null'] },
            placed: { type: ['string', 'null'] },
            smart_filter_count: { type: 'number' },
            layer_name: { type: 'string' },
            layer_kind: { type: 'string' },
            bounds: { type: 'array' },
          },
        },
        annotations: {
          title: 'Inspect Document State',
          readOnlyHint: true,
          idempotentHint: true,
          // metadata's camera/gps/acr sections re-open the source file on disk.
          openWorldHint: true,
        },
      },
      handler: async (args) => inspect(connection, snippetClient, args),
    },
  ];
}

// Dispatch by `what`; strip it so each delegate validates only its own params
// (metadata) or ignores the rest (the param-free readers).
async function inspect(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  const what = rawArgs.what;
  const { what: _omit, ...rest } = rawArgs;
  switch (what) {
    case 'metadata':
      return getMetadata(connection, snippetClient, rest);
    case 'layer_tree':
      return getLayerTree(connection, snippetClient);
    case 'history':
      return getHistory(connection, snippetClient);
    case 'selection_info':
      return getSelectionInfoHandler(connection, snippetClient);
    case 'smart_object':
      return getSmartObjectInfoHandler(connection, snippetClient);
    default:
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: unknown inspect target "${String(what)}". Allowed: ${INSPECT_WHATS.join(', ')}.`,
          },
        ],
        isError: true,
      };
  }
}
