import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import type { SnippetClient } from '../api/snippet-client.js';
import { runScript } from '../utils/run-script.js';
import { type JsonSchemaObject } from '../utils/validate.js';
import { toolErrorResult, runSnippetTool } from '../utils/tool-helpers.js';

const undoSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    steps: {
      type: 'integer',
      description: 'Number of steps to undo (default: 1)',
      minimum: 1,
      default: 1,
    },
  },
};

const redoSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    steps: {
      type: 'integer',
      description: 'Number of steps to redo (default: 1)',
      minimum: 1,
      default: 1,
    },
  },
};

const HISTORY_STEP_RESULT_SCHEMA = {
  type: 'object' as const,
  properties: {
    undone: { type: 'boolean' },
    redone: { type: 'boolean' },
    steps: { type: 'number' },
    currentHistoryState: { type: 'string' },
    remainingStates: { type: 'number' },
    availableRedoSteps: { type: 'number' },
    context: { type: 'object' },
  },
};

export function createHistoryTools(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient
): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'ps_undo',
        description:
          'Step backward in the document history (equivalent to Ctrl/Cmd+Z). WHEN TO REACH FOR THIS: after an experimental destructive bake (ps_merge mode=visible/flatten, ps_apply_filter type=*_blur/sharpen/noise) produced a wrong result; after a play_action whose scope you mispredicted; or to revert an entire branch of exploration. Non-destructive workflows (adjustment layers + masks) rarely need this — just tweak/delete the offending layer instead. Reversible via ps_redo as long as no new edit has been made since. Returns current history state, remaining steps, and document context.',
        inputSchema: undoSchema,
        outputSchema: HISTORY_STEP_RESULT_SCHEMA,
        annotations: {
          title: 'Undo',
          // Not destructive: undo *reverses* destruction. Not idempotent:
          // each call advances the history cursor by N steps.
          idempotentHint: false,
        },
      },
      handler: async (args) => undo(connection, snippetClient, args),
    },
    {
      tool: {
        name: 'ps_redo',
        description:
          'Step forward in the document history (equivalent to Ctrl/Cmd+Shift+Z). Only works if ps_undo was the last operation; making a fresh edit destroys the redo stack. Returns updated context.',
        inputSchema: redoSchema,
        outputSchema: HISTORY_STEP_RESULT_SCHEMA,
        annotations: {
          title: 'Redo',
          idempotentHint: false,
        },
      },
      handler: async (args) => redo(connection, snippetClient, args),
    },
    // The old dedicated get_history reader merged into ps_inspect(what='history')
    // on 2026-06-26 (Phase 1b). getHistory is exported below for inspect-tools.ts.
  ];
}

async function undo(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: undoSchema,
    snippet: 'undo',
    errorPrefix: 'Error undoing',
    params: (args) => ({ steps: args.steps as number }),
    successText: (result, args) => {
      const steps = args.steps as number;
      return `Undo successful (${steps} step${steps > 1 ? 's' : ''})\nResult: ${JSON.stringify(result)}`;
    },
  });
}

async function redo(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: redoSchema,
    snippet: 'redo',
    errorPrefix: 'Error redoing',
    params: (args) => ({ steps: args.steps as number }),
    successText: (result, args) => {
      const steps = args.steps as number;
      return `Redo successful (${steps} step${steps > 1 ? 's' : ''})\nResult: ${JSON.stringify(result)}`;
    },
  });
}

export async function getHistory(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient
): Promise<ToolResult> {
  try {
    const script = await snippetClient.build('getHistoryStates');
    const result = await runScript(connection, script);

    return {
      content: [
        {
          type: 'text' as const,
          text: `History States:\n${JSON.stringify(result, null, 2)}`,
        },
      ],
      structuredContent: result as Record<string, unknown>,
    };
  } catch (error) {
    return toolErrorResult('Error getting history', error);
  }
}
