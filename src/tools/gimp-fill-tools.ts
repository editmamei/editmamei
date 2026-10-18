import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import type { GimpBackend } from '../backends/gimp/backend.js';
import { GimpError } from '../backends/gimp/errors.js';
import type { JsonSchemaObject, JsonSchemaProperty } from '../utils/validate.js';
import {
  GIMP_IMAGE_PROP,
  GIMP_LAYER_ID_PROP,
  GIMP_LAYER_PROP,
  pickSchemaDeclaredKeys,
  runGimpTool,
} from './gimp-shared.js';

/**
 * gimp_fill — a new canvas-sized layer filled with a solid color or a linear / radial gradient
 * (`bridge/ops.py`'s `op_fill`). Points are image pixels. The layer goes directly above the target
 * layer, so the original stays untouched.
 */

/** Mirrors lib.py's FILL_MIN_STOPS / FILL_MAX_STOPS; a drift test pins them. */
export const FILL_MIN_STOPS = 2;
export const FILL_MAX_STOPS = 8;
const OPS = ['solid', 'linear_gradient', 'radial_gradient'] as const;
/** Mirrors lib.py's FILL_MODES (gimp_layer's blend modes plus lch_color); a drift test pins them. */
export const FILL_MODE_NAMES = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'soft_light',
  'hard_light',
  'darken',
  'lighten',
  'difference',
  'exclusion',
  'addition',
  'subtract',
  'divide',
  'dodge',
  'burn',
  'hue',
  'saturation',
  'color',
  'luminosity',
  'lch_color',
] as const;
/** Mirror lib.py's FILL_MAX_COORD_PX (10 x MAX_RESIZE_SIDE_PX) and FILL_MAX_STRING_LEN; a drift test pins them. */
export const FILL_MAX_COORD_PX = 300_000;
export const FILL_MAX_STRING_LEN = 255;
/** A gradient axis (start to end) must be at least this long. */
const MIN_AXIS_PX = 1;
const HEX = /^#[0-9a-fA-F]{6}$/;

const POINT_PROP: JsonSchemaProperty = {
  type: 'object',
  properties: {
    x: { type: 'number', minimum: -FILL_MAX_COORD_PX, maximum: FILL_MAX_COORD_PX },
    y: { type: 'number', minimum: -FILL_MAX_COORD_PX, maximum: FILL_MAX_COORD_PX },
  },
  required: ['x', 'y'],
};

const fillSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    image: GIMP_IMAGE_PROP,
    op: {
      type: 'string',
      enum: OPS,
      description:
        "'solid': one flat color. 'linear_gradient': a ramp from start to end. " +
        "'radial_gradient': a ramp from a center out to a radius.",
    },
    layer: {
      ...GIMP_LAYER_PROP,
      description:
        'Name of the layer the new fill layer goes directly above (inside its group). Defaults ' +
        'to the selected layer, or the topmost layer if none is selected.',
    },
    layer_id: GIMP_LAYER_ID_PROP,
    name: {
      type: 'string',
      description: "New layer's name. Default 'Fill' for solid, 'Gradient' for a gradient.",
    },
    color: {
      type: 'string',
      pattern: '^#[0-9a-fA-F]{6}$',
      description: 'solid only: the color as #rrggbb.',
    },
    stops: {
      type: 'array',
      minItems: FILL_MIN_STOPS,
      maxItems: FILL_MAX_STOPS,
      items: {
        type: 'object',
        properties: {
          offset: { type: 'number', minimum: 0, maximum: 1 },
          color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
          opacity: { type: 'number', minimum: 0, maximum: 100, default: 100 },
        },
        required: ['offset', 'color'],
      },
      description:
        'Gradient only: 2-8 color stops {offset 0..1, color #rrggbb, opacity 0..100}, sorted by ' +
        'offset. Colors blend in sRGB (a black to white stop pair reads 128 at the midpoint). ' +
        'Before the first stop and after the last, the end colors hold.',
    },
    start: {
      ...POINT_PROP,
      description:
        'linear_gradient: where offset 0 sits, in image pixels. Default top center of the canvas.',
    },
    end: {
      ...POINT_PROP,
      description:
        'linear_gradient: where offset 1 sits, in image pixels. Default bottom center of the canvas.',
    },
    center: {
      ...POINT_PROP,
      description: 'radial_gradient: where offset 0 sits, in image pixels. Default canvas center.',
    },
    radius: {
      type: 'number',
      minimum: 1,
      maximum: FILL_MAX_COORD_PX,
      description:
        'radial_gradient: the distance in pixels at which offset 1 is reached. Default half the ' +
        'canvas diagonal.',
    },
    mode: {
      type: 'string',
      enum: FILL_MODE_NAMES,
      default: 'normal',
      description:
        "The new layer's blend mode: gimp_layer's list plus 'lch_color'. 'color' is HSL Color; " +
        "'lch_color' (LCh Color) keeps the lightness underneath exactly and swaps only hue and " +
        'chroma, the better choice for recoloring.',
    },
    opacity: {
      type: 'number',
      minimum: 0,
      maximum: 100,
      default: 100,
      description: "The new layer's opacity, 0-100.",
    },
    mask: {
      type: 'string',
      description:
        "The name of a selection channel: becomes the new layer's layer mask, white " +
        'where the channel is selected, so the fill shows only there.',
    },
  },
  required: ['image', 'op'],
};

interface FillResult {
  layer_id: number;
  layer_name: string;
  op: string;
  mode: string;
  opacity: number;
  masked: boolean;
}

