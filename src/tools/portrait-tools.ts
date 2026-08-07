/**
 * ps_portrait_touchup — detection-driven face edits.
 *
 * Orchestrates the local face detector + existing Photoshop primitives. CE ops
 * work from the face BOUNDING BOX (precise landmark ops — brighten just the
 * eyes, whiten teeth — are the Pro deep-model tier):
 *   - dodge_face:  brighten the face region with a masked adjustment layer
 *                  (non-destructive; the mask is a feathered ellipse per face).
 *   - soften_skin: a soft blur over the face region on a duplicate layer (a
 *                  light, bbox-level skin smooth — not landmark frequency-sep).
 *
 * Read-modify of the document — NOT read-only.
 */
import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import type { SnippetClient } from '../api/snippet-client.js';
import { runScript } from '../utils/run-script.js';
import { validateArgs, type JsonSchemaObject } from '../utils/validate.js';
import { detectActiveDoc } from '../detection/detect-active-doc.js';
import {
  OnnxDetectionClient,
  type DetectionClient,
  type DetectedFace,
} from '../detection/detection-client.js';
import { toolErrorResult } from '../utils/tool-helpers.js';

const PORTRAIT_OPS = ['dodge_face', 'soften_skin'] as const;

const portraitSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    op: {
      type: 'string',
      enum: [...PORTRAIT_OPS],
      description:
        'dodge_face: brighten the detected face(s) with a masked adjustment layer (non-destructive). soften_skin: a soft blur over the face(s) on a duplicate layer (light bbox-level smoothing).',
    },
    amount: {
      type: 'number',
      description:
        'dodge_face: brightening 1–100 (default 25). soften_skin: extra blur multiplier 0.5–3 (default 1, scaled to face size).',
    },
    face_threshold: {
      type: 'number',
      default: 0.7,
      minimum: 0,
      maximum: 1,
      description: 'Minimum face confidence (0–1).',
    },
    max_dimension: {
      type: 'number',
      default: 1024,
      minimum: 256,
      maximum: 4096,
      description:
        'Long-edge px of the detection export. Coordinates always return in document px.',
    },
  },
  required: ['op'],
};

/** Select a feathered ellipse over each face box (union). */
async function selectFaceEllipses(
  connection: PhotoshopConnection,
  snippet: SnippetClient,
  faces: DetectedFace[]
): Promise<void> {
  for (let i = 0; i < faces.length; i++) {
    const [l, t, r, b] = faces[i].bbox;
    const feather = Math.max(4, Math.round(Math.min(r - l, b - t) * 0.08));
    await runScript(
      connection,
      await snippet.build('selectEllipse', {
        left: l,
        top: t,
        right: r,
        bottom: b,
        featherPx: feather,
        antiAlias: true,
        selectionType: i === 0 ? 'replace' : 'add',
      })
    );
  }
}

async function runPortraitOp(
  connection: PhotoshopConnection,
  snippet: SnippetClient,
  client: DetectionClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(portraitSchema, rawArgs);
    const op = args.op as (typeof PORTRAIT_OPS)[number];

    const det = await detectActiveDoc(connection, client, {
      faces: true,
      maxDimension: args.max_dimension as number | undefined,
      faceThreshold: args.face_threshold as number | undefined,
    });
    const faces = det.result.faces ?? [];
    if (faces.length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'No faces detected. Try lowering face_threshold, or confirm the subject is forward-facing.',
          },
        ],
        isError: true,
      };
    }

    let summary = '';
    try {
      await selectFaceEllipses(connection, snippet, faces);
      if (op === 'dodge_face') {
        const amount = Math.abs((args.amount as number) ?? 25);
        await runScript(
          connection,
          await snippet.build('addAdjustmentLayer', {
            type: 'brightness_contrast',
            brightness: amount,
            mask_from_selection: true,
            mask_inverted: false,
            clip_to_below: false,
            name: 'Face Dodge',
          })
        );
        summary = `Brightened ${faces.length} face${faces.length === 1 ? '' : 's'} (+${amount}) with a masked adjustment layer.`;
      } else {
        // soften_skin: soft blur over the face region on a duplicate layer.
        const mult = (args.amount as number) ?? 1;
        const minDim = Math.min(
          ...faces.map((f) => Math.min(f.bbox[2] - f.bbox[0], f.bbox[3] - f.bbox[1]))
        );
        const radius = Math.max(3, Math.round(minDim * 0.02 * mult));
        const r = (await runScript(
          connection,
          await snippet.build('applyGaussianBlur', { radius, applyToActiveLayer: false })
        )) as { target_layer_name?: string };
        summary = `Softened ${faces.length} face${faces.length === 1 ? '' : 's'} (blur ${radius}px) on a new layer (${r.target_layer_name ?? 'copy'}).`;
      }
    } finally {
      try {
        await runScript(connection, await snippet.build('deselect'));
      } catch {
        // best-effort cleanup
      }
    }

    return {
      content: [{ type: 'text' as const, text: summary }],
      structuredContent: {
        op,
        faces: faces.length,
        boxes: faces.map((f) => f.bbox),
        image: det.result.image,
        context: det.context,
      },
    };
  } catch (error) {
    return toolErrorResult('Error in ps_portrait_touchup', error);
  }
}

export function createPortraitTools(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  client: DetectionClient = new OnnxDetectionClient()
): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'ps_portrait_touchup',
        description:
          'Detection-driven face touch-ups using LOCAL on-device face detection. op=dodge_face brightens the detected face(s) with a non-destructive masked adjustment layer. op=soften_skin applies a soft blur over the face(s) on a duplicate layer (light, bounding-box-level smoothing). Works from the face bounding box — precise landmark ops (eyes/teeth/lips) are a Pro feature. Multiple faces are handled together. Pair with ps_detect (target=faces) to preview detection first.',
        inputSchema: portraitSchema,
        outputSchema: {
          type: 'object',
          properties: {
            op: { type: 'string' },
            faces: { type: 'number' },
            boxes: { type: 'array', items: { type: 'array', items: { type: 'number' } } },
            image: { type: 'object' },
            context: { type: 'object' },
          },
        },
        annotations: {
          title: 'Portrait Touch-up (detection-driven)',
          destructiveHint: true,
          openWorldHint: false,
        },
      },
      handler: async (args) => runPortraitOp(connection, snippetClient, client, args),
    },
  ];
}
