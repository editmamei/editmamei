import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import type { SnippetClient } from '../api/snippet-client.js';
import { runScript } from '../utils/run-script.js';
import { validateArgs, type JsonSchemaObject } from '../utils/validate.js';
import { toolErrorResult } from '../utils/tool-helpers.js';

const LAYER_MOVE_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    moved: { type: 'boolean' },
    layerName: { type: 'string' },
    position: { type: 'string' },
    direction: { type: 'string' },
    relativeTo: { type: 'string' },
    message: { type: 'string' },
    context: { type: 'object' },
  },
} as const;

const moveLayerToPositionSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    position: {
      type: 'string',
      description:
        'Where to move the layer. ABOVE/BELOW = relative to target_layer_name (which is then REQUIRED); TOP/BOTTOM = absolute top/bottom of the layer stack (target_layer_name not needed). Uppercase required.',
      enum: ['ABOVE', 'BELOW', 'TOP', 'BOTTOM'],
    },
    target_layer_name: {
      type: 'string',
      description:
        'Required for ABOVE/BELOW: the layer to move relative to. Ignored for TOP/BOTTOM.',
    },
    layer_to_move: {
      type: 'string',
      description:
        'Optional: name of the layer being moved. If omitted, the active layer is moved (legacy behaviour).',
    },
  },
  required: ['position'],
};

export function createLayerOrderingTools(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient
): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'ps_move_layer_to_position',
        description:
          'Move a layer to a position in the stack — the single ordering primitive (the per-direction helpers `_to_top` / `_to_bottom` / `_up` / `_down` were removed 2026-05-31; this tool covers all four cases). Position keywords: ABOVE/BELOW (requires target_layer_name — places the moved layer immediately above/below the target), TOP/BOTTOM (absolute — target_layer_name not needed). By default the ACTIVE layer is moved; pass layer_to_move=<name> to move a specific layer by name (recurses into groups). COMMON CASES: an adjustment layer just created landed below another adjustment that masks its effect → move it to TOP; a vignette darkens the wrong layers → move ABOVE the layer it should affect; a sky-replacement composite is showing through the foreground → move the foreground to TOP. Idempotent for a given (layer_to_move, target, position).',
        inputSchema: moveLayerToPositionSchema,
        outputSchema: LAYER_MOVE_RESULT_SCHEMA,
        annotations: {
          title: 'Move Layer to Position',
          idempotentHint: true,
        },
      },
      handler: async (args) => moveLayerToPosition(connection, snippetClient, args),
    },
  ];
}

async function moveLayerToPosition(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(moveLayerToPositionSchema, rawArgs);
    const targetLayerName = args.target_layer_name as string | undefined;
    const position = args.position as string;
    const layerToMove = args.layer_to_move as string | undefined;

    if ((position === 'ABOVE' || position === 'BELOW') && !targetLayerName) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error moving layer: position=${position} requires target_layer_name. Use TOP/BOTTOM for absolute placement, or supply target_layer_name to anchor against.`,
          },
        ],
        isError: true,
      };
    }

    const params: Record<string, unknown> = { position };
    if (targetLayerName !== undefined) params.targetLayerName = targetLayerName;
    if (layerToMove !== undefined) params.layerToMoveName = layerToMove;

    const script = await snippetClient.build('moveLayerToPosition', params);
    const result = await runScript(connection, script);

    const movedDesc = layerToMove ? `"${layerToMove}"` : 'active layer';
    const anchorDesc = targetLayerName ? ` "${targetLayerName}"` : '';
    return {
      content: [
        {
          type: 'text' as const,
          text: `Moved ${movedDesc} ${position}${anchorDesc}.\nResult: ${JSON.stringify(result)}`,
        },
      ],
      structuredContent: result as Record<string, unknown>,
    };
  } catch (error) {
    return toolErrorResult('Error moving layer', error);
  }
}
