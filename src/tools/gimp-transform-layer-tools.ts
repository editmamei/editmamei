import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import type { GimpBackend } from '../backends/gimp/backend.js';
import { validateArgs, type JsonSchemaObject, type JsonSchemaProperty } from '../utils/validate.js';
import { toolGimpErrorResult, unknownDiscriminator } from '../utils/tool-helpers.js';
import {
  GIMP_IMAGE_PROP,
  GIMP_LAYER_PROP,
  GIMP_LAYER_ID_PROP,
  pickSchemaDeclaredKeys,
} from './gimp-shared.js';
import { EFFECT_UPDATE_FAILURES_PROP, effectUpdateFailuresNote } from './gimp-geometry-tools.js';

/**
 * gimp_transform_layer — the per-LAYER twin of ps_transform_layer, discriminated by `op`: fit |
 * scale | move | rotate | flip | skew | free. Distinct from `gimp_transform_canvas` (whole
 * canvas, every layer together) and from `gimp_layer` (structure/properties, no geometry).
 *
 * Addressing is the same as every other gimp_* layer op (`bridge/ops.py`'s `_layer`): `layer_id`
 * (canonical) takes priority over `layer` (name), neither given falls back to the selected
 * layer, or the topmost layer if none is selected.
 *
 * Verified live (GIMP 3.2.6): a layer's own mask transforms with it automatically for every op
 * here, and calling any of these on a GROUP layer transforms every descendant in lockstep with
 * the group. A text layer stays a text layer through every op, never rasterized (`text_layer`
 * in the result). `interpolation` is set explicitly via the GIMP Context before every call
 * (bracketed with a push/pop so it never leaks into a later, unrelated gimp_* call) rather than
 * left at whatever a prior call happened to set it to. A lock-position or lock-content layer is
 * refused outright rather than silently doing nothing.
 */

const TRANSFORM_LAYER_OPS = ['fit', 'scale', 'move', 'rotate', 'flip', 'skew', 'free'] as const;

const xyProp = (what: string): JsonSchemaProperty => ({
  type: 'object',
  description: `A document-pixel point: {x, y}. ${what}`,
  properties: { x: { type: 'number' }, y: { type: 'number' } },
  required: ['x', 'y'],
});

const transformLayerSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    image: GIMP_IMAGE_PROP,
    layer: {
      ...GIMP_LAYER_PROP,
      description: (GIMP_LAYER_PROP.description ?? '') + ' Ignored when layer_id is given.',
    },
    layer_id: GIMP_LAYER_ID_PROP,
    op: {
      type: 'string',
      enum: [...TRANSFORM_LAYER_OPS],
      description:
        "'fit' scales the layer to fit (letterbox) or fill (cover) the canvas, preserving " +
        "aspect, and centers it (mode fit|fill, idempotent). 'scale' is uniform (scale_percent) " +
        'or non-uniform (scale_x_percent/scale_y_percent) — multiplicative, anchored at the ' +
        "layer's own center; a NON-uniform scale is refused while an unmasked position/" +
        'direction-dependent effect filter (vignette/motion_blur/drop_shadow) is present. ' +
        "'move' translates — pass exactly ONE of delta (relative), absolute (top-left target), " +
        'or center_on (center target), each a {x, y} object (flat delta_x/absolute_x fields are ' +
        "not accepted); mixing modes is refused. 'rotate' rotates by relative degrees (positive " +
        "clockwise) around the layer's own center; the layer GROWS to fit the rotated content " +
        '— nothing is clipped; an arbitrary (non-90°-multiple) angle is refused while such an ' +
        "effect is present. 'flip' mirrors horizontal|vertical in place (axis). 'skew' slants " +
        "the layer (skew_h_degrees/skew_v_degrees) around its own center. 'free' is a numeric " +
        'free transform in one matrix: scale_x_percent/scale_y_percent + degrees + offset_x/' +
        'offset_y. skew and free are always refused while such an effect is present (no angle ' +
        'is safe for either). A text layer stays a text layer through every op, never ' +
        'rasterized.',
    },
    mode: {
      type: 'string',
      enum: ['fit', 'fill'],
      // No schema-level `default` -- every field here is flat across every op, so a default
      // would ride along on EVERY call regardless of op (the same "a default rides along on an
      // op that ignores it" behavior gimp_layer's own schema has), tripping the per-op foreign-
      // field check below on every op OTHER than fit. The bridge applies this op's own default
      // ('fit') itself when the field is genuinely absent.
      description:
        "fit only. 'fit' letterboxes inside the canvas (shorter edge touches); 'fill' covers it " +
        '(longer edge touches, overflow is left outside the canvas, not cropped). Defaults to ' +
        "'fit'.",
    },
    scale_percent: {
      type: 'number',
      minimum: 1,
      maximum: 10000,
      description: 'scale only. Uniform scale percentage (100 = unchanged). 1..10000.',
    },
    scale_x_percent: {
      type: 'number',
      minimum: 1,
      maximum: 10000,
      description:
        'scale/free: horizontal scale percentage (100 = unchanged), 1..10000. scale: pair with ' +
        'scale_y_percent for non-uniform stretch/squash; the other axis defaults to ' +
        'scale_percent, or 100 if that is absent too.',
    },
    scale_y_percent: {
      type: 'number',
      minimum: 1,
      maximum: 10000,
      description: 'scale/free: vertical scale percentage. See scale_x_percent.',
    },
    delta: xyProp(
      "move, RELATIVE mode: offset from the layer's current top-left. Mutually exclusive with absolute/center_on."
    ),
    absolute: xyProp(
      "move, ABSOLUTE mode: target for the layer's top-left corner. Mutually exclusive with delta/center_on."
    ),
    center_on: xyProp(
      "move, CENTER mode: target for the layer's center point. Mutually exclusive with delta/absolute."
    ),
    degrees: {
      type: 'number',
      description:
        "rotate: relative rotation angle, positive clockwise, around the layer's own center. " +
        'free: relative rotation angle (default 0), applied in the same combined matrix as the ' +
        'scale and offset.',
    },
    axis: {
      type: 'string',
      enum: ['horizontal', 'vertical'],
      description: "flip only. 'horizontal' mirrors left-right; 'vertical' mirrors top-bottom.",
    },
    skew_h_degrees: {
      type: 'number',
      description:
        'skew only. Horizontal slant angle in degrees — positive slants the top edge right. At ' +
        'least one of skew_h_degrees/skew_v_degrees is required.',
    },
    skew_v_degrees: {
      type: 'number',
      description:
        'skew only. Vertical slant angle in degrees — positive slants the left edge down.',
    },
    // No schema-level `default` on offset_x/offset_y, for the same reason `mode` has none --
    // the bridge defaults each to 0 itself when genuinely absent.
    offset_x: {
      type: 'number',
      minimum: -100000,
      maximum: 100000,
      description:
        'free only. Horizontal translation in document pixels, applied last. Defaults to 0.',
    },
    offset_y: {
      type: 'number',
      minimum: -100000,
      maximum: 100000,
      description:
        'free only. Vertical translation in document pixels, applied last. Defaults to 0.',
    },
    interpolation: {
      type: 'string',
      enum: ['none', 'linear', 'cubic', 'nohalo', 'lohalo'],
      default: 'cubic',
      description:
        'Resampling filter for this call, every op. Always set explicitly here — never carried ' +
        'over from a previous gimp_transform_layer call.',
    },
  },
  required: ['image', 'op'],
};

function boundsText(result: Record<string, unknown>): string {
  const b = result.bounds as { x: number; y: number; width: number; height: number } | undefined;
  return b ? `bounds now (${b.x}, ${b.y}) ${b.width}x${b.height}` : '';
}

function alphaNote(result: Record<string, unknown>): string {
  return result.alpha_added ? ' (alpha channel added)' : '';
}

function effectNote(result: Record<string, unknown>): string {
  return effectUpdateFailuresNote(result.effect_update_failures as string[] | undefined);
}

