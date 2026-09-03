/**
 * ps_sequence — run an ordered list of already-registered tool calls in one
 * round trip, dispatched through the same `invokeTool` broker scene reading
 * uses (Kernel §7: the same path an MCP request takes, on the shared
 * serialized Photoshop connection). Composes ONLY tools the caller already
 * has; it never executes arbitrary code (that's ps_execute_script, Pro) and
 * it never fans a recipe out over a folder of files (that's ps_batch, Pro).
 */
import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { validateArgs, type JsonSchemaObject, type JsonSchemaProperty } from '../utils/validate.js';
import { toolErrorResult } from '../utils/tool-helpers.js';
import { TOOL_TIERS, isToolAllowedInEdition } from '../core/tool-tiers.js';
import { EDITION } from '../edition.js';
import { SEQUENCE_OVERALL_TIMEOUT_MS } from '../utils/operation-timeouts.js';

type InvokeTool = (name: string, args: Record<string, unknown>) => Promise<ToolResult>;

const SEQUENCE_TOOL_NAME = 'ps_sequence';
const MIN_STEPS = 1;
const MAX_STEPS = 25;

/**
 * Tools whose effect sits outside the document's history cursor: opening or
 * creating a document, closing one, saving one, or switching which one is
 * active (ps_document's op=activate). `doc.activeHistoryState` — what
 * ps_undo/ps_redo and this tool's rollback move — is a per-document cursor;
 * none of these four categories are reversible by moving it, and Photoshop's
 * history buffer is finite besides. Kept in one place so on_error='rollback'
 * validation (below) and any future caller asking the same question read the
 * identical list.
 */
const HISTORY_UNSAFE_TOOLS = new Set<string>([
  'ps_open_document',
  'ps_create_document',
  'ps_close_document',
  'ps_save_psd',
  'ps_document',
]);

const stepItemSchema: JsonSchemaProperty = {
  type: 'object',
  description:
    'One call: `tool` is a registered tool name, `args` is the object it would normally receive.',
  properties: {
    tool: { type: 'string', description: 'A tool name from tools/list, e.g. "ps_set_layer".' },
    args: {
      type: 'object',
      description: 'Arguments for that call, exactly as the named tool expects them.',
    },
  },
  required: ['tool'],
};

const sequenceSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      description: `Ordered list of tool calls to run against the current document, ${MIN_STEPS} to ${MAX_STEPS} items.`,
      items: stepItemSchema,
      minItems: MIN_STEPS,
      maxItems: MAX_STEPS,
    },
    on_error: {
      type: 'string',
      enum: ['stop', 'continue', 'rollback'],
      default: 'stop',
      description:
        'stop: halt at the first failing step and return results so far. continue: record the failure and run every remaining step anyway. rollback: on the first failing step, restore the history cursor to its state before step one and stop — refused at VALIDATION time (before any step runs) if any step opens, creates, closes, or saves a document, or switches the active one, since those sit outside what the history cursor can undo.',
    },
    return: {
      type: 'string',
      enum: ['summary', 'full'],
      default: 'summary',
      description:
        "summary: one line per step plus the LAST step's full result. full: every step's full result. Either way, an inline preview (image content) is stripped from every step except the last — previews are most of a result's bytes, and a sequence exists to stop paying for them on intermediate steps.",
    },
  },
  required: ['steps'],
};

const stepSummaryItemSchema = {
  type: 'object',
  properties: {
    index: { type: 'number' },
    tool: { type: 'string' },
    ok: { type: 'boolean' },
    duration_ms: { type: 'number' },
    text: { type: 'string', description: "The first line of that step's own result text." },
  },
};

const stepFullItemSchema = {
  type: 'object',
  properties: {
    index: { type: 'number' },
    tool: { type: 'string' },
    ok: { type: 'boolean' },
    duration_ms: { type: 'number' },
    result: { type: 'object', description: "That step's full CallToolResult." },
  },
};

const sequenceOutputSchema = {
  type: 'object' as const,
  properties: {
    on_error: { type: 'string' },
    return: { type: 'string' },
    total_steps: { type: 'number' },
    ran_steps: { type: 'number', description: 'How many entries actually ran or were attempted.' },
    failed_step: {
      type: ['object', 'null'],
      description: 'The first failing step, or the step skipped by the overall time budget.',
      properties: {
        index: { type: 'number' },
        tool: { type: 'string' },
      },
    },
    cap_exceeded: { type: 'boolean' },
    rolled_back: { type: 'boolean' },
    steps: {
      type: 'array',
      description: 'One entry per step run — summary shape or full shape depending on `return`.',
      items: { oneOf: [stepSummaryItemSchema, stepFullItemSchema] },
    },
    final: {
      type: 'object',
      description: "The last step's full CallToolResult (summary mode only).",
    },
  },
  required: ['on_error', 'return', 'total_steps', 'ran_steps', 'steps'],
};

