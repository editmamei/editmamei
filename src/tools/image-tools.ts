import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import type { SnippetClient } from '../api/snippet-client.js';
import { runScript } from '../utils/run-script.js';
import { validateArgs, type JsonSchemaObject } from '../utils/validate.js';
import { toolErrorResult, runSnippetTool } from '../utils/tool-helpers.js';
import { type DetectionClient } from '../detection/detection-client.js';
import { OnnxLandmarkDetectionClient } from '../detection/landmark-detection-client.js';
import { resolveExpectedPlacement, PLACEMENT_SCHEMA } from '../perception/grounding-locate.js';

// Photoshop's maximum document dimension. 300,000 px is the documented
// upper bound for canvas size; we cap at the same value to fail fast in the
// validator instead of letting PS throw a cryptic "max document dimensions
// reached" error.
const PS_MAX_DIM_PX = 300_000;

const resizeImageSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    width: {
      type: 'integer',
      description: "New width in pixels (1..300,000 — Photoshop's max canvas size).",
      minimum: 1,
      maximum: PS_MAX_DIM_PX,
    },
    height: {
      type: 'integer',
      description: "New height in pixels (1..300,000 — Photoshop's max canvas size).",
      minimum: 1,
      maximum: PS_MAX_DIM_PX,
    },
  },
  required: ['width', 'height'],
};

const cropDocumentSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    placement: {
      ...PLACEMENT_SCHEMA,
      description:
        'ANCHOR-RELATIONAL crop (preferred over guessing pixels): a REGION relation (inside/gap) → the crop is the ' +
        'resolved region bounding box, verified by the gate. Crops ONLY if the gate PASSES. When set, ' +
        'left/top/right/bottom are ignored. See the placement-resolver tool, when this build has one, for the ' +
        'anchors + relation vocabulary.',
    },
    left: {
      type: 'integer',
      description: 'Left edge position in pixels (raw mode; ignored when placement is set).',
      minimum: 0,
      maximum: PS_MAX_DIM_PX,
    },
    top: {
      type: 'integer',
      description: 'Top edge position in pixels (raw mode; ignored when placement is set).',
      minimum: 0,
      maximum: PS_MAX_DIM_PX,
    },
    right: {
      type: 'integer',
      description: 'Right edge position in pixels (raw mode; ignored when placement is set).',
      minimum: 1,
      maximum: PS_MAX_DIM_PX,
    },
    bottom: {
      type: 'integer',
      description: 'Bottom edge position in pixels (raw mode; ignored when placement is set).',
      minimum: 1,
      maximum: PS_MAX_DIM_PX,
    },
  },
  // Either `placement` OR all four raw bounds — enforced in the handler (a JSON
  // schema can't express the exclusive-or, and required-bounds would reject placement).
};

const convertImageModeSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    mode: {
      type: 'string',
      enum: ['grayscale', 'rgb', 'cmyk', 'lab', 'bitmap'],
      description:
        'Target document color mode. grayscale discards color (the "Discard color information?" prompt is auto-confirmed); the document is FLATTENED as part of the conversion. `bitmap` produces a 1-bit halftone-screen image (auto-converts to grayscale first) — use frequency/angle/shape.',
    },
    frequency: {
      type: 'number',
      description: 'bitmap only: halftone screen frequency in lines/inch (1-999). PS default 53.',
      minimum: 1,
      maximum: 999,
      default: 53,
    },
    angle: {
      type: 'number',
      description: 'bitmap only: halftone screen angle in degrees (-180 to 180). PS default 45.',
      minimum: -180,
      maximum: 180,
      default: 45,
    },
    shape: {
      type: 'string',
      enum: ['round', 'diamond', 'ellipse', 'line', 'square', 'cross'],
      description: 'bitmap only: halftone dot shape.',
      default: 'round',
    },
  },
  required: ['mode'],
};

