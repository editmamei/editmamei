import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import type { GimpBackend } from '../backends/gimp/backend.js';
import { validateArgs, type JsonSchemaObject } from '../utils/validate.js';
import { toolGimpErrorResult } from '../utils/tool-helpers.js';
import {
  GIMP_IMAGE_PROP,
  GIMP_LAYER_ID_PROP,
  GIMP_LAYER_PROP,
  GIMP_MAX_PX_PROP,
  readRender,
  defaultPreviewsAllowed,
  pickSchemaDeclaredKeys,
  runGimpTool,
  type GimpPreviewDeps,
} from './gimp-shared.js';

/**
 * Selection tools for GIMP: twins of ps_select, ps_modify_selection, ps_layer_mask and
 * ps_get_selection_preview. GIMP keeps no live selection between calls, so every result is a
 * saved selection in a NAMED channel — pass it to gimp_add_adjustment's `mask`, or turn it into a
 * real layer mask with gimp_layer_mask.
 */

const maskResultSchema = {
  type: 'object',
  properties: {
    channel: { type: 'string' },
    selected_pixels: { type: 'number' },
    fraction: { type: 'number' },
  },
} as const;

const maskText = (result: unknown): string => {
  const r = result as { channel: string; fraction: number };
  return `Channel "${r.channel}" — ${(r.fraction * 100).toFixed(1)}% of pixels selected.`;
};

const layerMaskResultSchema = {
  type: 'object',
  properties: {
    layer: { type: 'string' },
    layer_id: { type: 'integer' },
    op: { type: 'string' },
    has_mask: { type: 'boolean' },
  },
} as const;

const selectionPreviewResultSchema = {
  type: 'object',
  properties: {
    width: { type: 'number' },
    height: { type: 'number' },
  },
} as const;

const selectSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    image: GIMP_IMAGE_PROP,
    mode: {
      type: 'string',
      enum: [
        'all',
        'rectangle',
        'ellipse',
        'polygon',
        'color_range',
        'magic_wand',
        'alpha',
        'channel',
        'gradient_linear',
        'gradient_radial',
      ],
      description:
        'rectangle/ellipse: x, y, width, height. polygon: points (>=3 [x,y] pairs). color_range: ' +
        'every pixel near `color` (hex) or the colour at a sample point x,y, anywhere in the ' +
        "image. magic_wand: the contiguous region around x,y. alpha: a layer's opaque pixels. " +
        'channel: copy another saved selection (`source`). gradient_linear: a ramp from (x1,y1) ' +
        'to (x2,y2), default the full image width. gradient_radial: a ramp from full effect at ' +
        "the center (cx,cy) fading to none at radius, default centered at the image's own center " +
        'with radius = half the shorter side.',
    },
    name: {
      type: 'string',
      default: 'Selection',
      minLength: 1,
      description: 'Channel to save the selection in (replaced).',
    },
    combine: {
      type: 'string',
      enum: ['replace', 'add', 'subtract', 'intersect'],
      default: 'replace',
      description:
        'Combine with the existing saved selection of the same `name` (like shift/alt in a ' +
        'GUI). `invert`/`feather_px` apply to the NEW shape alone, before it is combined.',
    },
    x: {
      type: 'number',
      description:
        "rectangle/ellipse/magic_wand, or color_range's sample point: left edge or point x, in " +
        'image pixels from the canvas origin, also when `layer` names a layer that sits at an ' +
        "offset (never counted from that layer's own corner).",
    },
    y: {
      type: 'number',
      description:
        "rectangle/ellipse/magic_wand, or color_range's sample point: top edge or point y, in " +
        'image pixels from the canvas origin, also when `layer` names a layer that sits at an ' +
        "offset (never counted from that layer's own corner).",
    },
    width: { type: 'number', description: 'rectangle/ellipse: width, document pixels.' },
    height: { type: 'number', description: 'rectangle/ellipse: height, document pixels.' },
    points: {
      type: 'array',
      minItems: 3,
      maxItems: 10_000,
      items: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } },
      description: 'polygon: 3-10,000 [x, y] pairs, document pixels.',
    },
    color: {
      type: 'string',
      pattern: '^#[0-9a-fA-F]{6}$',
      description: 'color_range: a hex colour like "#c0392b".',
    },
    threshold: {
      type: 'number',
      minimum: 0,
      maximum: 255,
      default: 15,
      description: 'color_range/magic_wand tolerance, 0-255.',
    },
    sample_merged: {
      type: 'boolean',
      default: true,
      description:
        'color_range/magic_wand: sample the visible composite. false samples the one named/' +
        "selected layer's own raw pixels instead.",
    },
    source: {
      type: 'string',
      minLength: 1,
      description: 'mode=channel: the saved selection to copy.',
    },
    layer: {
      ...GIMP_LAYER_PROP,
      description:
        GIMP_LAYER_PROP.description +
        ' alpha: which layer. color_range/magic_wand: only matters when sample_merged:false ' +
        '(otherwise the visible composite is sampled, and which layer this names makes no ' +
        'difference to the result).',
    },
    layer_id: {
      ...GIMP_LAYER_ID_PROP,
      description:
        GIMP_LAYER_ID_PROP.description +
        ' alpha: which layer. color_range/magic_wand: only matters when sample_merged:false.',
    },
    invert: {
      type: 'boolean',
      default: false,
      description:
        'Applied to the NEW shape alone, before any `combine`. rectangle/ellipse/polygon/' +
        'color_range/magic_wand/alpha/channel: invert the selection. gradient_linear/' +
        'gradient_radial: swap which end is black vs white.',
    },
    feather_px: {
      type: 'number',
      minimum: 0,
      maximum: 1000,
      default: 0,
      description:
        'Feather radius in document pixels, applied to the NEW shape alone before any `combine`. ' +
        'Refused (nonzero) on gradient_linear/gradient_radial -- already a continuous ramp, ' +
        'nothing to feather.',
    },
    x1: {
      type: 'number',
      description: 'gradient_linear: start point x, document pixels. Default 0.',
    },
    y1: {
      type: 'number',
      description: 'gradient_linear: start point y, document pixels. Default 0.',
    },
    x2: {
      type: 'number',
      description: "gradient_linear: end point x, document pixels. Default the image's width.",
    },
    y2: {
      type: 'number',
      description: 'gradient_linear: end point y, document pixels. Default 0.',
    },
    cx: {
      type: 'number',
      description: "gradient_radial: center x, document pixels. Default the image's own center.",
    },
    cy: {
      type: 'number',
      description: "gradient_radial: center y, document pixels. Default the image's own center.",
    },
    radius: {
      type: 'number',
      description: 'gradient_radial: radius, document pixels. Default half the shorter image side.',
    },
  },
  required: ['image', 'mode'],
};

const modifySelectionSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    image: GIMP_IMAGE_PROP,
    channel: { type: 'string', minLength: 1, description: 'The saved selection to modify.' },
    op: {
      type: 'string',
      enum: ['expand', 'contract', 'border', 'feather', 'smooth', 'invert', 'harden'],
      description:
        'expand/contract/border/feather require `px` (> 0). harden: threshold a soft mask at ' +
        '50%. smooth: round off jagged edges (`px` optional, floors at 1px).',
    },
    px: {
      type: 'number',
      minimum: 0,
      maximum: 1000,
      description:
        'Radius in document pixels, rounded to the nearest whole pixel. Required (> 0) for ' +
        'expand/contract/border/feather; optional for smooth; unused otherwise. expand/contract/' +
        'border cap at 150 on an ordinary document, LOWER on a very large one (morphological ' +
        "ops whose cost scales with both the radius and the document's own megapixels — the " +
        'error names the actual cap for that document when a value is refused); feather has no ' +
        'such cap up to 1000 (a GEGL blur, flat cost regardless of radius).',
    },
    output: {
      type: 'string',
      minLength: 1,
      description: 'Write to this saved selection instead of modifying `channel` in place.',
    },
  },
  required: ['image', 'channel', 'op'],
};

const layerMaskSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    image: GIMP_IMAGE_PROP,
    op: {
      type: 'string',
      enum: ['create', 'delete', 'apply', 'invert'],
      description:
        "create replaces any existing mask. apply bakes the mask into the layer's alpha.",
    },
    source: {
      type: 'string',
      enum: ['channel', 'white', 'black', 'alpha', 'grayscale'],
      default: 'channel',
      description: 'create: where the mask comes from.',
    },
    channel: {
      type: 'string',
      minLength: 1,
      description: 'source=channel: the saved selection to use.',
    },
    invert: { type: 'boolean', default: false, description: 'create: invert the new mask.' },
    layer: GIMP_LAYER_PROP,
    layer_id: GIMP_LAYER_ID_PROP,
  },
  required: ['image', 'op'],
};

const selectionPreviewSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    image: GIMP_IMAGE_PROP,
    channel: { type: 'string', minLength: 1, description: 'The saved selection to show.' },
    style: {
      type: 'string',
      enum: ['overlay', 'mask'],
      default: 'overlay',
      description: 'overlay: the image with red over what is NOT selected. mask: white = selected.',
    },
    max_px: GIMP_MAX_PX_PROP,
  },
  required: ['image', 'channel'],
};