interface SequenceStep {
  tool: string;
  args: Record<string, unknown>;
}

type OnError = 'stop' | 'continue' | 'rollback';
type ReturnMode = 'summary' | 'full';

interface ParsedSequenceArgs {
  steps: SequenceStep[];
  onError: OnError;
  returnMode: ReturnMode;
}

/**
 * Full validation, run BEFORE any step is dispatched: every step's `tool` is
 * a non-empty string registered in the current edition, none is ps_sequence
 * itself, the step count is in bounds, and — only when on_error='rollback' —
 * no step names a HISTORY_UNSAFE_TOOLS entry. Throws a plain Error naming the
 * offending step; the caller turns that into an error result without running
 * anything.
 */
function validateSequenceArgs(rawArgs: Record<string, unknown>): ParsedSequenceArgs {
  const args = validateArgs(sequenceSchema, rawArgs);
  const rawSteps = args.steps;
  if (!Array.isArray(rawSteps)) {
    throw new Error('"steps" must be an array');
  }
  if (rawSteps.length < MIN_STEPS || rawSteps.length > MAX_STEPS) {
    throw new Error(
      `"steps" must contain ${MIN_STEPS} to ${MAX_STEPS} items, got ${rawSteps.length}`
    );
  }

  const steps: SequenceStep[] = rawSteps.map((raw, i) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`step ${i + 1}: expected an object with "tool" and "args"`);
    }
    const stepObj = raw as Record<string, unknown>;
    const tool = stepObj.tool;
    if (typeof tool !== 'string' || tool.length === 0) {
      throw new Error(`step ${i + 1}: "tool" must be a non-empty string`);
    }
    if (tool === SEQUENCE_TOOL_NAME) {
      throw new Error(`step ${i + 1}: cannot nest ${SEQUENCE_TOOL_NAME} inside itself`);
    }
    if (!Object.hasOwn(TOOL_TIERS, tool) || !isToolAllowedInEdition(tool, EDITION)) {
      throw new Error(`step ${i + 1}: "${tool}" is not a tool registered in this edition`);
    }
    const rawStepArgs = stepObj.args;
    if (
      rawStepArgs !== undefined &&
      (typeof rawStepArgs !== 'object' || rawStepArgs === null || Array.isArray(rawStepArgs))
    ) {
      throw new Error(`step ${i + 1}: "args" must be an object`);
    }
    return { tool, args: (rawStepArgs as Record<string, unknown> | undefined) ?? {} };
  });

  const onError = args.on_error as OnError;
  const returnMode = args.return as ReturnMode;

  if (onError === 'rollback') {
    const firstUnsafe = steps.findIndex((s) => HISTORY_UNSAFE_TOOLS.has(s.tool));
    if (firstUnsafe !== -1) {
      const tool = steps[firstUnsafe].tool;
      throw new Error(
        `step ${firstUnsafe + 1}: on_error="rollback" can't be honored because "${tool}" opens, creates, closes, or saves a document, or switches the active one — outside what the history cursor can undo. Use on_error="stop" or "continue", or drop that step.`
      );
    }
  }

  return { steps, onError, returnMode };
}

