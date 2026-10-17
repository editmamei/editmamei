import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import type { GimpBackend } from '../backends/gimp/backend.js';
import { GimpError } from '../backends/gimp/errors.js';
import type { JsonSchemaObject } from '../utils/validate.js';
import {
  GIMP_IMAGE_PROP,
  GIMP_LAYER_ID_PROP,
  GIMP_LAYER_PROP,
  pickSchemaDeclaredKeys,
  runGimpTool,
} from './gimp-shared.js';

/**
 * gimp_retouch — heal, clone or spot-heal pixels (`bridge/ops.py`'s `op_retouch`). Strokes, sources
 * and spots are image pixels, so a layer with an offset needs no conversion. By default the paint
 * lands on a 'Retouch' copy directly above the target layer, so the original stays untouched.
 */

/** Mirrors the bounds in bridge/lib.py (RETOUCH_*); a drift test pins them. */
export const RETOUCH_MAX_POINTS = 500;
export const RETOUCH_MAX_SPOTS = 50;
export const RETOUCH_MAX_BRUSH = 1000;
export const RETOUCH_MAX_SPOT_RADIUS = 500;
/** Work budgets (bridge/lib.py): a stroke costs (path length + one brush) x brush, spots cost the
 * sum of radius squared. */
export const RETOUCH_MAX_STROKE_WORK = 2000000;
export const RETOUCH_MAX_SPOT_WORK = 200000;
const METHODS = ['heal', 'clone', 'spot_heal'] as const;
const TARGETS = ['retouch_layer', 'in_place'] as const;

const retouchSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    image: GIMP_IMAGE_PROP,
    layer: {
      ...GIMP_LAYER_PROP,
      description:
        'Name of the pixel layer to retouch. Defaults to the selected layer, or the topmost layer ' +
        'if none is selected.',
    },
    layer_id: GIMP_LAYER_ID_PROP,
    method: {
      type: 'string',
      enum: METHODS,
      description:
        "'heal': paint a stroke that blends the sampled texture into its surroundings (blemishes, " +
        "dust, scratches). 'clone': paint a stroke that copies the sampled pixels exactly. " +
        "'spot_heal': round spots, each healed from an automatically chosen nearby source.",
    },
    points: {
      type: 'array',
      minItems: 1,
      maxItems: RETOUCH_MAX_POINTS,
      items: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } },
      description:
        'heal / clone: the stroke as [[x, y], ...] in image pixels (1-500 points), every one ' +
        'inside the layer.',
    },
    source: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' } },
      required: ['x', 'y'],
      description:
        'heal / clone: the image-pixel point to sample for points[0]; the rest of the stroke ' +
        'samples at the same offset. Give this OR source_offset.',
    },
    source_offset: {
      type: 'object',
      properties: { dx: { type: 'number' }, dy: { type: 'number' } },
      required: ['dx', 'dy'],
      description:
        'heal / clone: sample this many pixels from each stroke point (source = point + offset). ' +
        'Give this OR source.',
    },
    brush_size: {
      type: 'number',
      minimum: 1,
      maximum: RETOUCH_MAX_BRUSH,
      default: 20,
      description: 'heal / clone: brush diameter in pixels. spot_heal sizes its own brush.',
    },
    hardness: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description:
        'heal / clone: brush edge hardness, 0 soft to 1 hard. Default 0.5 for heal, 0.8 for ' +
        'clone. Not allowed with spot_heal.',
    },
    source_layer_id: {
      ...GIMP_LAYER_ID_PROP,
      description:
        'clone only: sample from this pixel layer instead of the one being painted. The source ' +
        'point plus the stroke must lie inside it.',
    },
    spots: {
      type: 'array',
      minItems: 1,
      maxItems: RETOUCH_MAX_SPOTS,
      items: {
        type: 'object',
        properties: { x: { type: 'number' }, y: { type: 'number' }, radius: { type: 'number' } },
        required: ['x', 'y', 'radius'],
      },
      description:
        'spot_heal: [{x, y, radius}] in image pixels (1-50 spots, radius 1-500). The source for ' +
        'each is picked from 8 directions at about 2.2x and 3.5x the radius, by how closely its ' +
        'brightness and texture match the ring around the spot. Every source is chosen before ' +
        'anything is painted, so a spot with no usable source fails the whole call unchanged.',
    },
    target: {
      type: 'string',
      enum: TARGETS,
      default: 'retouch_layer',
      description:
        "'retouch_layer': paint on a 'Retouch' copy directly above the layer (made on the first " +
        'call, reused while it stays directly above the layer it was made from); needs a Normal ' +
        "mode, 100% opacity layer without a layer mask. 'in_place': paint the layer itself.",
    },
  },
  required: ['image', 'method'],
};

