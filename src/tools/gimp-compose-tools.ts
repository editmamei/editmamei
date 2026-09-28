import { basename } from 'node:path';
import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import type { GimpBackend } from '../backends/gimp/backend.js';
import { validateArgs, type JsonSchemaObject } from '../utils/validate.js';
import { toolGimpErrorResult, requireAbsoluteGimpPath } from '../utils/tool-helpers.js';
import { GIMP_IMAGE_PROP, runGimpTool, pickSchemaDeclaredKeys } from './gimp-shared.js';

/**
 * gimp_create_document / gimp_place_image / gimp_canvas / gimp_convert_image_mode — building a
 * multi-layer document out of more than one source image, and changing its canvas size or color
 * mode once it exists.
 *
 * Verified live (GIMP 3.2.6):
 *  - `gimp_place_image`'s `Gimp.file_load_layer` already converts the loaded content to the
 *    TARGET image's own base type (RGB/grayscale) before it is even inserted, in both directions
 *    — a mismatch there is handled, not refused. Placing a file that carries its own metadata
 *    (EXIF/XMP) does not attach anything to the target image's own metadata. A MULTI-layer source
 *    (e.g. a `.xcf`) hands back only ONE layer — GIMP's own choice, not a flattened composite —
 *    and that layer's own live filters come with it, baked into its pixels before it is ever
 *    inserted (reported as `baked_filters`), never placed live.
 *  - `gimp_canvas`'s extend reuses the same underlying canvas-resize primitive `gimp_crop_document`
 *    wraps for the shrink direction; it repositions every existing layer by the growth offset
 *    without touching that layer's own pixels or size — exactly the "layer moves, a filter's fixed
 *    mask confinement does not" case `gimp_resize_image`/`gimp_transform_canvas` already refuse
 *    on, so `gimp_canvas` refuses under the same conditions. An effect filter (vignette and
 *    friends) keys off the LAYER's own unchanged extent, never the canvas, so it needs no such
 *    refusal or tracking. `fill: transparent`'s "no fill layer" is only genuinely transparent in a
 *    live, layered document — both `gimp_export` and `gimp_layer op=flatten` flatten first, which
 *    fills it with GIMP's background color (white) instead.
 *  - Inserting a layer changes the image's own SELECTED layer as a side effect, and both
 *    `Drawable.scale()`/`Drawable.fill()` report failure by returning `False` rather than raising
 *    — the bridge ops below account for both.
 */

const createDocumentSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    width: { type: 'integer', minimum: 1, description: 'Canvas width, in pixels.' },
    height: { type: 'integer', minimum: 1, description: 'Canvas height, in pixels.' },
    mode: {
      type: 'string',
      enum: ['rgb', 'grayscale'],
      default: 'rgb',
      description: "The new image's base color mode.",
    },
    fill: {
      type: 'string',
      enum: ['white', 'black', 'transparent'],
      default: 'white',
      description: "The single background layer's initial content.",
    },
    precision: {
      type: 'string',
      enum: ['16', '32'],
      description:
        "Promote bit depth at creation, same as gimp_open_document's own `precision` — use this " +
        'ahead of an aggressive tone move to avoid visible banding. Omit for ordinary 8-bit. The ' +
        'megapixel cap this tool enforces scales down with bit depth (a 16-bit request costs 2x ' +
        'the memory of the same pixel count at 8-bit, 32-bit float 4x): 250 MP at 8-bit, 125 MP ' +
        'at 16-bit, 60 MP at 32-bit — the same per-side 30000px limit applies at every depth.',
    },
    name: {
      type: 'string',
      description: "The background layer's name. Defaults to 'Background'.",
    },
  },
  required: ['width', 'height'],
};

interface CreateDocumentResult {
  image: number;
  width: number;
  height: number;
  base_type: string;
  precision: string;
  layers: string[];
}

async function gimpCreateDocument(
  gimp: GimpBackend,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(createDocumentSchema, rawArgs);
    const result = await gimp.call<CreateDocumentResult>(
      'create_document',
      pickSchemaDeclaredKeys(createDocumentSchema, args)
    );
    return {
      content: [
        {
          type: 'text' as const,
          text:
            `Created a new ${result.width}x${result.height} document as image ${result.image} ` +
            `(${result.base_type}, ${result.precision}). ` +
            `${result.layers.length} layer(s): ${result.layers.join(', ') || '(none)'}.`,
        },
      ],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  } catch (error) {
    return toolGimpErrorResult('Error creating GIMP document', error);
  }
}

const placeImageSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    image: GIMP_IMAGE_PROP,
    file_path: {
      type: 'string',
      description:
        'Absolute path to an image file to load as a new layer — same format support and raw-file ' +
        "handling as gimp_open_document's own `file_path`. If the file has multiple layers (e.g. a " +
        "`.xcf`), only ONE of them is placed — GIMP's own choice, not a flattened composite of the " +
        'whole file — flatten or export a single layer first if the full composite is wanted. If ' +
        'that one layer itself carries live, re-editable filters, they are baked into its pixels ' +
        'before placing (reported as baked_filters) rather than placed live, so they can never ' +
        'collide with a filter of the same name already on the target. A mismatch between the ' +
        "file's own color mode (RGB/grayscale) and this image's is converted automatically, not " +
        'refused.',
    },
    x: {
      type: 'integer',
      default: 0,
      description: "The new layer's ABSOLUTE horizontal offset in document pixels (not a delta).",
    },
    y: {
      type: 'integer',
      default: 0,
      description: "The new layer's ABSOLUTE vertical offset in document pixels (not a delta).",
    },
    width: {
      type: 'integer',
      minimum: 1,
      description:
        'Scale the placed layer to this width. With height, stretches to exactly that box. Alone, ' +
        "height is derived to keep the source file's own aspect ratio. Omit both to place at the " +
        "source file's natural size.",
    },
    height: {
      type: 'integer',
      minimum: 1,
      description: 'Scale the placed layer to this height. See width.',
    },
    name: {
      type: 'string',
      description:
        "The new layer's name. Defaults to the source file's own base filename. Every case " +
        'enforces a unique name, suffixing " 2", " 3", ... if the name is already taken.',
    },
    parent_group: {
      type: 'integer',
      description: 'The group layer_id to insert the new layer into (omit for top-level).',
    },
    position: {
      type: 'integer',
      minimum: 0,
      default: 0,
      description: "Index within the target parent's (or top-level) stack, 0 = topmost.",
    },
  },
  required: ['image', 'file_path'],
};

interface PlaceImageResult {
  layer_id: number;
  name: string;
  width: number;
  height: number;
  x: number | null;
  y: number | null;
  parent_group: number | null;
  baked_filters?: string[];
}

async function gimpPlaceImage(
  gimp: GimpBackend,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(placeImageSchema, rawArgs);
    const filePath = requireAbsoluteGimpPath('file_path', args.file_path);
    const bridgeArgs = pickSchemaDeclaredKeys(placeImageSchema, args);
    delete bridgeArgs.file_path;
    bridgeArgs.path = filePath;
    const result = await gimp.call<PlaceImageResult>('place_image', bridgeArgs);
    const bakedNote =
      result.baked_filters && result.baked_filters.length > 0
        ? ` Its own live filter(s) (${result.baked_filters.join(', ')}) were baked into its ` +
          'pixels before placing.'
        : '';
    return {
      content: [
        {
          type: 'text' as const,
          text:
            `Placed ${basename(filePath)} as layer ${result.layer_id} ("${result.name}") at ` +
            `(${result.x}, ${result.y}), ${result.width}x${result.height}.${bakedNote}`,
        },
      ],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  } catch (error) {
    return toolGimpErrorResult('Error placing GIMP image', error);
  }
}

const CANVAS_ANCHORS = [
  'top_left',
  'top_center',
  'top_right',
  'middle_left',
  'center',
  'middle_right',
  'bottom_left',
  'bottom_center',
  'bottom_right',
] as const;

const canvasSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    image: GIMP_IMAGE_PROP,
    width: {
      type: 'integer',
      minimum: 1,
      description:
        'New canvas width, in pixels. Must be at least the current width, and at least one of ' +
        'width/height must actually be LARGER than the current size (both equal to the current ' +
        'size is refused — there is nothing to extend).',
    },
    height: {
      type: 'integer',
      minimum: 1,
      description: 'New canvas height, in pixels. Must be at least the current height. See width.',
    },
    anchor: {
      type: 'string',
      enum: [...CANVAS_ANCHORS],
      description:
        'Where the existing content sits within the new, larger canvas — a 3x3 grid, same as ' +
        "Photoshop's Canvas Size anchor picker. Defaults to 'center' when neither this nor " +
        'offset_x/offset_y is given. Mutually exclusive with offset_x/offset_y.',
    },
    offset_x: {
      type: 'integer',
      description:
        "Explicit horizontal offset (document pixels) for the existing content's left edge in " +
        'the new canvas, instead of an anchor — must be between 0 and (new width - current ' +
        'width). Requires offset_y too; mutually exclusive with anchor.',
    },
    offset_y: {
      type: 'integer',
      description:
        "Explicit vertical offset for the existing content's top edge, instead of an anchor — " +
        'must be between 0 and (new height - current height). Requires offset_x too; mutually ' +
        'exclusive with anchor.',
    },
    fill: {
      type: 'string',
      // One `pattern`, no `enum`: standard JSON Schema requires a value to satisfy BOTH when both
      // are declared, so an enum of the words would reject every hex value. The description spells
      // out the accepted words for a client or model reading the schema.
      pattern: '^(white|black|transparent|#[0-9a-fA-F]{6})$',
      default: 'transparent',
      description:
        "'white', 'black', a '#rrggbb' hex color, or 'transparent' (default — no fill layer is " +
        'added at all; see the note on gimp_export/flatten below). Any other choice is painted onto a ' +
        'new, full-canvas layer inserted at the BOTTOM of the whole stack — a solid backdrop ' +
        'behind every existing layer, not just the newly added area, so it also shows through any ' +
        'pre-existing transparency in those layers. On a GRAYSCALE image a hex color renders as ' +
        'its LUMINANCE (a weighted gray, not one channel picked out). transparent: genuinely ' +
        'transparent only in a live, layered document (e.g. saved via gimp_save_xcf) — ' +
        'gimp_export and gimp_layer op=flatten both flatten first, which fills any transparent ' +
        "area with GIMP's ambient background color (white, unchanged by this tool) and drops " +
        'alpha, not with transparency. A non-transparent fill on an INDEXED image is REFUSED ' +
        'outright, before the canvas resizes at all — indexed has no backdrop layer type to add.',
    },
  },
  required: ['image', 'width', 'height'],
};

async function gimpCanvas(
  gimp: GimpBackend,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runGimpTool({
    gimp,
    rawArgs,
    schema: canvasSchema,
    op: 'canvas',
    errorPrefix: 'Error extending GIMP canvas',
    successText: (result) => {
      const r = result as { width: number; height: number; offset_x: number; offset_y: number };
      return `Extended canvas to ${r.width}x${r.height} (existing content offset by ${r.offset_x}, ${r.offset_y}).`;
    },
  });
}

const convertImageModeSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    image: GIMP_IMAGE_PROP,
    mode: {
      type: 'string',
      enum: ['rgb', 'grayscale'],
      description: 'Target base color mode. An indexed source image is refused outright.',
    },
  },
  required: ['image', 'mode'],
};

async function gimpConvertImageMode(
  gimp: GimpBackend,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runGimpTool({
    gimp,
    rawArgs,
    schema: convertImageModeSchema,
    op: 'convert_image_mode',
    errorPrefix: 'Error converting GIMP image mode',
    successText: (result, args) => {
      const r = result as { mode: string; converted: boolean };
      return r.converted
        ? `Converted image ${args.image as number} to ${r.mode}.`
        : `Image ${args.image as number} is already ${r.mode}; nothing to convert.`;
    },
  });
}

