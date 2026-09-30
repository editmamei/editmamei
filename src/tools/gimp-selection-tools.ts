import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import type { GimpBackend } from '../backends/gimp/backend.js';
import { validateArgs, type JsonSchemaObject } from '../utils/validate.js';
import { toolGimpErrorResult } from '../utils/tool-helpers.js';
import {
  GIMP_IMAGE_PROP,
  GIMP_LAYER_ID_PROP,
  GIMP_LAYER_PROP,
  GIMP_MAX_PX_PROP,
  runGimpTool,
} from './gimp-shared.js';

/**
 * Selection tools for GIMP (spike, tier 'dev'): twins of ps_select, ps_modify_selection,
 * ps_layer_mask and ps_get_selection_preview. GIMP keeps no live selection between calls, so
 * every result is a NAMED channel — pass it to gimp_add_adjustment's `mask`, or turn it into a
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

const maskPreviewResultSchema = {
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
      ],
      description:
        'rectangle/ellipse: x, y, width, height. polygon: points [[x,y],...]. color_range: every ' +
        'pixel near `color` (hex) or the colour at x,y, anywhere in the image. magic_wand: the ' +
        "contiguous region around x,y. alpha: a layer's opaque pixels. channel: copy channel `source`.",
    },
    name: { type: 'string', default: 'Selection', description: 'Channel to write (replaced).' },
    combine: {
      type: 'string',
      enum: ['replace', 'add', 'subtract', 'intersect'],
      default: 'replace',
      description:
        'Combine with the existing channel of the same `name` (like shift/alt in a GUI).',
    },
    x: { type: 'number' },
    y: { type: 'number' },
    width: { type: 'number' },
    height: { type: 'number' },
    points: { type: 'array', items: { type: 'array', items: { type: 'number' } } },
    color: { type: 'string', description: 'color_range: a hex colour like "#c0392b".' },
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
      description: 'Sample the visible composite, not one layer.',
    },
    source: { type: 'string', description: 'mode=channel: the channel to copy.' },
    layer: GIMP_LAYER_PROP,
    layer_id: GIMP_LAYER_ID_PROP,
    invert: { type: 'boolean', default: false },
    feather_px: { type: 'number', minimum: 0, maximum: 1000, default: 0 },
  },
  required: ['image', 'mode'],
};

const modifySchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    image: GIMP_IMAGE_PROP,
    channel: { type: 'string', description: 'The channel to modify.' },
    op: {
      type: 'string',
      enum: ['expand', 'contract', 'border', 'feather', 'smooth', 'invert', 'harden'],
      description: 'harden: threshold a soft mask at 50%. smooth: round off jagged edges.',
    },
    px: { type: 'number', minimum: 0, maximum: 1000, default: 0, description: 'Radius in pixels.' },
    output: { type: 'string', description: 'Write to this channel instead of modifying in place.' },
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
    channel: { type: 'string', description: 'source=channel: the channel to use.' },
    invert: { type: 'boolean', default: false, description: 'create: invert the new mask.' },
    layer: GIMP_LAYER_PROP,
    layer_id: GIMP_LAYER_ID_PROP,
  },
  required: ['image', 'op'],
};

const previewSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    image: GIMP_IMAGE_PROP,
    channel: { type: 'string', description: 'The channel to show.' },
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

async function maskPreview(
  gimp: GimpBackend,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(previewSchema, rawArgs);
    await gimp.prepare();
    const out = gimp.tempPath(`mask-${randomUUID()}.jpg`);
    try {
      const r = await gimp.call<{ width: number; height: number }>('mask_preview', {
        ...args,
        out_path: out,
      });
      const bytes = await readFile(out);
      return {
        content: [
          { type: 'image' as const, data: bytes.toString('base64'), mimeType: 'image/jpeg' },
          { type: 'text' as const, text: `Mask "${String(args.channel)}" ${r.width}x${r.height}.` },
        ],
        structuredContent: { width: r.width, height: r.height },
      };
    } finally {
      await rm(out, { force: true });
    }
  } catch (error) {
    return toolGimpErrorResult('Error previewing GIMP mask', error);
  }
}

const annotations = (title: string, readOnly = false) => ({
  title,
  readOnlyHint: readOnly,
  destructiveHint: !readOnly,
  idempotentHint: false,
  openWorldHint: true,
});

export function createGimpSelectionTools(gimp: GimpBackend): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'gimp_select',
        description:
          'Headless GIMP: make a selection and store it as a NAMED channel (GIMP keeps no live ' +
          'selection between calls). Geometric, polygon, colour range, magic wand, layer alpha, ' +
          'or a copy of another channel; combine add/subtract/intersect with the existing ' +
          "channel of the same name. Use the channel as gimp_add_adjustment's `mask`, or " +
          'gimp_layer_mask op=create to make a layer mask. Check it with gimp_get_mask_preview.',
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
        name: 'gimp_modify_mask',
        description:
          'Headless GIMP: expand, contract, border, feather, smooth, invert or harden a named ' +
          'mask channel (the ps_modify_selection twin). Refused if the target channel already ' +
          'confines a filter.',
        inputSchema: modifySchema,
        outputSchema: maskResultSchema,
        annotations: annotations('Modify Mask (GIMP)'),
      },
      handler: (args) =>
        runGimpTool({
          gimp,
          rawArgs: args,
          schema: modifySchema,
          op: 'modify_mask',
          errorPrefix: 'Error modifying mask',
          successText: maskText,
        }),
    },
    {
      tool: {
        name: 'gimp_layer_mask',
        description:
          'Headless GIMP: a real layer mask (moves with the layer). create from a named channel ' +
          '(e.g. a subject selection) or white/black/alpha/grayscale; delete; apply (bake into ' +
          'alpha — a cut-out); invert. For a cut-out composite: place the photo as a layer, ' +
          'select on that layer, then create its mask from the channel.',
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
        name: 'gimp_get_mask_preview',
        description:
          'Headless GIMP: see a named mask channel — overlay (red over what is NOT selected, ' +
          'Quick Mask style) or the mask itself. Always check a selection before using it.',
        inputSchema: previewSchema,
        outputSchema: maskPreviewResultSchema,
        annotations: annotations('Mask Preview (GIMP)', true),
      },
      handler: (args) => maskPreview(gimp, args),
    },
  ];
}