interface RetouchResult {
  layer_id: number;
  layer_name: string;
  created_layer: boolean;
  method: string;
  painted_bbox: number[];
  spots?: Array<{
    x: number;
    y: number;
    radius: number;
    source_dx: number;
    source_dy: number;
    score: number;
  }>;
}

const bad = (message: string): never => {
  throw new GimpError('invalid_argument', message);
};

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function checkXY(name: string, v: unknown, keys: [string, string]): void {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || !isNum(o[keys[0]]) || !isNum(o[keys[1]])) {
    bad(`${name} must be {${keys[0]}, ${keys[1]}} with finite numbers`);
  }
}

/** The checks validateArgs cannot make: which fields each method needs, and element shapes. */
export function validateRetouchArgs(args: Record<string, unknown>): void {
  const method = args['method'];
  if (method === 'spot_heal') {
    const spots = args['spots'];
    if (!Array.isArray(spots) || spots.length < 1 || spots.length > RETOUCH_MAX_SPOTS) {
      bad(`spots must be a list of 1..${RETOUCH_MAX_SPOTS} spots for method spot_heal`);
    }
    (spots as unknown[]).forEach((s, i) => {
      checkXY(`spots[${i}]`, s, ['x', 'y']);
      const r = (s as Record<string, unknown>)['radius'];
      if (!isNum(r) || r < 1 || r > RETOUCH_MAX_SPOT_RADIUS) {
        bad(`spots[${i}].radius must be within 1..${RETOUCH_MAX_SPOT_RADIUS}`);
      }
    });
    for (const k of ['points', 'source', 'source_offset', 'source_layer_id', 'hardness']) {
      if (args[k] !== undefined) bad(`${k} does not apply to method spot_heal`);
    }
    const spotWork = (spots as Array<{ radius: number }>).reduce((a, sp) => a + sp.radius ** 2, 0);
    if (spotWork > RETOUCH_MAX_SPOT_WORK) {
      bad(
        'these spots are too large to heal in one call: split them into several calls or use ' +
          `smaller radii (the sum of radius squared is ${spotWork}, the limit is ${RETOUCH_MAX_SPOT_WORK})`
      );
    }
    return;
  }
  const points = args['points'];
  if (!Array.isArray(points) || points.length < 1 || points.length > RETOUCH_MAX_POINTS) {
    bad(
      `points must be a list of 1..${RETOUCH_MAX_POINTS} [x, y] points for method ${String(method)}`
    );
  }
  (points as unknown[]).forEach((p, i) => {
    if (!Array.isArray(p) || p.length !== 2 || !isNum(p[0]) || !isNum(p[1])) {
      bad(`points[${i}] must be [x, y] with finite numbers`);
    }
  });
  const hasSource = args['source'] !== undefined;
  const hasOffset = args['source_offset'] !== undefined;
  if (hasSource === hasOffset) bad('give exactly one of source {x, y} or source_offset {dx, dy}');
  if (hasSource) checkXY('source', args['source'], ['x', 'y']);
  else checkXY('source_offset', args['source_offset'], ['dx', 'dy']);
  if (args['spots'] !== undefined) bad(`spots does not apply to method ${String(method)}`);
  const brush = (args['brush_size'] as number | undefined) ?? 20;
  const pts = points as number[][];
  let length = 0;
  for (let i = 1; i < pts.length; i++) {
    length += Math.hypot(pts[i]![0]! - pts[i - 1]![0]!, pts[i]![1]! - pts[i - 1]![1]!);
  }
  const strokeWork = (length + brush) * brush;
  if (strokeWork > RETOUCH_MAX_STROKE_WORK) {
    bad(
      'this stroke is too long for its brush size to paint in one call: split the stroke into ' +
        'several calls or use a smaller brush ' +
        `(about ${Math.round(strokeWork)} px of path x brush, the limit is ${RETOUCH_MAX_STROKE_WORK})`
    );
  }
  if (method === 'heal' && args['source_layer_id'] !== undefined) {
    bad('source_layer_id applies to method clone only');
  }
}