export function createImageTools(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  // Backs anchor-relational `placement` on ps_crop_document; only used when a
  // placement is supplied (raw-bounds crops never touch it).
  client: DetectionClient = new OnnxLandmarkDetectionClient()
): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'ps_resize_image',
        description:
          'Resize the entire document canvas (all layers) to the specified absolute dimensions. Destructive: downscaling permanently loses pixel data. Idempotent: same width/height always yield the same result. For aspect-preserving downscale during export, see ps_export (format=jpeg / png) which resize a duplicate. Returns updated document context.',
        inputSchema: resizeImageSchema,
        outputSchema: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            width: { type: 'number' },
            height: { type: 'number' },
            context: { type: 'object' },
          },
          required: ['success'],
        },
        annotations: {
          title: 'Resize Image (destructive)',
          destructiveHint: true,
          idempotentHint: true,
        },
      },
      handler: async (args) => resizeImage(connection, snippetClient, args),
    },
    {
      tool: {
        name: 'ps_crop_document',
        description:
          'Crop the document to a region — EITHER anchor-relational `placement` (preferred: a region relation like inside/gap → the crop is the resolved, gate-verified region bbox, no pixel-guessing) OR absolute pixel bounds (left/top/right/bottom in document space). Destructive: pixels outside the bounds are permanently lost. Idempotent for the same bounds. Returns updated document context.',
        inputSchema: cropDocumentSchema,
        outputSchema: {
          type: 'object',
          properties: {
            cropped: { type: 'boolean' },
            newWidth: { type: 'number' },
            newHeight: { type: 'number' },
            placement: {
              type: 'object',
              description:
                'Present when anchor-relational placement was used: the resolved region + gate verdict.',
              properties: {
                target: { type: 'string' },
                gate: { type: 'object' },
                anchors: { type: 'object' },
                geometry: { type: 'object' },
              },
            },
            context: { type: 'object' },
          },
        },
        annotations: {
          title: 'Crop Document (destructive)',
          destructiveHint: true,
          idempotentHint: true,
        },
      },
      handler: async (args) => cropDocument(connection, snippetClient, client, args),
    },
    {
      tool: {
        name: 'ps_convert_image_mode',
        description:
          'Convert the document color mode (grayscale / rgb / cmyk / lab). Destructive and document-wide: the image is FLATTENED and, for grayscale, color is discarded (the confirmation prompt is auto-accepted). Use grayscale as the base for halftone / line-art workflows, or rgb to bring a CMYK/Lab doc back for normal editing. Returns updated document context.',
        inputSchema: convertImageModeSchema,
        outputSchema: {
          type: 'object',
          properties: {
            converted: { type: 'boolean' },
            requested_mode: { type: 'string' },
            mode_before: { type: 'string' },
            mode_after: { type: 'string' },
            context: { type: 'object' },
          },
        },
        annotations: {
          title: 'Convert Image Mode (destructive)',
          destructiveHint: true,
          idempotentHint: true,
        },
      },
      handler: async (args) => convertImageMode(connection, snippetClient, args),
    },
  ];
}

async function resizeImage(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(resizeImageSchema, rawArgs);
    const width = args.width as number;
    const height = args.height as number;

    const script = await snippetClient.build('resizeImage', { width, height });
    const result = await runScript(connection, script);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Image resized to ${width}x${height}px`,
        },
      ],
      structuredContent: {
        success: true,
        ...(result as Record<string, unknown>),
      },
    };
  } catch (error) {
    return toolErrorResult('Error resizing image', error);
  }
}

async function convertImageMode(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: convertImageModeSchema,
    snippet: 'convertImageMode',
    errorPrefix: 'Error converting image mode',
    params: (args) => {
      const mode = args.mode as string;
      const params: Record<string, unknown> = { mode };
      if (mode === 'bitmap') {
        params.frequency = (args.frequency as number) ?? 53;
        params.angle = (args.angle as number) ?? 45;
        params.shape = (args.shape as string) ?? 'round';
      }
      return params;
    },
    successText: (_result, args) => `Document converted to ${args.mode as string} mode.`,
  });
}

async function cropDocument(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  client: DetectionClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(cropDocumentSchema, rawArgs);

    // Bounds from anchor-relational placement (resolved + gated) OR raw args.
    let left: number, top: number, right: number, bottom: number;
    let placementInfo:
      | {
          target: string;
          anchors: Record<string, { kind: string; center: { x: number; y: number } }>;
          geometry: { left: number; top: number; right: number; bottom: number };
        }
      | undefined;
    if (args.placement) {
      const rp = await resolveExpectedPlacement(
        connection,
        client,
        args.placement,
        'region',
        'crop'
      );
      ({ left, top, right, bottom } = rp.bbox);
      placementInfo = { target: rp.target, anchors: rp.anchors, geometry: rp.bbox };
    } else {
      for (const k of ['left', 'top', 'right', 'bottom'] as const) {
        if (typeof args[k] !== 'number') {
          throw new Error(
            `crop needs numeric left/top/right/bottom (missing ${k}), or a placement (anchors + a region relation).`
          );
        }
      }
      left = args.left as number;
      top = args.top as number;
      right = args.right as number;
      bottom = args.bottom as number;
    }

    const script = await snippetClient.build('cropDocument', { left, top, right, bottom });
    const result = (await runScript(connection, script)) as Record<string, unknown>;

    return {
      content: [
        {
          type: 'text' as const,
          text: placementInfo
            ? `Document cropped to [${left},${top},${right},${bottom}] (placement gate PASS)\nResult: ${JSON.stringify(result)}`
            : `Document cropped\nResult: ${JSON.stringify(result)}`,
        },
      ],
      structuredContent: placementInfo
        ? {
            ...result,
            placement: {
              target: placementInfo.target,
              gate: { pass: true },
              anchors: placementInfo.anchors,
              geometry: placementInfo.geometry,
            },
          }
        : result,
    };
  } catch (error) {
    return toolErrorResult('Error cropping document', error);
  }
}
