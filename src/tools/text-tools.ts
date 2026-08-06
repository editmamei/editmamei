import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import type { SnippetClient } from '../api/snippet-client.js';
import { runScript } from '../utils/run-script.js';
import { validateArgs, type JsonSchemaObject } from '../utils/validate.js';
import { toolErrorResult, runSnippetTool } from '../utils/tool-helpers.js';

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

const SET_TEXT_PROPERTIES = ['font', 'color', 'alignment', 'content'] as const;

// Consolidated input schema for ps_set_text (Phase 1, 2026-06-20).
// Merges the four per-property schemas; no field-name collisions across them.
// The handler re-validates against the exact per-property schema.
const SET_TEXT_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    property: {
      type: 'string',
      enum: [...SET_TEXT_PROPERTIES],
      description:
        'Which text attribute to set on the active text layer: ' +
        'font(font_name, optional font_size); color(red, green, blue); ' +
        'alignment(alignment); content(text).',
    },
    ...setTextFontSchema.properties,
    ...setTextColorSchema.properties,
    ...setTextAlignmentSchema.properties,
    ...updateTextContentSchema.properties,
  },
  required: ['property'],
};

export function createTextTools(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient
): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'ps_set_text',
        description:
          'Set an attribute of the currently active text layer — font (family or PostScript name, optionally size), color (RGB), alignment, or text content — selected via `property`. Idempotent. Throws if the active layer is not a text layer. Font names accept either the PostScript name ("ArialMT") or family name ("Arial", resolved to its Regular/first variant); throws clearly if no installed font matches.',
        inputSchema: SET_TEXT_INPUT_SCHEMA,
        outputSchema: {
          type: 'object',
          properties: {
            requested: { type: 'string' },
            font: { type: 'string' },
            size: { type: 'number' },
            matched_by: {
              type: 'string',
              enum: ['postScriptName', 'family+regular', 'family', 'name'],
            },
            color: { type: 'string' },
            alignment: { type: 'string' },
            text: { type: 'string' },
          },
        },
        annotations: {
          title: 'Set Text',
          idempotentHint: true,
        },
      },
      handler: async (args) => setText(connection, snippetClient, args),
    },
  ];
}

// Dispatch the consolidated tool to the per-property handler. `property` is
// stripped so the delegate validates only its own params.
async function setText(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  const property = rawArgs.property;
  const { property: _omit, ...rest } = rawArgs;
  switch (property) {
    case 'font':
      return setTextFont(connection, snippetClient, rest);
    case 'color':
      return setTextColor(connection, snippetClient, rest);
    case 'alignment':
      return setTextAlignment(connection, snippetClient, rest);
    case 'content':
      return updateTextContent(connection, snippetClient, rest);
    default:
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: unknown text property "${String(property)}". Allowed: ${SET_TEXT_PROPERTIES.join(', ')}.`,
          },
        ],
        isError: true,
      };
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