async function selectionPreview(
  gimp: GimpBackend,
  rawArgs: Record<string, unknown>,
  previewsAllowedFn: () => boolean
): Promise<ToolResult> {
  try {
    const args = validateArgs(selectionPreviewSchema, rawArgs);
    await gimp.prepare();
    const out = gimp.tempPath(`selection-preview-${randomUUID()}.jpg`);
    try {
      const bridgeArgs = pickSchemaDeclaredKeys(selectionPreviewSchema, args);
      const r = await gimp.call<{ width: number; height: number; unmirrored_filters?: string[] }>(
        'mask_preview',
        { ...bridgeArgs, out_path: out }
      );
      const allowed = previewsAllowedFn();
      const content: ToolResult['content'] = [];
      if (allowed) {
        const bytes = await readRender(out);
        content.push({
          type: 'image' as const,
          data: bytes.toString('base64'),
          mimeType: 'image/jpeg',
        });
      }
      const unmirroredNote =
        r.unmirrored_filters && r.unmirrored_filters.length > 0
          ? ` WARNING: ${r.unmirrored_filters.join(', ')} could not be rendered on this proxy and ` +
            `${r.unmirrored_filters.length === 1 ? 'is' : 'are'} missing from it.`
          : '';
      content.push({
        type: 'text' as const,
        text:
          `Selection "${String(args.channel)}" ${r.width}x${r.height}.` +
          (allowed
            ? ''
            : ' privacy.send_previews_to_llm is false — image not returned to the model.') +
          unmirroredNote,
      });
      return { content, structuredContent: { width: r.width, height: r.height } };
    } finally {
      await rm(out, { force: true }).catch(() => undefined);
    }
  } catch (error) {
    return toolGimpErrorResult('Error previewing GIMP selection', error);
  }
}

const annotations = (title: string, readOnly = false) => ({
  title,
  readOnlyHint: readOnly,
  destructiveHint: !readOnly,
  idempotentHint: false,
  openWorldHint: true,
});

export function createGimpSelectionTools(
  gimp: GimpBackend,
  deps: GimpPreviewDeps = {}
): ToolDefinition[] {
  const previewsAllowedFn = deps.previewsAllowed ?? defaultPreviewsAllowed;
  return [
    {
      tool: {
        name: 'gimp_select',
        description:
          'Headless GIMP: make a selection, saved as a NAMED channel (no live selection ' +
          'persists between calls): rectangle/ellipse/polygon/colour range/magic wand/layer ' +
          'alpha/gradient/another channel. Combine add/subtract/intersect by reusing a name. ' +
          "Use the channel as gimp_add_adjustment's " +
          '`mask` when creating a filter, or gimp_layer_mask for a real layer mask. Make ' +
          'selections after straighten/resize/crop.',
        inputSchema: selectSchema,
        outputSchema: maskResultSchema,
        annotations: annotations('Select (GIMP)'),
      },
      handler: (args) =>
        runGimpTool({
          gimp,
          rawArgs: args,
          schema: selectSchema,
          op: 'select',
          errorPrefix: 'Error selecting',
          successText: maskText,
        }),
    },
    {
      tool: {
        name: 'gimp_modify_selection',
        description:
          'Headless GIMP: expand, contract, border, feather, smooth, invert or harden a saved ' +
          'selection. Refused if the target channel already confines a filter.',
        inputSchema: modifySelectionSchema,
        outputSchema: maskResultSchema,
        annotations: annotations('Modify Selection (GIMP)'),
      },
      handler: (args) =>
        runGimpTool({
          gimp,
          rawArgs: args,
          schema: modifySelectionSchema,
          op: 'modify_mask',
          errorPrefix: 'Error modifying selection',
          successText: maskText,
        }),
    },
    {
      tool: {
        name: 'gimp_layer_mask',
        description:
          'Headless GIMP: a real layer mask (moves with the layer). create from a saved ' +
          'selection (e.g. from gimp_select) or white/black/alpha/grayscale; delete; apply (bake ' +
          'into alpha — a cut-out); invert. For a cut-out composite: place the photo as a ' +
          'layer, select on that layer, then create its mask from the channel.',
        inputSchema: layerMaskSchema,
        outputSchema: layerMaskResultSchema,
        annotations: annotations('Layer Mask (GIMP)'),
      },
      handler: (args) =>
        runGimpTool({
          gimp,
          rawArgs: args,
          schema: layerMaskSchema,
          op: 'layer_mask',
          errorPrefix: 'Error on layer mask',
          successText: (r) => {
            const x = r as { layer: string; op: string; has_mask: boolean };
            return `Layer "${x.layer}": ${x.op} done (${x.has_mask ? 'has' : 'no'} mask).`;
          },
        }),
    },
    {
      tool: {
        name: 'gimp_get_selection_preview',
        description:
          'Headless GIMP: see a saved selection — overlay (red over what is NOT selected, Quick ' +
          'Mask style) or the mask itself. Always check a selection before using it. Respects ' +
          'privacy.send_previews_to_llm: when disabled, no image bytes are returned, only the ' +
          'dimensions.',
        inputSchema: selectionPreviewSchema,
        outputSchema: selectionPreviewResultSchema,
        annotations: annotations('Selection Preview (GIMP)', true),
      },
      handler: (args) => selectionPreview(gimp, args, previewsAllowedFn),
    },
  ];
}
