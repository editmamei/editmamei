import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import type { SnippetClient } from '../api/snippet-client.js';
import { runScript } from '../utils/run-script.js';
import { validateArgs, type JsonSchemaObject } from '../utils/validate.js';
import { toolErrorResult, runSnippetTool, unknownDiscriminator } from '../utils/tool-helpers.js';
import { createTextLayer, createTextLayerSchema } from './layer-tools.js';

const setTextFontSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    font_name: {
      type: 'string',
      description: 'Font family name (e.g., "Arial", "Helvetica").',
    },
    font_size: {
      type: 'number',
      description: 'Font size in points (optional).',
      minimum: 1,
    },
  },
  required: ['font_name'],
};

const setTextColorSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    red: {
      type: 'integer',
      description: 'Red component (0-255).',
      minimum: 0,
      maximum: 255,
    },
    green: {
      type: 'integer',
      description: 'Green component (0-255).',
      minimum: 0,
      maximum: 255,
    },
    blue: {
      type: 'integer',
      description: 'Blue component (0-255).',
      minimum: 0,
      maximum: 255,
    },
  },
  required: ['red', 'green', 'blue'],
};

const setTextAlignmentSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    alignment: {
      type: 'string',
      description: 'Text alignment.',
      enum: [
        'LEFT',
        'CENTER',
        'RIGHT',
        'LEFTJUSTIFIED',
        'CENTERJUSTIFIED',
        'RIGHTJUSTIFIED',
        'FULLYJUSTIFIED',
      ],
    },
  },
  required: ['alignment'],
};

const updateTextContentSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    text: {
      type: 'string',
      description: 'New text content.',
    },
  },
  required: ['text'],
};

const TEXT_OPS = ['create', 'set_content', 'set_font', 'set_color', 'set_alignment'] as const;

// The schema each op re-validates against once the discriminator is stripped.
// Exported so a test can assert TEXT_INPUT_SCHEMA below is a superset of all
// five: a param that only the delegate's schema knows about is a param the
// caller cannot see in tools/list.
export const TEXT_OP_SCHEMAS: Record<(typeof TEXT_OPS)[number], JsonSchemaObject> = {
  create: createTextLayerSchema,
  set_content: updateTextContentSchema,
  set_font: setTextFontSchema,
  set_color: setTextColorSchema,
  set_alignment: setTextAlignmentSchema,
};

// Consolidated input schema for ps_text. Creating a text layer and styling one
// share a single flat op enum — a two-level op+property discriminator is
// exactly the "a reader can't tell which params apply" smell this design
// avoids. `text`/`font_size` are shared verbatim across the ops that use them
// (same meaning, one unified description below); the handler re-validates
// each op against its own per-op schema (createTextLayerSchema,
// setTextFontSchema, setTextColorSchema, setTextAlignmentSchema,
// updateTextContentSchema).
const TEXT_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    op: {
      type: 'string',
      enum: [...TEXT_OPS],
      description:
        'create: new text layer with `text` at `x`/`y` (default 100,100) and `font_size` (default 24). ' +
        "set_content: replace the active text layer's content with `text`. " +
        "set_font: set the active text layer's font to `font_name` (optionally `font_size`). " +
        "set_color: set the active text layer's color to `red`/`green`/`blue`. " +
        "set_alignment: set the active text layer's `alignment`.",
    },
    ...createTextLayerSchema.properties,
    ...setTextColorSchema.properties,
    ...setTextAlignmentSchema.properties,
    font_name: setTextFontSchema.properties!.font_name,
    text: {
      type: 'string',
      description:
        'create: initial text content. set_content: new text content, replacing the existing text.',
    },
    font_size: {
      type: 'number',
      description:
        "Font size in points, up to 1296 — Photoshop's own ceiling for the Character panel. create: initial size (default 24). set_font: new size (optional — omit to leave the current size unchanged).",
      default: 24,
      minimum: 1,
      maximum: 1296,
    },
  },
  required: ['op'],
};