function syntheticError(message: string): ToolResult {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

function firstTextLine(result: ToolResult): string {
  const block = result.content?.find((b) => b.type === 'text');
  if (!block || !('text' in block)) return '';
  const newline = block.text.indexOf('\n');
  return newline === -1 ? block.text : block.text.slice(0, newline);
}

/** Drops image content blocks; text/other blocks and structuredContent are untouched. */
function stripImages(result: ToolResult): ToolResult {
  if (!Array.isArray(result.content)) return result;
  const kept = result.content.filter((b) => b.type !== 'image');
  return kept.length === result.content.length ? result : { ...result, content: kept };
}

/** Reads `currentIndex` out of a ps_inspect(what='history') result. Null on anything unusable. */
function extractHistoryIndex(result: ToolResult): number | null {
  if (result.isError) return null;
  const sc = result.structuredContent as { currentIndex?: unknown } | undefined;
  const idx = sc?.currentIndex;
  return typeof idx === 'number' && Number.isFinite(idx) ? idx : null;
}

/**
 * Restores the history cursor captured before step one. Computes the current
 * index again (ps_inspect), then undoes exactly the distance travelled since
 * (ps_undo steps=delta) — the same index-based technique go-core's own
 * undo/redo fragments use, reached here through the ordinary tool surface
 * rather than new engine code.
 */
async function performRollback(
  invokeTool: InvokeTool,
  capturedIndex: number
): Promise<{ ok: boolean; message: string }> {
  try {
    const after = await invokeTool('ps_inspect', { what: 'history' });
    const afterIndex = extractHistoryIndex(after);
    if (afterIndex === null) {
      return { ok: false, message: 'could not read the document history to compute the rollback' };
    }
    const delta = afterIndex - capturedIndex;
    if (delta <= 0) {
      return { ok: true, message: 'no in-document edits had occurred; nothing to roll back' };
    }
    const undone = await invokeTool('ps_undo', { steps: delta });
    if (undone.isError) {
      return { ok: false, message: `rollback failed: ${firstTextLine(undone)}` };
    }
    return {
      ok: true,
      message: `document restored to its state before step 1 (${delta} step${delta === 1 ? '' : 's'} undone)`,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `rollback failed: ${msg}` };
  }
}

interface StepEntry {
  index: number;
  tool: string;
  ok: boolean;
  duration_ms: number;
  result: ToolResult;
}

interface FailedStep {
  index: number;
  tool: string;
}

function buildMessage(input: {
  ranBeforeCap: number;
  total: number;
  onError: OnError;
  failedStep: FailedStep | null;
  capExceeded: boolean;
  rolledBack: boolean;
  rollbackMessage: string;
}): string {
  const { ranBeforeCap, total, onError, failedStep, capExceeded, rolledBack, rollbackMessage } =
    input;

  if (capExceeded && failedStep) {
    const base = `Sequence exceeded its overall time budget (${SEQUENCE_OVERALL_TIMEOUT_MS}ms) before step ${failedStep.index + 1} (${failedStep.tool}) could run; stopped after ${ranBeforeCap}/${total} step(s).`;
    if (onError !== 'rollback') return base;
    return rolledBack
      ? `${base} Document rolled back: ${rollbackMessage}.`
      : `${base} Rollback did not complete: ${rollbackMessage}.`;
  }

  if (!failedStep) {
    return `Sequence completed all ${total} step(s).`;
  }

  if (onError === 'continue') {
    return `Sequence completed all ${total} step(s); step ${failedStep.index + 1} (${failedStep.tool}) failed and was recorded.`;
  }

  if (onError === 'rollback') {
    return rolledBack
      ? `Sequence stopped at step ${failedStep.index + 1} (${failedStep.tool}) after a failure; ${rollbackMessage}.`
      : `Sequence stopped at step ${failedStep.index + 1} (${failedStep.tool}) after a failure; rollback did not complete: ${rollbackMessage}.`;
  }

  return `Sequence stopped at step ${failedStep.index + 1} (${failedStep.tool}) after a failure; ${ranBeforeCap}/${total} step(s) ran.`;
}

async function runSequence(
  invokeTool: InvokeTool,
  rawArgs: Record<string, unknown>,
  now: () => number
): Promise<ToolResult> {
  let parsed: ParsedSequenceArgs;
  try {
    parsed = validateSequenceArgs(rawArgs);
  } catch (error) {
    return toolErrorResult('Error validating sequence', error);
  }
  const { steps, onError, returnMode } = parsed;

  let capturedHistoryIndex: number | null = null;
  if (onError === 'rollback') {
    let before: ToolResult;
    try {
      before = await invokeTool('ps_inspect', { what: 'history' });
    } catch (error) {
      return toolErrorResult('Error capturing history state before the sequence', error);
    }
    capturedHistoryIndex = extractHistoryIndex(before);
    if (capturedHistoryIndex === null) {
      return toolErrorResult(
        'Error capturing history state before the sequence',
        new Error('ps_inspect(what="history") did not return a usable history index')
      );
    }
  }

  const startedAt = now();
  const entries: StepEntry[] = [];
  let failedStep: FailedStep | null = null;
  let capExceeded = false;
  let rolledBack = false;
  let rollbackMessage = '';

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    if (now() - startedAt > SEQUENCE_OVERALL_TIMEOUT_MS) {
      capExceeded = true;
      failedStep = { index: i, tool: step.tool };
      entries.push({
        index: i,
        tool: step.tool,
        ok: false,
        duration_ms: 0,
        result: syntheticError(
          `Sequence exceeded its overall time budget (${SEQUENCE_OVERALL_TIMEOUT_MS}ms) before this step could run.`
        ),
      });
      if (onError === 'rollback') {
        const r = await performRollback(invokeTool, capturedHistoryIndex as number);
        rolledBack = r.ok;
        rollbackMessage = r.message;
      }
      break;
    }

    const stepStarted = now();
    let result: ToolResult;
    try {
      result = await invokeTool(step.tool, step.args);
    } catch (error) {
      result = syntheticError(error instanceof Error ? error.message : String(error));
    }
    const duration_ms = now() - stepStarted;
    const ok = !result.isError;
    entries.push({ index: i, tool: step.tool, ok, duration_ms, result });

    if (!ok) {
      // Only the FIRST failure is recorded here — under on_error='continue'
      // several steps can fail, but "failed_step" points at the one that
      // started it, same as 'stop'/'rollback' (which never see a second one
      // to compare against). Every step's own `ok` still shows in `steps`.
      if (failedStep === null) failedStep = { index: i, tool: step.tool };
      if (onError === 'rollback') {
        const r = await performRollback(invokeTool, capturedHistoryIndex as number);
        rolledBack = r.ok;
        rollbackMessage = r.message;
        break;
      }
      if (onError === 'stop') {
        break;
      }
      // continue: fall through and run the next step.
    }
  }

  const lastIndex = entries.length - 1;
  const stripped = entries.map((e, idx) =>
    idx === lastIndex ? e : { ...e, result: stripImages(e.result) }
  );
  const ranBeforeCap = capExceeded ? entries.length - 1 : entries.length;
  const anyFailure = failedStep !== null;
  const isError = capExceeded || (anyFailure && onError !== 'continue');

  const message = buildMessage({
    ranBeforeCap,
    total: steps.length,
    onError,
    failedStep,
    capExceeded,
    rolledBack,
    rollbackMessage,
  });

  const common = {
    on_error: onError,
    return: returnMode,
    total_steps: steps.length,
    ran_steps: entries.length,
    failed_step: failedStep,
    cap_exceeded: capExceeded,
    rolled_back: rolledBack,
  };

  const structuredContent: Record<string, unknown> =
    returnMode === 'full'
      ? {
          ...common,
          steps: stripped.map((e) => ({
            index: e.index,
            tool: e.tool,
            ok: e.ok,
            duration_ms: e.duration_ms,
            result: e.result,
          })),
        }
      : {
          ...common,
          steps: stripped.map((e) => ({
            index: e.index,
            tool: e.tool,
            ok: e.ok,
            duration_ms: e.duration_ms,
            text: firstTextLine(e.result),
          })),
          final: stripped[lastIndex]?.result,
        };

  return {
    content: [{ type: 'text' as const, text: message }],
    structuredContent,
    ...(isError ? { isError: true as const } : {}),
  };
}

