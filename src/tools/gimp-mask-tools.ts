import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import type { GimpBackend } from '../backends/gimp/backend.js';
import { GIMP_IMAGE_PROP, runGimpTool } from './gimp-shared.js';
import type { JsonSchemaObject } from '../utils/validate.js';

/**
 * gimp_create_mask — a geometric mask baked into a NAMED channel
 * (`bridge/ops.py`'s `op_create_mask`). Loose twin of `ps_select` +
 * `ps_selection_channel` — deliberately different: the result is a channel
 * referenced BY NAME at filter-creation time (`gimp_add_adjustment`'s `mask`
 * field), never a floating selection state. The bridge explicitly clears
 * the active selection when this op finishes (`Gimp.Selection.none`) —
 * whatever selection existed while building the mask is gone by the time
 * this call returns, so the ONLY way to apply the mask is by name, via
 * `gimp_add_adjustment`'s `mask` field.
 *
 * `type: 'gradient_linear' | 'gradient_radial'` paints a ramp directly (no
 * feather — a gradient is already continuous); `invert` swaps which end is
 * black vs white for a gradient, or inverts the selection for
 * rectangle/ellipse.
 */

const createMaskSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    image: GIMP_IMAGE_PROP,
    type: {
      type: 'string',
      enum: ['rectangle', 'ellipse', 'gradient_linear', 'gradient_radial'],
      description:
        'rectangle/ellipse: geometric selection (needs x, y, width, height). gradient_linear: a ' +
        'ramp from (x1,y1) to (x2,y2), default the full image width. gradient_radial: a ramp from ' +
        'full effect at the center (cx,cy) fading to none at radius, default centered at the ' +
        "image's own center with radius = half the shorter side.",
    },
    name: {
      type: 'string',
      default: 'Mask',
      description:
        'Channel name — replaces any existing channel of the same name (refused if that name is ' +
        "already used as an existing filter's mask). Pass this name to gimp_add_adjustment's " +
        '`mask` field to confine a new filter to it.',
    },
    invert: {
      type: 'boolean',
      default: false,
      description:
        'rectangle/ellipse: invert the selection. gradient_linear/gradient_radial: swap which end ' +
        'is black vs white.',
    },
    feather_px: {
      type: 'number',
      minimum: 0,
      maximum: 1000,
      default: 0,
      description:
        'rectangle/ellipse only. Feather radius in pixels. No effect on a gradient (already continuous).',
    },
    x: { type: 'number', description: 'rectangle/ellipse: left edge, document pixels.' },
    y: { type: 'number', description: 'rectangle/ellipse: top edge, document pixels.' },
    width: { type: 'number', description: 'rectangle/ellipse: width, document pixels.' },
    height: { type: 'number', description: 'rectangle/ellipse: height, document pixels.' },
    x1: { type: 'number', description: 'gradient_linear: start point x. Default 0.' },
    y1: { type: 'number', description: 'gradient_linear: start point y. Default 0.' },
    x2: { type: 'number', description: "gradient_linear: end point x. Default the image's width." },
    y2: { type: 'number', description: 'gradient_linear: end point y. Default 0.' },
    cx: {
      type: 'number',
      description: "gradient_radial: center x. Default the image's own center.",
    },
    cy: {
      type: 'number',
      description: "gradient_radial: center y. Default the image's own center.",
    },
    radius: {
      type: 'number',
      description: 'gradient_radial: radius, document pixels. Default half the shorter image side.',
    },
  },
  required: ['image', 'type'],
};

export function createGimpMaskTools(gimp: GimpBackend): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'gimp_create_mask',
        description:
          'Headless GIMP: build a geometric mask (rectangle / ellipse / linear or radial gradient) ' +
          'into a NAMED channel. The active selection is CLEARED when this call returns — it does ' +
          'NOT leave the mask selected the way a Photoshop selection would. Pass the returned ' +
          "`channel` name to gimp_add_adjustment's `mask` field WHEN CREATING a new filter — that " +
          "is the ONLY way to apply it — a filter's mask is fixed at creation and cannot be " +
          'changed on a re-edit. Order matters: straighten / flip / resize the canvas FIRST (see ' +
          'gimp_transform_canvas, gimp_resize_image), then crop, then create masks and masked ' +
          'adjustments — rotate, flip, and resize all refuse outright once ANY masked adjustment ' +
          'filter exists on the image, or any filter not created by Editmamei (for example one ' +
          'added in the GIMP GUI).',
        inputSchema: createMaskSchema,
        outputSchema: {
          type: 'object',
          properties: {
            channel: { type: 'string' },
            selected_pixels: { type: 'number' },
            fraction: { type: 'number' },
          },
        },
        annotations: {
          title: 'Create GIMP Mask',
          readOnlyHint: false,
          destructiveHint: true, // replaces a same-named channel not in use by a filter
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      handler: async (args): Promise<ToolResult> =>
        runGimpTool({
          gimp,
          rawArgs: args,
          schema: createMaskSchema,
          op: 'create_mask',
          errorPrefix: 'Error creating GIMP mask',
          successText: (result) => {
            const r = result as { channel: string; selected_pixels: number; fraction: number };
            return `Created mask channel "${r.channel}" — ${(r.fraction * 100).toFixed(1)}% of pixels selected.`;
          },
        }),
    },
  ];
}
