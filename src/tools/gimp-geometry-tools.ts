import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import type { GimpBackend } from '../backends/gimp/backend.js';
import { validateArgs, type JsonSchemaObject } from '../utils/validate.js';
import { toolGimpErrorResult, unknownDiscriminator } from '../utils/tool-helpers.js';
import { GIMP_IMAGE_PROP, runGimpTool, pickSchemaDeclaredKeys } from './gimp-shared.js';

/**
 * gimp_crop_document / gimp_resize_image / gimp_transform_canvas.
 *
 * Order matters (see gimp_overview / gimp_add_adjustment's description):
 * straighten / flip / resize FIRST, then crop, then add any MASKED
 * adjustment. Rotate, flip, and resize all REFUSE outright
 * (`invalid_argument`, naming the filters) when the image already has a
 * masked filter, or a filter with no ledger record (one whose mask can't be
 * checked, e.g. added in the GIMP GUI) — GIMP has no way to keep a filter's own baked-in mask
 * confinement aligned with those transforms (verified live: the filter's
 * confinement stays pinned to the PRE-transform pixel positions, silently
 * misaligned, or for resize appears to have no effect at all —
 * `bridge/ops.py`'s geometry-section comment). Crop is the one exception:
 * it verified correct and never refuses for this reason.
 */

const cropSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    image: GIMP_IMAGE_PROP,
    left: { type: 'number', description: 'Left edge of the new canvas, in document pixels.' },
    top: { type: 'number', description: 'Top edge of the new canvas, in document pixels.' },
    width: { type: 'number', minimum: 1, description: 'New canvas width, in pixels.' },
    height: { type: 'number', minimum: 1, description: 'New canvas height, in pixels.' },
  },
  required: ['image', 'left', 'top', 'width', 'height'],
};

const resizeSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    image: GIMP_IMAGE_PROP,
    width: {
      type: 'integer',
      minimum: 1,
      maximum: 30000,
      description:
        'Target width, px. With height, stretches to exactly that box. Alone, height is derived ' +
        "to keep aspect. Capped at 30000 px/side and 250 MP total (the bridge's DoS floor).",
    },
    height: {
      type: 'integer',
      minimum: 1,
      maximum: 30000,
      description: 'Target height, px. See width.',
    },
    long_edge: {
      type: 'integer',
      minimum: 1,
      maximum: 30000,
      description:
        'Scale so the longer side lands here, preserving aspect. Use this OR width/height.',
    },
  },
  required: ['image'],
};

const transformCanvasSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    image: GIMP_IMAGE_PROP,
    op: {
      type: 'string',
      enum: ['rotate', 'flip'],
      description:
        "'rotate' takes an arbitrary `degrees` (straighten) + `expand`. 'flip' takes `orientation`.",
    },
    degrees: {
      type: 'number',
      description:
        'rotate only. Arbitrary angle (straighten), not limited to 90° multiples. Positive rotates clockwise.',
    },
    expand: {
      type: 'boolean',
      default: false,
      description:
        "rotate only. Resize the canvas to the rotated content's new bounds (like Photoshop's " +
        '"reveal all"). Without it, rotated content can fall outside the original canvas and be cropped.',
    },
    orientation: {
      type: 'string',
      enum: ['horizontal', 'vertical'],
      description: 'flip only.',
    },
  },
  required: ['image', 'op'],
};