function transformLayerSuccessText(
  op: string,
  result: Record<string, unknown>,
  args: Record<string, unknown>
): string {
  switch (op) {
    case 'fit':
      return (
        `Layer ${result.mode === 'fill' ? 'filled' : 'fitted'} to the canvas and centered ` +
        `(${result.scale_percent as number}%), ${boundsText(result)}${alphaNote(result)}.` +
        effectNote(result)
      );
    case 'scale':
      return (
        `Layer scaled to ${result.scale_x_percent as number}% x ${result.scale_y_percent as number}%, ` +
        `${boundsText(result)}${alphaNote(result)}.${effectNote(result)}`
      );
    case 'move':
      return `Layer moved, ${boundsText(result)}${alphaNote(result)}.`;
    case 'rotate':
      return (
        `Layer rotated ${result.degrees as number}°, ${boundsText(result)}${alphaNote(result)}.` +
        effectNote(result)
      );
    case 'flip':
      return (
        `Layer flipped ${args.axis as string}, ${boundsText(result)}${alphaNote(result)}.` +
        effectNote(result)
      );
    case 'skew':
      return (
        `Layer skewed (h=${(result.skew_h_degrees as number) ?? 0}°, v=` +
        `${(result.skew_v_degrees as number) ?? 0}°), ${boundsText(result)}${alphaNote(result)}.`
      );
    default: // 'free'
      return `Layer free-transformed, ${boundsText(result)}${alphaNote(result)}.`;
  }
}

async function gimpTransformLayer(
  gimp: GimpBackend,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(transformLayerSchema, rawArgs);
    const op = args.op as string;
    // Unreachable while the schema's own enum stands (validateArgs already refused anything
    // outside it) — kept as defense-in-depth, the same posture every other consolidated
    // dispatcher in this file family takes.
    if (!TRANSFORM_LAYER_OPS.includes(op as (typeof TRANSFORM_LAYER_OPS)[number])) {
      return unknownDiscriminator('op', op, TRANSFORM_LAYER_OPS);
    }
    const result = await gimp.call<Record<string, unknown>>(
      'transform_layer',
      pickSchemaDeclaredKeys(transformLayerSchema, args)
    );
    return {
      content: [{ type: 'text' as const, text: transformLayerSuccessText(op, result, args) }],
      structuredContent: result,
    };
  } catch (error) {
    return toolGimpErrorResult('Error transforming GIMP layer', error);
  }
}

export function createGimpTransformLayerTools(gimp: GimpBackend): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'gimp_transform_layer',
        description:
          'Headless GIMP: transform the active layer (layer/layer_id) — op selects ' +
          'fit|scale|move|rotate|flip|skew|free, each documented on op. Rotate/skew/free grow ' +
          'the layer so nothing clips; a layer with no alpha gets one (alpha_added). REFUSES ' +
          "when the layer, or a group target's descendants, carries a masked filter, or an " +
          'unmasked effect this transform cannot keep locked to the content.',
        inputSchema: transformLayerSchema,
        outputSchema: {
          type: 'object',
          properties: {
            layer_id: { type: 'number' },
            bounds: {
              type: 'object',
              properties: {
                x: { type: ['number', 'null'] },
                y: { type: ['number', 'null'] },
                width: { type: 'number' },
                height: { type: 'number' },
              },
            },
            alpha_added: { type: 'boolean' },
            interpolation: { type: 'string' },
            text_layer: { type: 'boolean' },
            effect_update_failures: EFFECT_UPDATE_FAILURES_PROP,
            mode: { type: 'string' },
            scale_percent: { type: 'number' },
            scale_x_percent: { type: 'number' },
            scale_y_percent: { type: 'number' },
            degrees: { type: 'number' },
            axis: { type: 'string' },
            skew_h_degrees: { type: 'number' },
            skew_v_degrees: { type: 'number' },
            offset_x: { type: 'number' },
            offset_y: { type: 'number' },
          },
        },
        annotations: {
          title: 'Transform GIMP Layer',
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      handler: async (args) => gimpTransformLayer(gimp, args),
    },
  ];
}
