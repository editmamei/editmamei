import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import type { SnippetClient } from '../api/snippet-client.js';
import { runScript } from '../utils/run-script.js';
import { validateArgs, type JsonSchemaObject } from '../utils/validate.js';
import { toolErrorResult } from '../utils/tool-helpers.js';
import { type DetectionClient } from '../detection/detection-client.js';
import { OnnxLandmarkDetectionClient } from '../detection/landmark-detection-client.js';
import { resolveExpectedPlacement, PLACEMENT_SCHEMA } from '../perception/grounding-locate.js';

/**
 * ps_shape — create a real vector SHAPE layer (rectangle / ellipse /
 * line), geometry baked in ABSOLUTE document pixels. Ground truth: ScriptListener
 * captures (rectangle/rounded = Rctn, ellipse = Elps, line = Ln).
 *
 * TWO ways to aim it:
 *  - raw document-pixel coordinates (only as good as the model's ability to choose
 *    them — the reason this tool is held at DEV tier), or
 *  - `placement`: NAME anchors + a relation and let the spatial-grounding resolver
 *    compute the geometry, VERIFIED by the objective gate — the
 *    "don't guess a pixel" path. rectangle/ellipse ← a region relation; line ← a
 *    path relation (along/offset-curve). The shape is created only if the gate PASSES.
 *
 * Polygon + custom shapes are intentionally out of v1 (polygon = a large derived-quad
 * descriptor that doesn't synthesize reliably; custom = a named-preset reference).
 */

const SHAPE_TYPES = ['rectangle', 'ellipse', 'line'] as const;

const rgbColorFragment = {
  type: 'object' as const,
  description: 'RGB color 0-255.',
  properties: {
    r: { type: 'number' as const, minimum: 0, maximum: 255 },
    g: { type: 'number' as const, minimum: 0, maximum: 255 },
    b: { type: 'number' as const, minimum: 0, maximum: 255 },
  },
  required: ['r', 'g', 'b'],
};

const shapeInputSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: [...SHAPE_TYPES],
      description:
        'rectangle: a box (left/top/right/bottom; corner_radius>0 rounds the corners). ' +
        'ellipse: an oval in the left/top/right/bottom bounding box. ' +
        'line: a straight line from (start_x,start_y) to (end_x,end_y) with `weight` thickness.',
    },
    placement: {
      ...PLACEMENT_SCHEMA,
      description:
        'ANCHOR-RELATIONAL placement (preferred over guessing pixels): rectangle/ellipse ← a region relation ' +
        '(inside/gap) → the resolved region bounding box; line ← a path relation (along/offset-curve over a traced ' +
        'edge or a Pro face-mesh landmark curve) → a straight line between the resolved curve endpoints. The shape ' +
        'is created ONLY if the gate PASSES (otherwise an error and no layer). When set, left/top/right/bottom and ' +
        'start_x/start_y/end_x/end_y are ignored, but styling (fill_color/stroke/weight/corner_radius) still ' +
        'applies. See the placement-resolver tool, when this build has one, for the anchors + relation vocabulary.',
    },
    // rectangle / ellipse bounding box (ABSOLUTE document pixels, top-left origin)
    left: {
      type: 'number',
      description: 'rectangle/ellipse: bounding-box left edge, document px.',
    },
    top: { type: 'number', description: 'rectangle/ellipse: bounding-box top edge, document px.' },
    right: {
      type: 'number',
      description: 'rectangle/ellipse: bounding-box right edge, document px.',
    },
    bottom: {
      type: 'number',
      description: 'rectangle/ellipse: bounding-box bottom edge, document px.',
    },
    corner_radius: {
      type: 'number',
      description:
        'rectangle only: corner radius in px. 0 (default) = sharp corners; >0 = rounded.',
      minimum: 0,
      default: 0,
    },
    // line endpoints (ABSOLUTE document pixels)
    start_x: { type: 'number', description: 'line: start point X, document px.' },
    start_y: { type: 'number', description: 'line: start point Y, document px.' },
    end_x: { type: 'number', description: 'line: end point X, document px.' },
    end_y: { type: 'number', description: 'line: end point Y, document px.' },
    weight: {
      type: 'number',
      description: 'line only: line thickness in px. Default 4.',
      minimum: 0.1,
      default: 4,
    },
    fill_color: {
      ...rgbColorFragment,
      description: 'Fill color (the line color for type=line). RGB 0-255. Default black.',
    },
    stroke_width: {
      type: 'number',
      description:
        'rectangle/ellipse: outline width in px. 0 (default) = no stroke (fill only). Ignored for line (use weight).',
      minimum: 0,
      default: 0,
    },
    stroke_color: {
      ...rgbColorFragment,
      description: 'rectangle/ellipse stroke color when stroke_width>0. RGB 0-255. Default black.',
    },
    into_active_group: {
      type: 'boolean',
      description:
        "Photoshop's Mk-contentLayer descriptor carries no placement target, so with a GROUP active it would natively nest the new shape layer INSIDE that group. Default false hoists the new layer back out so it lands above the active layer/group as a sibling. Pass true to keep it nested inside the active group instead.",
      default: false,
    },
  },
  required: ['type'],
};

