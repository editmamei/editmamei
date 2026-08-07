/**
 * Dev-tier tool — ps_transform_canvas (M2, 2026-06-21).
 *
 * Document-level transforms: rotate the whole canvas (AM Rtte on the document,
 * arbitrary degrees) and flip the whole canvas (AM Flip). These target the
 * document (Dcmn/Ordn/Frst), NOT a layer — the discriminator vs the layer
 * rotate/flip on ps_transform_layer. dev-tier until live-verified.
 */
import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import type { SnippetClient } from '../api/snippet-client.js';
import { type JsonSchemaObject } from '../utils/validate.js';
import { runSnippetTool } from '../utils/tool-helpers.js';

const rotateCanvasSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    degrees: {
      type: 'number',
      description:
        'Rotation angle in degrees, positive = clockwise. Any value (incl. 90 / 180 / -90 for quarter/half turns).',
    },
  },
  required: ['degrees'],
};

const flipCanvasSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    orientation: {
      type: 'string',
      enum: ['horizontal', 'vertical'],
      description: "'horizontal' mirrors the canvas left-right; 'vertical' mirrors top-bottom.",
    },
  },
  required: ['orientation'],
};

const CANVAS_OPS = ['rotate', 'flip'] as const;

const CANVAS_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    op: {
      type: 'string',
      enum: [...CANVAS_OPS],
      description:
        'Which document-level transform to apply. rotate: spin the whole canvas by degrees (+cw; 90/180/-90 for quarter/half turns). flip: mirror the whole canvas horizontal|vertical.',
    },
    ...rotateCanvasSchema.properties,
    ...flipCanvasSchema.properties,
  },
  required: ['op'],
};

export function createTransformCanvasTools(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient
): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'ps_transform_canvas',
        description:
          'Transform the whole document (canvas + all layers), not a single layer — choose with `op`. `rotate` spins the canvas by degrees (+cw; pass 90/180/-90 for quarter/half turns). `flip` mirrors the canvas horizontal|vertical. For rotating/flipping ONE layer use ps_transform_layer instead.',
        inputSchema: CANVAS_INPUT_SCHEMA,
        outputSchema: {
          type: 'object',
          properties: {
            rotated_canvas: { type: 'boolean' },
            flipped_canvas: { type: 'boolean' },
            degrees: { type: 'number' },
            axis: { type: 'string' },
          },
        },
        annotations: {
          title: 'Transform Canvas',
          idempotentHint: false,
        },
      },
      handler: async (args) => transformCanvas(connection, snippetClient, args),
    },
  ];
}

async function transformCanvas(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  const op = rawArgs.op;
  const { op: _omit, ...rest } = rawArgs;
  switch (op) {
    case 'rotate':
      return rotateCanvas(connection, snippetClient, rest);
    case 'flip':
      return flipCanvas(connection, snippetClient, rest);
    default:
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: unknown canvas op "${String(op)}". Allowed: ${CANVAS_OPS.join(', ')}.`,
          },
        ],
        isError: true,
      };
  }
}

async function rotateCanvas(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: rotateCanvasSchema,
    snippet: 'rotateCanvas',
    errorPrefix: 'Error rotating canvas',
    params: (args) => ({ degrees: args.degrees as number }),
    successText: (result, args) =>
      `Canvas rotated ${args.degrees as number} degrees\nResult: ${JSON.stringify(result)}`,
  });
}

async function flipCanvas(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: flipCanvasSchema,
    snippet: 'flipCanvas',
    errorPrefix: 'Error flipping canvas',
    params: (args) => ({ orientation: args.orientation as string }),
    successText: (result, args) =>
      `Canvas flipped ${args.orientation as string}\nResult: ${JSON.stringify(result)}`,
  });
}
