/**
 * ps_sequence — run an ordered list of already-registered tool calls in one
 * round trip, dispatched through the same `invokeTool` broker scene reading
 * uses (Kernel §7: the same path an MCP request takes, on the shared
 * serialized Photoshop connection). Composes only tools already registered
 * for the caller's edition, against the current document.
 */
import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { validateArgs, type JsonSchemaObject, type JsonSchemaProperty } from '../utils/validate.js';
import { toolErrorResult } from '../utils/tool-helpers.js';
import { SEQUENCE_OVERALL_TIMEOUT_MS } from '../utils/operation-timeouts.js';

type InvokeTool = (name: string, args: Record<string, unknown>) => Promise<ToolResult>;

/**
 * Whether `name` is currently dispatchable — backed by the live registry
 * (HostApi.hasTool), not a static edition table. Registry membership already
 * IS the entitlement check: the kernel only registers what this build/module
 * set is entitled to, so a name that is not registered would throw at
 * dispatch regardless of what a static table says. Taken as a parameter
 * (rather than imported) so a test can inject one that rejects on demand.
 */
type HasTool = (name: string) => boolean;

const SEQUENCE_TOOL_NAME = 'ps_sequence';
const MIN_STEPS = 1;
const MAX_STEPS = 25;

/**
 * Tools ps_sequence refuses BY NAME under on_error='rollback', before any
 * step runs — each can move the document (or the cursor rollback itself
 * depends on) in a way the history cursor cannot undo. Limited to
 * community-tier names on purpose: a naming list can only promise coverage
 * for tools guaranteed present in every build this file ships in, so a
 * pro-tier name here would be a broken promise in a build that never
 * registers it — and a test pins that no entry is 'pro' in TOOL_TIERS.
 *
 * This list refuses the cases it can name; anything it can't (a Pro tool,
 * or a community tool this list missed) is caught AFTER the fact instead —
 * `performRollback`'s document_changed and history_evicted checks catch a
 * document switch or an evicted history state regardless of which step
 * caused it. One comment per entry naming the mechanism.
 */
export const HISTORY_UNSAFE_TOOLS = new Set<string>([
  'ps_open_document', // opens a different document — history is per-document
  'ps_create_document', // creates and activates a new document — nothing to return to
  'ps_close_document', // closes a document — the captured state may cease to exist
  'ps_save_psd', // writes a file to disk; undoing history can't un-write it
  'ps_export', // writes a file to disk; undoing history can't un-write it
  'ps_document', // op=activate switches which document is active
  'ps_undo', // moves the history cursor directly, corrupting the delta rollback computes
  'ps_redo', // moves the history cursor directly, corrupting the delta rollback computes
]);

// Declaration order, not sorted — keeps the user-facing list in the same
// order as the per-entry comments above.
const HISTORY_UNSAFE_TOOLS_LIST = Array.from(HISTORY_UNSAFE_TOOLS).join(', ');

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
      description: `stop: halt at the first failing step and return results so far. continue: record the failure and run every remaining step anyway. rollback: on the first failing step, undo back to the history state captured before step one and VERIFY the document actually landed there (index, state name, and active document all re-checked) before reporting success — refused at VALIDATION time (before any step runs) if any step names one of: ${HISTORY_UNSAFE_TOOLS_LIST}, since those sit outside what the history cursor can undo. Assumes nothing else edits the document while the sequence runs; a manual edit interleaved between steps corrupts the undo distance rollback computes.`,
    },
    return: {
      type: 'string',
      enum: ['summary', 'full'],
      default: 'summary',
      description:
        "summary: one line per step plus the LAST step's full result. full: every step's full result — note this means every embedded payload (not just the last step's) lands in the logged call record. Either way, an inline preview (image content) is stripped from every step except the last — previews are most of a result's bytes, and a sequence exists to stop paying for them on intermediate steps.",
    },
  },
  required: ['steps'],
};

// ONE schema covering both row shapes ('summary' rows carry `text`, 'full'
// rows carry `result`) rather than a `oneOf` of two schemas. Neither
// candidate sub-schema declared `required` or `additionalProperties: false`,
// so a summary row (no `result` field) satisfied the full-row schema too —
// nothing in it was actually required — and `oneOf` demands EXACTLY one
// match; every row failed Ajv validation in both modes. The house position
// (layer-transform-tools.ts) is the same: list every field in one schema and
// let the handler own which ones a given call actually populates.
const stepResultItemSchema = {
  type: 'object',
  properties: {
    index: { type: 'number' },
    tool: { type: 'string' },
    ok: { type: 'boolean' },
    duration_ms: { type: 'number' },
    text: {
      type: 'string',
      description: "The first line of that step's own result text (return='summary').",
    },
    result: {
      type: 'object',
      description: "That step's full CallToolResult (return='full').",
    },
  },
  required: ['index', 'tool', 'ok'],
};