export function createTextTools(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient
): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'ps_text',
        description:
          'Text layer — create it or style it, chosen with `op`. create: a new text layer with `text` at `x`/`y` and `font_size`. set_content/set_font/set_color/set_alignment act on the currently active text layer (throws if it isn\'t one). Font names accept either the PostScript name ("ArialMT") or family name ("Arial", resolved to its Regular/first variant); throws clearly if no installed font matches. The set_* ops are idempotent.',
        inputSchema: TEXT_INPUT_SCHEMA,
        outputSchema: {
          type: 'object',
          properties: {
            created: { type: 'boolean', description: 'op=create: true on success.' },
            layerName: { type: 'string', description: 'op=create: the new layer name.' },
            position: { type: 'object', description: 'op=create: {x, y}.' },
            fontSize: { type: 'number', description: 'op=create: the size applied.' },
            requested: { type: 'string', description: 'op=set_font: the font requested.' },
            font: { type: 'string', description: 'op=set_font: the font actually matched.' },
            size: { type: 'number', description: 'op=set_font: the size applied, if given.' },
            matched_by: {
              type: 'string',
              enum: ['postScriptName', 'family+regular', 'family', 'name'],
              description: 'op=set_font: how `font_name` was resolved.',
            },
            color: { type: 'string', description: 'op=set_color: the RGB() string applied.' },
            alignment: { type: 'string', description: 'op=set_alignment: the alignment applied.' },
            text: { type: 'string', description: 'op=create/set_content: the text content.' },
            context: { type: 'object' },
          },
        },
        annotations: {
          title: 'Text',
          idempotentHint: false,
        },
      },
      handler: async (args) => textDispatch(connection, snippetClient, args),
    },
  ];
}

// ps_text → create / set_content / set_font / set_color / set_alignment. Each
// op strips the discriminator and hands the rest to the matching handler
// (createTextLayer imported from layer-tools.ts; updateTextContent /
// setTextFont / setTextColor / setTextAlignment below), which re-validates
// against its own per-op schema.
async function textDispatch(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  const op = rawArgs.op;
  const { op: _omit, ...rest } = rawArgs;
  switch (op) {
    case 'create':
      return createTextLayer(connection, snippetClient, rest);
    case 'set_content':
      return updateTextContent(connection, snippetClient, rest);
    case 'set_font':
      return setTextFont(connection, snippetClient, rest);
    case 'set_color':
      return setTextColor(connection, snippetClient, rest);
    case 'set_alignment':
      return setTextAlignment(connection, snippetClient, rest);
    default:
      return unknownDiscriminator('text op', op, TEXT_OPS);
  }
}

async function setTextFont(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: setTextFontSchema,
    snippet: 'setTextFont',
    errorPrefix: 'Error setting text font',
    params: (args) => {
      const fontSize = args.font_size as number | undefined;
      const params: Record<string, unknown> = { fontName: args.font_name as string };
      if (fontSize !== undefined) params.fontSize = fontSize;
      return params;
    },
    successText: (result, args) => {
      const fontName = args.font_name as string;
      const fontSize = args.font_size as number | undefined;
      return `Text font set to ${fontName}${fontSize ? `, size ${fontSize}pt` : ''}\nResult: ${JSON.stringify(result)}`;
    },
  });
}

async function setTextColor(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(setTextColorSchema, rawArgs);
    const red = args.red as number;
    const green = args.green as number;
    const blue = args.blue as number;

    await runScript(connection, await snippetClient.build('setTextColor', { red, green, blue }));

    return {
      content: [
        {
          type: 'text' as const,
          text: `Text color set to RGB(${red}, ${green}, ${blue})`,
        },
      ],
      structuredContent: {
        color: `RGB(${red}, ${green}, ${blue})`,
      },
    };
  } catch (error) {
    return toolErrorResult('Error setting text color', error);
  }
}

async function setTextAlignment(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(setTextAlignmentSchema, rawArgs);
    const alignment = args.alignment as string;

    await runScript(connection, await snippetClient.build('setTextAlignment', { alignment }));

    return {
      content: [
        {
          type: 'text' as const,
          text: `Text alignment set to ${alignment}`,
        },
      ],
      structuredContent: { alignment },
    };
  } catch (error) {
    return toolErrorResult('Error setting text alignment', error);
  }
}

async function updateTextContent(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(updateTextContentSchema, rawArgs);
    const text = args.text as string;

    await runScript(connection, await snippetClient.build('updateTextContent', { newText: text }));

    return {
      content: [
        {
          type: 'text' as const,
          text: `Text content updated to: "${text}"`,
        },
      ],
      structuredContent: { text },
    };
  } catch (error) {
    return toolErrorResult('Error updating text content', error);
  }
}