export function createShapeTools(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  // The detection client backs anchor-relational `placement`; defaults to the Pro
  // landmark backend (degrades to CE boxes when the Pro model is absent). Only used
  // when a `placement` is supplied — raw-coordinate shapes never touch it.
  client: DetectionClient = new OnnxLandmarkDetectionClient()
): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'ps_shape',
        description:
          "Draw a vector SHAPE layer — `rectangle` (optionally rounded via corner_radius), `ellipse`, or `line` — filled with a solid color, optionally stroked. Hoisted out of the active layer's group by default even though the underlying Mk-contentLayer descriptor carries no placement target and would otherwise nest the new layer INSIDE that group (pass into_active_group:true to keep that native nesting). Aim it EITHER by anchor-relational `placement` (preferred: name anchors + a relation and the resolver computes the geometry, verified by an objective gate — no pixel-guessing; rectangle/ellipse ← a region relation, line ← a path relation) OR by ABSOLUTE document pixels (top-left origin: rectangle/ellipse take left/top/right/bottom; line takes start_x/start_y → end_x/end_y plus weight — you must know the pixel positions, so prefer the anchor-relational `placement` path above and verify the result with a preview). Creates a new vector layer (non-destructive — delete it to remove). (AM-only; verified live on PS 27.2.0.)",
        inputSchema: shapeInputSchema,
        outputSchema: {
          type: 'object',
          properties: {
            shape_created: { type: 'boolean' },
            shape_type: { type: 'string' },
            layer_name: { type: 'string' },
            stroked: { type: 'boolean' },
            hoisted: {
              type: 'boolean',
              description:
                'True when the new layer had to be moved back out of the previously-active group to honor into_active_group:false (the default). False when it landed correctly on its own, or when the move-back itself failed — check the layer tree if this matters and hoisted is false.',
            },
            parent_path: {
              type: ['array', 'null'],
              items: { type: 'string' },
              description:
                'The containing-group name chain (outermost first), empty array at the document root.',
            },
            placement: {
              type: 'object',
              description:
                'Present when anchor-relational placement was used: the resolved geometry + gate verdict.',
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
          title: 'Shape',
          idempotentHint: false,
        },
      },
      handler: async (args) => createShape(connection, snippetClient, client, args),
    },
  ];
}

function colorParams(
  color: unknown,
  prefix: 'fill' | 'stroke',
  params: Record<string, unknown>
): void {
  const c = (color as { r?: number; g?: number; b?: number } | undefined) ?? { r: 0, g: 0, b: 0 };
  params[`${prefix}R`] = c.r ?? 0;
  params[`${prefix}G`] = c.g ?? 0;
  params[`${prefix}B`] = c.b ?? 0;
}

interface PlacementInfo {
  target: string;
  anchors: Record<string, { kind: string; center: { x: number; y: number } }>;
  /** The resolved shape geometry keys (left/top/right/bottom or startX/…/endY), rounded. */
  geometry: Record<string, number>;
  /** Human-readable coordinate summary for the result text. */
  summary: string;
}

async function createShape(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  client: DetectionClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(shapeInputSchema, rawArgs);
    const type = args.type as (typeof SHAPE_TYPES)[number];

    const params: Record<string, unknown> = { shapeType: type };

    // Geometry: anchor-relational placement (resolved + gated) OR raw coordinates.
    // rectangle/ellipse consume a region bbox; line consumes a path's endpoints.
    let placementInfo: PlacementInfo | undefined;
    if (args.placement && type === 'line') {
      const rp = await resolveExpectedPlacement(connection, client, args.placement, 'path', 'line');
      const start = rp.curve[0];
      const end = rp.curve[rp.curve.length - 1];
      const geometry = { startX: start.x, startY: start.y, endX: end.x, endY: end.y };
      Object.assign(params, geometry);
      placementInfo = {
        target: rp.target,
        anchors: rp.anchors,
        geometry,
        summary: `(${start.x},${start.y})→(${end.x},${end.y})`,
      };
    } else if (args.placement) {
      const rp = await resolveExpectedPlacement(connection, client, args.placement, 'region', type);
      const geometry = { ...rp.bbox };
      Object.assign(params, geometry);
      placementInfo = { target: rp.target, anchors: rp.anchors, geometry, summary: rp.summary };
    } else if (type === 'rectangle' || type === 'ellipse') {
      for (const k of ['left', 'top', 'right', 'bottom'] as const) {
        if (typeof args[k] !== 'number') {
          throw new Error(`${type} requires numeric left/top/right/bottom (missing ${k})`);
        }
        params[k] = args[k];
      }
    } else {
      const map = {
        start_x: 'startX',
        start_y: 'startY',
        end_x: 'endX',
        end_y: 'endY',
      } as const;
      for (const k of Object.keys(map) as (keyof typeof map)[]) {
        if (typeof args[k] !== 'number') {
          throw new Error(`line requires numeric start_x/start_y/end_x/end_y (missing ${k})`);
        }
        params[map[k]] = args[k];
      }
    }

    // Styling (shared across the placement + raw-coordinate paths).
    if (type === 'rectangle') params.cornerRadius = (args.corner_radius as number) ?? 0;
    else if (type === 'ellipse') params.cornerRadius = 0;
    else params.weight = (args.weight as number) ?? 4;

    colorParams(args.fill_color, 'fill', params);
    params.into_active_group = (args.into_active_group as boolean) ?? false;
    if (type !== 'line') {
      params.strokeWidth = (args.stroke_width as number) ?? 0;
      colorParams(args.stroke_color, 'stroke', params);
    }

    const script = await snippetClient.build('createShape', params);
    const result = (await runScript(connection, script)) as Record<string, unknown>;

    return {
      content: [
        {
          type: 'text' as const,
          text: placementInfo
            ? `Created ${type} shape layer "${String(result.layer_name ?? '')}" at ${placementInfo.summary} (placement gate PASS).`
            : `Created ${type} shape layer "${String(result.layer_name ?? '')}".`,
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
    return toolErrorResult('Error in ps_shape', error);
  }
}