const sequenceOutputSchema = {
  type: 'object' as const,
  properties: {
    on_error: { type: 'string' },
    return: { type: 'string' },
    total_steps: { type: 'number' },
    ran_steps: {
      type: 'number',
      description: 'How many steps actually ran — excludes a step skipped by the time budget.',
    },
    failed_step: {
      type: ['object', 'null'],
      description:
        'The first failing step, or the step skipped by the overall time budget. Null when every step succeeded.',
      properties: {
        index: { type: 'number' },
        tool: { type: 'string' },
      },
    },
    cap_exceeded: { type: 'boolean' },
    rolled_back: { type: 'boolean' },
    rollback_reason: {
      type: 'string',
      description:
        'Set only when on_error="rollback" and rolled_back is false: history_evicted, undo_failed, cursor_moved_backward, or document_changed.',
      enum: ['history_evicted', 'undo_failed', 'cursor_moved_backward', 'document_changed'],
    },
    steps: {
      type: 'array',
      description:
        'One entry per step run — carries `text` in summary mode, `result` in full mode.',
      items: stepResultItemSchema,
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
 * a non-empty string currently registered (via `hasTool`, the live registry
 * — checked directly rather than against a fixed list, since which names are
 * dispatchable can differ between two running hosts), none is ps_sequence
 * itself, the step count is in bounds, and — only when on_error='rollback' —
 * no step names a HISTORY_UNSAFE_TOOLS entry. Throws a plain Error naming the
 * offending step; the caller turns that into an error result without running
 * anything.
 */
function validateSequenceArgs(
  rawArgs: Record<string, unknown>,
  hasTool: HasTool
): ParsedSequenceArgs {
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
    if (!hasTool(tool)) {
      throw new Error(`step ${i + 1}: "${tool}" is not a tool registered right now`);
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
        `step ${firstUnsafe + 1}: on_error="rollback" can't be honored because "${tool}" is one of the tools ps_sequence treats as unsafe for rollback (${HISTORY_UNSAFE_TOOLS_LIST}) — outside what the history cursor can undo. Use on_error="stop" or "continue", or drop that step.`
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

/**
 * Everything rollback needs to VERIFY it landed back where it started, read
 * from one ps_inspect(what='history') call: the cursor's position, the NAME
 * Photoshop reports at that position (position alone is not proof of
 * identity — see history_evicted below), the total state count, and the
 * active document's name (history is per-document).
 *
 * `documentName` is the best document-identity signal this read exposes —
 * ps_inspect(what='history') reports only doc.name (via getContextInfo()),
 * no document id, so two simultaneously open documents sharing a name could
 * in principle defeat this specific check.
 */
interface HistorySnapshot {
  index: number;
  stateName: string;
  totalStates: number;
  documentName: string | null;
}

/** Reads a HistorySnapshot out of a ps_inspect(what='history') result. Null on anything unusable. */
function extractHistorySnapshot(result: ToolResult): HistorySnapshot | null {
  if (result.isError) return null;
  const sc = result.structuredContent as
    | {
        currentIndex?: unknown;
        currentState?: unknown;
        totalStates?: unknown;
        context?: { document?: { name?: unknown } };
      }
    | undefined;
  const index = sc?.currentIndex;
  const stateName = sc?.currentState;
  const totalStates = sc?.totalStates;
  const documentName = sc?.context?.document?.name;
  if (
    typeof index !== 'number' ||
    !Number.isFinite(index) ||
    typeof stateName !== 'string' ||
    typeof totalStates !== 'number' ||
    !Number.isFinite(totalStates)
  ) {
    return null;
  }
  return {
    index,
    stateName,
    totalStates,
    documentName: typeof documentName === 'string' ? documentName : null,
  };
}

async function readHistorySnapshot(invokeTool: InvokeTool): Promise<HistorySnapshot | null> {
  const result = await invokeTool('ps_inspect', { what: 'history' });
  return extractHistorySnapshot(result);
}

/** Fixed set of reasons a verified rollback can fail to land — see performRollback. */
type RollbackReason =
  'history_evicted' | 'undo_failed' | 'cursor_moved_backward' | 'document_changed';

interface RollbackOutcome {
  ok: boolean;
  reason?: RollbackReason;
  message: string;
}

/**
 * Restores the history cursor captured before step one, then RE-READS and
 * COMPARES rather than trusting the undo call: `ps_undo` reports
 * `undone: true` unconditionally and clamps at index 0 rather than erroring
 * when Photoshop's finite history buffer has already evicted the target
 * state, so a bare "it returned success" is not evidence the document is
 * actually back where it started. Success requires the re-read index, state
 * name, AND active document to all match the capture; anything else reports
 * `ok: false` with one of the fixed reason tokens instead of a guess.
 */
async function performRollback(
  invokeTool: InvokeTool,
  captured: HistorySnapshot
): Promise<RollbackOutcome> {
  try {
    const before = await readHistorySnapshot(invokeTool);
    if (before === null) {
      return {
        ok: false,
        reason: 'undo_failed',
        message: 'could not read the document history to compute the rollback distance',
      };
    }
    if (before.documentName !== captured.documentName) {
      return {
        ok: false,
        reason: 'document_changed',
        message: `the active document changed since step 1 (captured "${captured.documentName}", now "${before.documentName}") — history is per-document, so nothing was undone`,
      };
    }
    const delta = before.index - captured.index;
    if (delta < 0) {
      return {
        ok: false,
        reason: 'cursor_moved_backward',
        message: `the history cursor is already earlier than the captured state (captured index ${captured.index}, now ${before.index}) — a step likely called undo or redo itself`,
      };
    }

    if (delta > 0) {
      const undone = await invokeTool('ps_undo', { steps: delta });
      if (undone.isError) {
        return {
          ok: false,
          reason: 'undo_failed',
          message: `ps_undo failed: ${firstTextLine(undone)}`,
        };
      }
    }

    const after = await readHistorySnapshot(invokeTool);
    if (after === null) {
      return {
        ok: false,
        reason: 'undo_failed',
        message: 'could not re-read the document history to verify the rollback',
      };
    }
    if (after.documentName !== captured.documentName) {
      return {
        ok: false,
        reason: 'document_changed',
        message: `the active document changed during rollback (captured "${captured.documentName}", now "${after.documentName}")`,
      };
    }
    if (after.index !== captured.index || after.stateName !== captured.stateName) {
      return {
        ok: false,
        reason: 'history_evicted',
        message:
          `the history state Photoshop reports at index ${after.index} ("${after.stateName}") does not match what was captured ` +
          `(index ${captured.index}, "${captured.stateName}") — Photoshop's history buffer is finite and likely evicted it ` +
          `(captured ${captured.totalStates} total states, now ${after.totalStates})`,
      };
    }

    return {
      ok: true,
      message:
        delta > 0
          ? `document verified restored to its state before step 1 ("${captured.stateName}", ${delta} step${delta === 1 ? '' : 's'} undone)`
          : `document verified already at its state before step 1 ("${captured.stateName}"); no edits to undo`,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: 'undo_failed', message: `rollback failed: ${msg}` };
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
  ranSteps: number;
  total: number;
  onError: OnError;
  failedStep: FailedStep | null;
  capExceeded: boolean;
  rolledBack: boolean;
  rollbackMessage: string;
}): string {
  const { ranSteps, total, onError, failedStep, capExceeded, rolledBack, rollbackMessage } = input;

  if (capExceeded && failedStep) {
    const base = `Sequence exceeded its overall time budget (${SEQUENCE_OVERALL_TIMEOUT_MS}ms) before step ${failedStep.index + 1} (${failedStep.tool}) could run; stopped after ${ranSteps}/${total} step(s).`;
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

  return `Sequence stopped at step ${failedStep.index + 1} (${failedStep.tool}) after a failure; ${ranSteps}/${total} step(s) ran.`;
}

async function runSequence(
  invokeTool: InvokeTool,
  hasTool: HasTool,
  rawArgs: Record<string, unknown>,
  now: () => number
): Promise<ToolResult> {
  let parsed: ParsedSequenceArgs;
  try {
    parsed = validateSequenceArgs(rawArgs, hasTool);
  } catch (error) {
    return toolErrorResult('Error validating sequence', error);
  }
  const { steps, onError, returnMode } = parsed;

  let capturedHistory: HistorySnapshot | null = null;
  if (onError === 'rollback') {
    let captured: HistorySnapshot | null;
    try {
      captured = await readHistorySnapshot(invokeTool);
    } catch (error) {
      return toolErrorResult('Error capturing history state before the sequence', error);
    }
    if (captured === null) {
      return toolErrorResult(
        'Error capturing history state before the sequence',
        new Error('ps_inspect(what="history") did not return a usable history snapshot')
      );
    }
    capturedHistory = captured;
  }

  const startedAt = now();
  const entries: StepEntry[] = [];
  let failedStep: FailedStep | null = null;
  let capExceeded = false;
  let rolledBack = false;
  let rollbackReason: RollbackReason | undefined;
  let rollbackMessage = '';

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    // Checked between steps only, so it never preempts a step already running
    // and never leaves one killed mid-script. Stopping here is safe in a way it
    // was not when this call carried a deadline of its own: the rollback below
    // dispatches through invokeTool, and with no outer deadline to inherit each
    // of its probes gets its own full budget however long the sequence has run.
    if (now() - startedAt > SEQUENCE_OVERALL_TIMEOUT_MS) {
      capExceeded = true;
      if (failedStep === null) failedStep = { index: i, tool: step.tool };
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
        const r = await performRollback(invokeTool, capturedHistory as HistorySnapshot);
        rolledBack = r.ok;
        rollbackReason = r.reason;
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
        const r = await performRollback(invokeTool, capturedHistory as HistorySnapshot);
        rolledBack = r.ok;
        rollbackReason = r.reason;
        rollbackMessage = r.message;
        break;
      }
      if (onError === 'stop') {
        break;
      }
      // continue: fall through and run the next step.
    }
  }

  // The overall-cap branch pushes one synthetic "never ran" entry as the
  // LAST entry in `entries` — it must not be treated as "the last step" for
  // either purpose below: it never ran, so it never had a preview to keep,
  // and it isn't the result callers actually want back. `lastRealIndex`
  // points at the last step that actually executed; -1 when the cap fired
  // before any step ran at all.
  const lastRealIndex = capExceeded ? entries.length - 2 : entries.length - 1;
  const stripped = entries.map((e, idx) =>
    idx === lastRealIndex ? e : { ...e, result: stripImages(e.result) }
  );
  // Excludes the synthetic never-run entry the overall-cap branch pushes —
  // that step never actually ran, so it must not count as one that did.
  const ranSteps = capExceeded ? entries.length - 1 : entries.length;
  const anyFailure = failedStep !== null;
  const isError = capExceeded || (anyFailure && onError !== 'continue');

  const message = buildMessage({
    ranSteps,
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
    ran_steps: ranSteps,
    failed_step: failedStep,
    cap_exceeded: capExceeded,
    rolled_back: rolledBack,
    ...(rollbackReason ? { rollback_reason: rollbackReason } : {}),
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
          final: lastRealIndex >= 0 ? stripped[lastRealIndex].result : undefined,
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
  hasTool: HasTool,
  opts: CreateSequenceToolsOptions = {}
): ToolDefinition[] {
  const { now = Date.now } = opts;
  return [
    {
      tool: {
        name: SEQUENCE_TOOL_NAME,
        description:
          "Run an ordered list of tool calls against the current document in ONE round trip. WHEN TO REACH FOR THIS: several dependent steps you already know you want (e.g. select → adjust → merge, or a repeated resize/export pass) where you do not need to look at the result between them — each step is dispatched the same way an ordinary call is and sees the document exactly as the previous step left it. Not for exploratory work: if the next step depends on inspecting this one first, call the tools individually instead. Every step must name a tool that already exists in this edition (ps_sequence cannot call itself). An inline preview (image content) returned by a step is dropped unless that step is the LAST one in the sequence, since previews are most of a result's bytes and the point of batching calls is to stop paying for them on every intermediate step. Each step keeps its own time limit, exactly as it would if you called it on its own. The sequence's overall budget only decides whether to START another step, so it never cuts one off mid-run. Budget for a call finishing after that ceiling: by the remaining runtime of the step already in flight, plus the undo and its checks if you asked for undo-on-failure. With return='full', every step's complete result (not just the last one's) lands in the logged call payload.",
        inputSchema: sequenceSchema,
        outputSchema: sequenceOutputSchema,
        annotations: {
          title: 'Run a Tool Sequence',
          destructiveHint: true,
          idempotentHint: false,
        },
      },
      handler: async (args) => runSequence(invokeTool, hasTool, args, now),
    },
  ];
}