export function createGimpRetouchTools(gimp: GimpBackend): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'gimp_retouch',
        description:
          'Headless GIMP: heal or clone pixels with a round brush. method heal paints a stroke ' +
          'that samples texture from elsewhere and blends it into its surroundings, for blemishes, ' +
          'dust and scratches; clone paints a stroke that copies the sampled pixels exactly; ' +
          "spot_heal takes round spots {x, y, radius} and picks each one's source automatically, " +
          'from the nearby area whose brightness and texture best match the ring around the spot. ' +
          'Everything is in image pixels. By default (target retouch_layer) the paint lands on a ' +
          '"Retouch" copy of the layer directly above it, shown only where you painted, so the ' +
          'original and the picture everywhere else stay untouched; later calls reuse that copy ' +
          'while it stays directly above the layer it was made from. target in_place paints the ' +
          'layer itself, and is required for a layer that is below 100% opacity, not in Normal ' +
          'mode, or has a layer mask; a layer with semi-transparent pixels also shows its original ' +
          'through the copy, so use in_place there. The current selection is kept and does not clip the ' +
          'retouch. Refuses layer groups, text layers, locked or hidden layers, indexed images, ' +
          'and any point or spot outside the layer. A call has a work limit (a long stroke with a ' +
          'big brush, or many large spots): split it into several calls or use a smaller brush. ' +
          'Do NOT use for removing whole objects; a stroke or spot only blends in texture ' +
          'at the size of the brush. Returns layer_id, layer_name, created_layer, painted_bbox ' +
          "[x, y, w, h] and, for spot_heal, each spot's chosen source offset and score (lower is " +
          'a closer match).',
        inputSchema: retouchSchema,
        outputSchema: {
          type: 'object',
          properties: {
            layer_id: { type: 'number' },
            layer_name: { type: 'string' },
            created_layer: { type: 'boolean' },
            method: { type: 'string' },
            target: { type: 'string' },
            painted_bbox: { type: 'array' },
            spots: { type: 'array' },
            brush_size: { type: 'number' },
            hardness: { type: 'number' },
          },
        },
        annotations: {
          title: 'Retouch GIMP Layer',
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      handler: async (args): Promise<ToolResult> =>
        runGimpTool({
          gimp,
          rawArgs: args,
          schema: retouchSchema,
          op: 'retouch',
          errorPrefix: 'Error retouching GIMP layer',
          params: (validated) => {
            validateRetouchArgs(validated);
            return pickSchemaDeclaredKeys(retouchSchema, validated);
          },
          successText: (result) => {
            const r = result as unknown as RetouchResult;
            const [x, y, w, h] = r.painted_bbox;
            const what = r.spots
              ? `${r.spots.length} spot(s) healed`
              : r.method === 'clone'
                ? 'cloned'
                : 'healed';
            return (
              `Retouch: ${what} on "${r.layer_name}" (layer ${r.layer_id}` +
              `${r.created_layer ? ', new Retouch layer' : ''}), painted area ${w}x${h} at ${x},${y}.`
            );
          },
        }),
    },
  ];
}

/** Exported for the schema-bounds drift test — see tests/tools/gimp-retouch-tools.test.ts. */
export const RETOUCH_SCHEMA_FOR_TESTS = retouchSchema;
