import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import type { GimpBackend } from '../backends/gimp/backend.js';
import { validateArgs, type JsonSchemaObject } from '../utils/validate.js';
import { toolGimpErrorResult } from '../utils/tool-helpers.js';
import {
  GIMP_IMAGE_PROP,
  GIMP_LAYER_ID_PROP,
  GIMP_LAYER_PROP,
  pickSchemaDeclaredKeys,
} from './gimp-shared.js';

/**
 * gimp_text — the GIMP twin of ps_text: create a live, editable text layer or restyle one, chosen
 * with `op`. Same op names and parameter meanings as ps_text (`text`, `x`/`y`, `font_size` in
 * points, `font_name`, `red`/`green`/`blue`, `alignment`). GIMP has no single "active layer" the
 * way Photoshop does, so the set_* ops take `layer_id`/`layer` like the rest of the gimp_*
 * family and refuse a layer that is not a text layer.
 *
 * Fonts resolve by family ("Inter") or full name ("Inter Bold"), case-insensitively; a miss is
 * refused with the closest installed names. `gimp_inspect` what=fonts lists what is installed.
 * A layer that would render past the engine's size cap is refused and leaves the document
 * unchanged (`bridge/ops.py`'s `op_text`).
 */

const TEXT_OPS = ['create', 'set_content', 'set_font', 'set_color', 'set_alignment'] as const;

const ALIGNMENTS = [
  'LEFT',
  'CENTER',
  'RIGHT',
  'FULLYJUSTIFIED',
  'LEFTJUSTIFIED',
  'CENTERJUSTIFIED',
  'RIGHTJUSTIFIED',
] as const;

const textSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    image: GIMP_IMAGE_PROP,
    op: {
      type: 'string',
      enum: [...TEXT_OPS],
      description:
        'create: a new text layer at the top of the stack with `text` at `x`/`y` (default ' +
        '100,100) and `font_size` (default 24), optionally with font_name, red/green/blue and ' +
        'alignment. set_content: replace the text with `text`. set_font: set `font_name` ' +
        '(optionally `font_size`). set_color: set red/green/blue. set_alignment: set ' +
        '`alignment`. The set_* ops act on the text layer named by `layer_id` or `layer`.',
    },
    layer: {
      ...GIMP_LAYER_PROP,
      description:
        'set_*: name of the text layer to change. Ignored when layer_id is given. Not used by ' +
        'create.',
    },
    layer_id: {
      ...GIMP_LAYER_ID_PROP,
      description:
        'set_*: id of the text layer to change (create reports it; gimp_inspect flags text ' +
        'layers with is_text_layer). Takes priority over `layer`. Not used by create.',
    },
    text: {
      type: 'string',
      description:
        'create: initial text. set_content: the new text, replacing the existing text. At most ' +
        '2000 characters; use \\n for line breaks.',
    },
    x: {
      type: 'integer',
      default: 100,
      description: "create only: the layer's left edge in document pixels.",
    },
    y: {
      type: 'integer',
      default: 100,
      description: "create only: the layer's top edge in document pixels.",
    },
    font_size: {
      type: 'number',
      minimum: 1,
      maximum: 1296,
      description:
        'Font size in points, 1 to 1296, converted to pixels with the image resolution. create: ' +
        'initial size (default 24). set_font: new size (omit to keep the current size).',
    },
    font_name: {
      type: 'string',
      description:
        'Font family ("Inter", "Open Sans") or full name ("Inter Bold"), case-insensitive. ' +
        'create: omit for a default sans. A name that matches nothing is refused with the ' +
        'closest installed names; gimp_inspect what=fonts lists them all.',
    },
    red: {
      type: 'integer',
      minimum: 0,
      maximum: 255,
      description: 'Text colour red, 0-255. red, green and blue go together.',
    },
    green: {
      type: 'integer',
      minimum: 0,
      maximum: 255,
      description: 'Text colour green, 0-255.',
    },
    blue: {
      type: 'integer',
      minimum: 0,
      maximum: 255,
      description: 'Text colour blue, 0-255.',
    },
    alignment: {
      type: 'string',
      enum: [...ALIGNMENTS],
      description:
        'Text alignment. GIMP supports LEFT, CENTER, RIGHT and FULLYJUSTIFIED; the other ' +
        'values ps_text accepts (LEFTJUSTIFIED, CENTERJUSTIFIED, RIGHTJUSTIFIED) are refused.',
    },
  },
  required: ['image', 'op'],
};

interface TextBridgeResult {
  layer_id: number;
  name: string;
  font: string | null;
  font_size: number;
  bounds: { x: number | null; y: number | null; width: number; height: number };
}

async function gimpText(gimp: GimpBackend, rawArgs: Record<string, unknown>): Promise<ToolResult> {
  try {
    const args = validateArgs(textSchema, rawArgs);
    const result = await gimp.call<TextBridgeResult>(
      'text',
      pickSchemaDeclaredKeys(textSchema, args)
    );
    const b = result.bounds;
    return {
      content: [
        {
          type: 'text' as const,
          text:
            `Text layer "${result.name}" (id ${result.layer_id}): ${result.font ?? 'unknown font'} ` +
            `${result.font_size}pt, ${b.width}x${b.height} px at (${b.x}, ${b.y}).`,
        },
      ],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  } catch (error) {
    return toolGimpErrorResult('Error editing GIMP text layer', error);
  }
}

export function createGimpTextTools(gimp: GimpBackend): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'gimp_text',
        description:
          'Headless GIMP: create a live, editable text layer or restyle one, chosen with `op` ' +
          '(create, set_content, set_font, set_color, set_alignment) — the same ops and ' +
          'parameters as ps_text. create adds a layer at `x`/`y` with `text`, `font_size` in ' +
          'points, and optional font_name, red/green/blue and alignment; it reports layer_id, ' +
          'name and bounds. The set_* ops change the text layer named by `layer_id` or `layer` ' +
          '(a non-text layer is refused). Fonts accept a family ("Inter") or full name ("Inter ' +
          'Bold"), case-insensitive; a miss is refused with the closest installed names (list ' +
          'them with gimp_inspect what=fonts). Text is capped at 2000 characters, and a layer ' +
          'that would render past the size limit is refused and leaves the document unchanged. ' +
          'GIMP supports LEFT, CENTER, RIGHT and FULLYJUSTIFIED alignment only. There is no ' +
          'undo in this session: gimp_checkpoint or gimp_save_xcf first when in doubt.',
        inputSchema: textSchema,
        outputSchema: {
          type: 'object',
          properties: {
            layer_id: { type: 'number' },
            name: { type: 'string' },
            text: { type: 'string' },
            font: { type: ['string', 'null'] },
            font_size: { type: 'number', description: 'Points.' },
            color: {
              type: 'object',
              properties: {
                red: { type: 'number' },
                green: { type: 'number' },
                blue: { type: 'number' },
              },
            },
            alignment: { type: ['string', 'null'] },
            bounds: {
              type: 'object',
              properties: {
                x: { type: ['number', 'null'] },
                y: { type: ['number', 'null'] },
                width: { type: 'number' },
                height: { type: 'number' },
              },
            },
          },
        },
        annotations: {
          title: 'GIMP Text Layer',
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      handler: async (args) => gimpText(gimp, args),
    },
  ];
}

/** Exported for the schema/registration unit test. */
export const TEXT_SCHEMA_FOR_TESTS = textSchema;