const bad = (message: string): never => {
  throw new GimpError('invalid_argument', message);
};

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function checkPoint(name: string, v: unknown): { x: number; y: number } {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || !isNum(o['x']) || !isNum(o['y'])) {
    return bad(`${name} must be {x, y} with finite numbers`);
  }
  if (Math.abs(o['x']) > FILL_MAX_COORD_PX || Math.abs(o['y']) > FILL_MAX_COORD_PX) {
    bad(`${name} must be within +/-${FILL_MAX_COORD_PX} px`);
  }
  return { x: o['x'], y: o['y'] };
}

/** The checks validateArgs cannot make: which fields each op takes, and the stop list's order. */
export function validateFillArgs(args: Record<string, unknown>): void {
  const op = args['op'];
  for (const k of ['name', 'mask']) {
    const v = args[k];
    if (typeof v === 'string' && v.length > FILL_MAX_STRING_LEN) {
      bad(`${k} must be at most ${FILL_MAX_STRING_LEN} characters`);
    }
  }
  const only = (keys: string[], why: string): void => {
    for (const k of keys) if (args[k] !== undefined) bad(`${k} does not apply to ${why}`);
  };
  if (op === 'solid') {
    if (typeof args['color'] !== 'string' || !HEX.test(args['color'])) {
      bad('color must be a color like #rrggbb for op solid');
    }
    only(['stops', 'start', 'end', 'center', 'radius'], 'op solid');
    return;
  }
  only(['color'], 'a gradient (give stops)');
  const stops = args['stops'];
  if (!Array.isArray(stops) || stops.length < FILL_MIN_STOPS || stops.length > FILL_MAX_STOPS) {
    bad(`stops must be a list of ${FILL_MIN_STOPS}..${FILL_MAX_STOPS} stops for op ${String(op)}`);
  }
  let previous = -1;
  (stops as unknown[]).forEach((s, i) => {
    const o = s as Record<string, unknown> | null;
    if (!o || typeof o !== 'object' || !isNum(o['offset']) || typeof o['color'] !== 'string') {
      return bad(`stops[${i}] must be {offset, color, opacity?}`);
    }
    if (!HEX.test(o['color'])) bad(`stops[${i}].color must be a color like #rrggbb`);
    if (o['offset'] < 0 || o['offset'] > 1) bad(`stops[${i}].offset must be within 0..1`);
    const opacity = o['opacity'];
    if (opacity !== undefined && (!isNum(opacity) || opacity < 0 || opacity > 100)) {
      bad(`stops[${i}].opacity must be within 0..100`);
    }
    if (o['offset'] < previous) bad(`stops must be sorted by offset: stops[${i}] is out of order`);
    previous = o['offset'];
  });
  if (op === 'linear_gradient') {
    only(['center', 'radius'], 'op linear_gradient');
    const start = args['start'] === undefined ? undefined : checkPoint('start', args['start']);
    const end = args['end'] === undefined ? undefined : checkPoint('end', args['end']);
    if (start && end && Math.hypot(end.x - start.x, end.y - start.y) < MIN_AXIS_PX) {
      bad(`start and end must be at least ${MIN_AXIS_PX} pixel apart`);
    }
  } else {
    only(['start', 'end'], 'op radial_gradient');
    if (args['center'] !== undefined) checkPoint('center', args['center']);
    const radius = args['radius'];
    if (radius !== undefined && (!isNum(radius) || radius < 1 || radius > FILL_MAX_COORD_PX)) {
      bad(`radius must be within 1..${FILL_MAX_COORD_PX} pixels`);
    }
  }
}

export function createGimpFillTools(gimp: GimpBackend): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'gimp_fill',
        description:
          'Headless GIMP: add a NEW layer, canvas-sized, filled with a solid color (op solid), a ' +
          'linear gradient (start to end) or a radial gradient (center and radius) through 2-8 ' +
          'color stops. The layer goes directly above the target layer (inside its group), with ' +
          'the blend mode and opacity you give; mode lch_color tints without touching lightness, ' +
          'the usual choice for recoloring. Pass mask (a channel name) to confine the fill to ' +
          'that channel: it becomes the layer mask. Gradients blend in sRGB, are not dithered, ' +
          'and use image pixels for every point. The current selection is kept and does not clip ' +
          'the fill. Do NOT use for painting strokes or touching up pixels; use gimp_retouch ' +
          'for that. Returns layer_id, layer_name, op, mode, opacity and masked.',
        inputSchema: fillSchema,
        outputSchema: {
          type: 'object',
          properties: {
            layer_id: { type: 'number' },
            layer_name: { type: 'string' },
            op: { type: 'string' },
            mode: { type: 'string' },
            opacity: { type: 'number' },
            masked: { type: 'boolean' },
          },
        },
        annotations: {
          title: 'Fill GIMP Layer',
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      handler: async (args): Promise<ToolResult> =>
        runGimpTool({
          gimp,
          rawArgs: args,
          schema: fillSchema,
          op: 'fill',
          errorPrefix: 'Error filling GIMP layer',
          params: (validated) => {
            validateFillArgs(validated);
            return pickSchemaDeclaredKeys(fillSchema, validated);
          },
          successText: (result) => {
            const r = result as unknown as FillResult;
            return (
              `Fill: ${r.op.replace('_', ' ')} on new layer "${r.layer_name}" (layer ${r.layer_id}), ` +
              `${r.mode} at ${r.opacity}%${r.masked ? ', masked' : ''}.`
            );
          },
        }),
    },
  ];
}

/** Exported for the schema-bounds drift test — see tests/tools/gimp-fill-tools.test.ts. */
export const FILL_SCHEMA_FOR_TESTS = fillSchema;
