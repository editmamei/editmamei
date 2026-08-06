import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import type { SnippetClient } from '../api/snippet-client.js';
import { type JsonSchemaObject } from '../utils/validate.js';
import { runSnippetTool } from '../utils/tool-helpers.js';

// Coordinate cap matches Photoshop's max document dimension. We allow
// negative coords so a layer can sit partially off-canvas (Photoshop
// supports this — only the on-canvas portion renders).
const PS_COORD_MAX_PX = 300_000;

const placeImageSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    file_path: {
      type: 'string',
      description: 'Full path to the image file (JPEG, PNG, PSD, etc.)',
    },
    x: {
      type: 'integer',
      description:
        'X position offset in pixels from the canvas centre (default 0). Negative places the layer further left; bounded at ±300,000 px.',
      default: 0,
      minimum: -PS_COORD_MAX_PX,
      maximum: PS_COORD_MAX_PX,
    },
    y: {
      type: 'integer',
      description:
        'Y position offset in pixels from the canvas centre (default 0). Negative places the layer further up; bounded at ±300,000 px.',
      default: 0,
      minimum: -PS_COORD_MAX_PX,
      maximum: PS_COORD_MAX_PX,
    },
    width_percent: {
      type: 'number',
      description:
        'Scale the placed layer horizontally to this percent of its native width. Omit (or pass 100) to keep native size. Common ratios: 50 for half-size, 200 for double. Independent from height_percent — pass both to scale non-uniformly.',
      minimum: 1,
      maximum: 1000,
    },
    height_percent: {
      type: 'number',
      description:
        'Scale the placed layer vertically to this percent of its native height. Omit (or pass 100) to keep native size. Pair with width_percent for uniform scale (set both to the same value).',
      minimum: 1,
      maximum: 1000,
    },
  },
  required: ['file_path'],
};

export function createImagePlacementTools(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient
): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'ps_place_image',
        description:
          'Place an image file (JPEG, PNG, PSD, etc.) as a new Smart Object layer in the active document, optionally offset from center. Rasterize separately if you need to apply pixel-only operations. Open-world: reads from the filesystem. Returns the new layer name, bounds, and updated document context.',
        inputSchema: placeImageSchema,
        outputSchema: {
          type: 'object',
          properties: {
            placed: { type: 'boolean' },
            layerName: { type: 'string' },
            filePath: { type: 'string' },
            position: { type: 'object' },
            layerBounds: { type: 'object' },
            context: { type: 'object' },
          },
        },
        annotations: {
          title: 'Place Image as Layer',
          openWorldHint: true,
        },
      },
      handler: async (args) => placeImage(connection, snippetClient, args),
    },
  ];
}

async function placeImage(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: placeImageSchema,
    snippet: 'placeImage',
    errorPrefix: 'Error placing image',
    params: (args) => {
      const params: Record<string, unknown> = { filePath: args.file_path, x: args.x, y: args.y };
      if (args.width_percent !== undefined) params.widthPercent = args.width_percent;
      if (args.height_percent !== undefined) params.heightPercent = args.height_percent;
      return params;
    },
    successText: (result, args) =>
      `Image placed successfully: ${args.file_path as string}\nPosition: (${args.x as number}, ${args.y as number})\nResult: ${JSON.stringify(result)}`,
  });
}