async function gimpTransformCanvas(
  gimp: GimpBackend,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(transformCanvasSchema, rawArgs);
    const op = args.op as string;
    // Unreachable while the schema's own enum stands (validateArgs already
    // refused anything outside it) — kept as defense-in-depth, the same
    // posture every other consolidated ps_* dispatcher takes (e.g. ps_select
    // in selection-tools.ts) for the day the enum is ever loosened.
    if (op !== 'rotate' && op !== 'flip') {
      return unknownDiscriminator('op', op, ['rotate', 'flip']);
    }
    const result = await gimp.call<{ width: number; height: number; degrees?: number }>(
      op,
      pickSchemaDeclaredKeys(transformCanvasSchema, args)
    );
    const text =
      op === 'rotate'
        ? `Rotated ${result.degrees}°. New canvas ${result.width}x${result.height}.`
        : `Flipped ${args.orientation as string}. Canvas ${result.width}x${result.height}.`;
    return {
      content: [{ type: 'text' as const, text }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  } catch (error) {
    return toolGimpErrorResult('Error transforming GIMP canvas', error);
  }
}

export function createGimpGeometryTools(gimp: GimpBackend): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'gimp_crop_document',
        description:
          'Headless GIMP: crop the canvas to an explicit rectangle (left, top, width, height in ' +
          'document pixels) — not a scale (that is gimp_resize_image). IRREVERSIBLE in this ' +
          'session: there is no undo, so gimp_save_xcf first when in doubt. Every live filter, ' +
          'mask channel, and the filter ledger survive a crop — verified live; it is the one ' +
          'geometry op that never refuses for masked-filter safety.',
        inputSchema: cropSchema,
        outputSchema: {
          type: 'object',
          properties: { width: { type: 'number' }, height: { type: 'number' } },
        },
        annotations: {
          title: 'Crop GIMP Document',
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      handler: async (args) =>
        runGimpTool({
          gimp,
          rawArgs: args,
          schema: cropSchema,
          op: 'crop',
          errorPrefix: 'Error cropping GIMP document',
          successText: (result) => {
            const r = result as { width: number; height: number };
            return `Cropped to ${r.width}x${r.height}.`;
          },
        }),
    },
    {
      tool: {
        name: 'gimp_resize_image',
        description:
          'Headless GIMP: scale the whole image up or down — not a crop (that is ' +
          'gimp_crop_document). Give width+height to stretch to an exact box, one alone to keep ' +
          'aspect, or long_edge to scale by the longer side. IRREVERSIBLE in this session: there ' +
          'is no undo, so gimp_save_xcf first when in doubt. REFUSES outright when the image has a ' +
          'masked filter, or any filter not created by Editmamei (for example one added ' +
          'in the GIMP GUI) — resize before adding any masked filter, not after. A large target (the ' +
          'bridge allows up to 250 megapixels / 30000px per side) can take tens of seconds; if it ' +
          'times out, the GIMP session restarts and any unsaved work — filters, masks, and any ' +
          'other open image — is lost, so save (gimp_save_xcf) before an aggressive resize.',
        inputSchema: resizeSchema,
        outputSchema: {
          type: 'object',
          properties: { width: { type: 'number' }, height: { type: 'number' } },
        },
        annotations: {
          title: 'Resize GIMP Image',
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      handler: async (args) =>
        runGimpTool({
          gimp,
          rawArgs: args,
          schema: resizeSchema,
          op: 'resize',
          errorPrefix: 'Error resizing GIMP image',
          successText: (result) => {
            const r = result as { width: number; height: number };
            return `Resized to ${r.width}x${r.height}.`;
          },
        }),
    },
    {
      tool: {
        name: 'gimp_transform_canvas',
        description:
          "Headless GIMP: op 'rotate' (arbitrary `degrees` — straighten — plus `expand`) | 'flip' " +
          '(`orientation` horizontal/vertical). IRREVERSIBLE in this session: there is no undo, so ' +
          'gimp_save_xcf first when in doubt. REFUSES outright when the image has a masked ' +
          'filter, or any filter not created by Editmamei (for example one added in the ' +
          'GIMP GUI) — straighten/flip before adding any masked filter, not after (crop is the ' +
          'one geometry op that is always safe afterward). A rotate to anything other than an ' +
          'exact 0/90/180/270 degrees is also refused while a position/direction-dependent ' +
          'filter is present, since only a right angle keeps such a filter locked to the content ' +
          '— rotate at a right angle instead, or delete/bake that filter first. Rotating a very ' +
          'large image can take tens of seconds; ' +
          'if it times out, the GIMP session restarts and any unsaved work — filters, masks, and ' +
          'any other open image — is lost, so save (gimp_save_xcf) before rotating a large canvas.',
        inputSchema: transformCanvasSchema,
        outputSchema: {
          type: 'object',
          properties: {
            width: { type: 'number' },
            height: { type: 'number' },
            degrees: { type: 'number' },
          },
        },
        annotations: {
          title: 'Transform GIMP Canvas',
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      handler: async (args) => gimpTransformCanvas(gimp, args),
    },
  ];
}