export function createGimpComposeTools(gimp: GimpBackend): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'gimp_create_document',
        description:
          'Headless GIMP: create a new, empty image from scratch — not from a file (that is ' +
          'gimp_open_document). width/height, mode (rgb/grayscale, default rgb), fill for the ' +
          'single background layer (white/black/transparent, default white), optional precision ' +
          "(16/32-bit, same promotion gimp_open_document's own `precision` does) and name. " +
          'Returns the exact same shape gimp_open_document does (image id, dimensions, base type, ' +
          'precision, layer list), so every other gimp_* tool treats it identically to an opened file.',
        inputSchema: createDocumentSchema,
        outputSchema: {
          type: 'object',
          properties: {
            image: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' },
            base_type: { type: 'string' },
            precision: { type: 'string' },
            layers: { type: 'array', items: { type: 'string' } },
          },
        },
        annotations: {
          title: 'Create GIMP Document',
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      handler: async (args) => gimpCreateDocument(gimp, args),
    },
    {
      tool: {
        name: 'gimp_place_image',
        description:
          'Headless GIMP: load another image file as a new layer in an already-open document — ' +
          'compositing, not opening a second document. Absolute file_path, same format support ' +
          'and raw-file handling as gimp_open_document. If the source has multiple layers (e.g. a ' +
          "`.xcf`), only ONE of them is placed — GIMP's own choice, not a flattened composite of " +
          "the whole file. A source whose color mode (RGB/grayscale) differs from this image's " +
          'own is converted automatically on load, never refused. x/y place the layer at an ' +
          'ABSOLUTE document-pixel offset (not a delta), default (0, 0); width/height optionally ' +
          "scale it first (one alone keeps the source's own aspect ratio). name/parent_group/" +
          "position work exactly like gimp_layer op=create. A source layer's OWN live filters " +
          '(e.g. from a filtered `.xcf`) are baked into its pixels before placing, never placed ' +
          "live (reported as baked_filters). Nothing from the source file's own metadata " +
          '(EXIF/XMP) attaches to this image, and no path — just the placed layer — appears in ' +
          'the result; there is no undo in this session: gimp_checkpoint or gimp_save_xcf first ' +
          'when in doubt.',
        inputSchema: placeImageSchema,
        outputSchema: {
          type: 'object',
          properties: {
            layer_id: { type: 'number' },
            name: { type: 'string' },
            width: { type: 'number' },
            height: { type: 'number' },
            x: { type: ['number', 'null'] },
            y: { type: ['number', 'null'] },
            parent_group: { type: ['number', 'null'] },
            baked_filters: {
              type: 'array',
              items: { type: 'string' },
              description:
                "Names of the placed layer's own live filters that were baked into its pixels " +
                'before placing. Omitted when the source layer had none.',
            },
          },
        },
        annotations: {
          title: 'Place Image Into GIMP Document',
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      handler: async (args) => gimpPlaceImage(gimp, args),
    },
    {
      tool: {
        name: 'gimp_canvas',
        description:
          'Headless GIMP: extend the canvas — grow it and reposition the existing content within ' +
          'the larger frame, never shrink (use gimp_crop_document for that; REFUSED outright when ' +
          'either dimension would be smaller than the current one, and REFUSED when neither ' +
          'dimension actually grows). Choose where the existing content lands with `anchor` (a ' +
          "3x3 grid, default 'center') or explicit offset_x/offset_y; give one or the other, not " +
          'both. `fill` sets a solid backdrop layer under the WHOLE canvas — white, black, a ' +
          "'#rrggbb' hex color (rendered as luminance on a grayscale image), or transparent " +
          '(default, adds no backdrop layer at all — see its own field description for what that ' +
          'means at export/flatten time). IRREVERSIBLE in this session: there is no undo, so ' +
          'gimp_checkpoint or gimp_save_xcf first when in doubt. REFUSES outright when the image ' +
          'has a masked filter, or any filter not created by Editmamei (for example one added in ' +
          'the GIMP GUI) AND the existing content actually moves (offset_x/offset_y not both 0 — ' +
          'for example a top-left anchor never moves anything) — extend the canvas before adding ' +
          "any masked filter, not after: a filter's mask does not travel with the layer it " +
          'confines when the canvas repositions it, the same physics gimp_resize_image and ' +
          'gimp_transform_canvas already refuse on. An unmasked effect filter (vignette and ' +
          "friends) is unaffected — its own params key off the LAYER's own unchanged extent, " +
          'never the canvas.',
        inputSchema: canvasSchema,
        outputSchema: {
          type: 'object',
          properties: {
            width: { type: 'number' },
            height: { type: 'number' },
            offset_x: { type: 'number' },
            offset_y: { type: 'number' },
          },
        },
        annotations: {
          title: 'Extend GIMP Canvas',
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      handler: async (args) => gimpCanvas(gimp, args),
    },
    {
      tool: {
        name: 'gimp_convert_image_mode',
        description:
          "Headless GIMP: convert the image's base color mode, rgb <-> grayscale — an indexed " +
          'image is refused outright as a source. Converting to grayscale permanently discards ' +
          'color; converting an already-grayscale image to rgb does not restore it. A no-op when ' +
          'the image is already the requested mode (reported as converted: false, nothing else ' +
          'changes — checked BEFORE the live-filter refusal below, so a no-op call never fails ' +
          'just because a filter happens to be present). Otherwise REFUSES outright while the ' +
          'image has ANY live filter — a color-dependent filter (curves on the red channel, ' +
          'hue_saturation, a vignette color, ...) could change meaning across the mode change. ' +
          'Bake it first (gimp_bake) or delete it (gimp_filter op=delete), then convert. ' +
          'IRREVERSIBLE in this session: there is no undo, so gimp_checkpoint or gimp_save_xcf ' +
          'first when in doubt.',
        inputSchema: convertImageModeSchema,
        outputSchema: {
          type: 'object',
          properties: {
            mode: { type: 'string' },
            converted: { type: 'boolean' },
          },
        },
        annotations: {
          title: 'Convert GIMP Image Mode',
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true, // converting to the mode it's already in is a reported no-op
          openWorldHint: true,
        },
      },
      handler: async (args) => gimpConvertImageMode(gimp, args),
    },
  ];
}
