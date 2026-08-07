/**
 * Dev-tier tool — ps_guides (M2, 2026-06-21).
 *
 * Document guides: add a single guide (op=add, via the DOM Guides API), lay out
 * an evenly-spaced grid of guides (op=layout, AM newGuideLayout), or clear all
 * guides (op=clear, AM clearAllGuides). dev-tier until live-verified.
 */
import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import type { SnippetClient } from '../api/snippet-client.js';
import { type JsonSchemaObject } from '../utils/validate.js';
import { runSnippetTool } from '../utils/tool-helpers.js';

const addGuideSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    orientation: {
      type: 'string',
      enum: ['horizontal', 'vertical'],
      description:
        "'vertical' adds a top-to-bottom guide positioned by its x coordinate; 'horizontal' adds a left-to-right guide positioned by its y coordinate.",
    },
    position: {
      type: 'number',
      description:
        'Guide position in document pixels (the x for a vertical guide, the y for a horizontal guide).',
      minimum: 0,
    },
  },
  required: ['orientation', 'position'],
};

const guideLayoutSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    columns: {
      type: 'integer',
      description: 'Number of evenly-spaced columns (vertical guides). 0 = none.',
      minimum: 0,
      default: 0,
    },
    rows: {
      type: 'integer',
      description: 'Number of evenly-spaced rows (horizontal guides). 0 = none.',
      minimum: 0,
      default: 0,
    },
  },
};

const clearGuidesSchema: JsonSchemaObject = {
  type: 'object',
  properties: {},
};

const GUIDE_OPS = ['add', 'layout', 'clear'] as const;

const GUIDE_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    op: {
      type: 'string',
      enum: [...GUIDE_OPS],
      description:
        'Guide operation. add: one guide at position (orientation + position px). layout: an evenly-spaced grid (columns and/or rows). clear: remove ALL guides from the document.',
    },
    ...addGuideSchema.properties,
    ...guideLayoutSchema.properties,
  },
  required: ['op'],
};

export function createGuideTools(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient
): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'ps_guides',
        description:
          'Manage document guides — non-printing layout aids for a HUMAN working in Photoshop. Guides are editor-only chrome: they do NOT render into ps_get_preview (the exported/flattened image), so they are a user authoring aid, not a model-perception tool — place them when a person will open the PSD and wants alignment/composition marks. Choose with `op`. `add` places one guide (orientation horizontal|vertical) at a `position` in px. `layout` creates an evenly-spaced grid (columns and/or rows — great for rule-of-thirds at 3×3). `clear` removes all guides.',
        inputSchema: GUIDE_INPUT_SCHEMA,
        outputSchema: {
          type: 'object',
          properties: {
            guide_added: { type: 'boolean' },
            guide_layout_created: { type: 'boolean' },
            guides_cleared: { type: 'boolean' },
            orientation: { type: 'string' },
            position: { type: 'number' },
            columns: { type: 'number' },
            rows: { type: 'number' },
          },
        },
        annotations: {
          title: 'Document Guides',
          idempotentHint: false,
        },
      },
      handler: async (args) => guides(connection, snippetClient, args),
    },
  ];
}

async function guides(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  const op = rawArgs.op;
  const { op: _omit, ...rest } = rawArgs;
  switch (op) {
    case 'add':
      return addGuide(connection, snippetClient, rest);
    case 'layout':
      return addGuideLayout(connection, snippetClient, rest);
    case 'clear':
      return clearGuides(connection, snippetClient);
    default:
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: unknown guides op "${String(op)}". Allowed: ${GUIDE_OPS.join(', ')}.`,
          },
        ],
        isError: true,
      };
  }
}

async function addGuide(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: addGuideSchema,
    snippet: 'addGuide',
    errorPrefix: 'Error adding guide',
    params: (args) => ({
      orientation: args.orientation as 'horizontal' | 'vertical',
      position: args.position as number,
    }),
    successText: (result, args) => {
      const orientation = args.orientation as 'horizontal' | 'vertical';
      const position = args.position as number;
      return `Added ${orientation} guide at ${position}px\nResult: ${JSON.stringify(result)}`;
    },
  });
}

async function addGuideLayout(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: guideLayoutSchema,
    snippet: 'addGuideLayout',
    errorPrefix: 'Error creating guide layout',
    params: (args) => {
      const columns = (args.columns as number | undefined) ?? 0;
      const rows = (args.rows as number | undefined) ?? 0;
      if (columns <= 0 && rows <= 0) {
        throw new Error('op=layout requires at least one of columns / rows to be ≥ 1.');
      }
      return { columns, rows };
    },
    successText: (result, args) => {
      const columns = (args.columns as number | undefined) ?? 0;
      const rows = (args.rows as number | undefined) ?? 0;
      return `Created guide layout (${columns} columns × ${rows} rows)\nResult: ${JSON.stringify(result)}`;
    },
  });
}

async function clearGuides(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs: {},
    schema: clearGuidesSchema,
    snippet: 'clearGuides',
    errorPrefix: 'Error clearing guides',
    successText: (result) => `Cleared all guides\nResult: ${JSON.stringify(result)}`,
  });
}