export interface CreateSequenceToolsOptions {
  /** Wall-clock source — injected so the overall-budget test can drive a fake clock. Defaults to Date.now. */
  now?: () => number;
}

export function createSequenceTools(
  invokeTool: InvokeTool,
  opts: CreateSequenceToolsOptions = {}
): ToolDefinition[] {
  const { now = Date.now } = opts;
  return [
    {
      tool: {
        name: SEQUENCE_TOOL_NAME,
        description:
          "Run an ordered list of tool calls against the current document in ONE round trip. WHEN TO REACH FOR THIS: several dependent steps you already know you want (e.g. select → adjust → merge, or a repeated resize/export pass) where you do not need to look at the result between them — each step is dispatched the same way an ordinary call is and sees the document exactly as the previous step left it. Not for exploratory work: if the next step depends on inspecting this one first, call the tools individually instead. Every step must name a tool that already exists in this edition (ps_sequence cannot call itself). An inline preview (image content) returned by a step is dropped unless that step is the LAST one in the sequence, since previews are most of a result's bytes and the point of batching calls is to stop paying for them on every intermediate step.",
        inputSchema: sequenceSchema,
        outputSchema: sequenceOutputSchema,
        annotations: {
          title: 'Run a Tool Sequence',
          destructiveHint: true,
          idempotentHint: false,
        },
      },
      handler: async (args) => runSequence(invokeTool, args, now),
    },
  ];
}
