/**
 * Asking the person to approve something during a tool call, through MCP elicitation.
 *
 * A tool that spends something outside Editmamei (Relight spends Adobe Firefly generative
 * credits) asks first. The question goes to the client's own interface and the answer comes
 * back without passing through the model, so the model can't approve on the person's behalf.
 *
 * Two protocol revisions, two mechanisms:
 *   - 2025: the server sends `elicitation/create` while the call is open and waits.
 *   - 2026-07-28: the call returns `input_required` with the question; the client asks, then
 *     retries the same call carrying the answer in `inputResponses`.
 *
 * The server sets up one context per tools/call (runWithCallApproval), bound to the tool the
 * client called. Only that tool may ask, and only once per call: a tool reached through another
 * (ps_sequence, a kernel invokeTool) gets 'nested', so a single answer can never cover a second
 * render or a retried batch of other edits. With no context at all (a direct handler call, a
 * script) the answer is 'unsupported'.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import {
  SdkErrorCode,
  inputRequired,
  inputResponse,
  type ClientCapabilities,
  type ElicitResult,
  type InputRequiredResult,
  type RequestId,
} from '@modelcontextprotocol/server';
import { clientSupportsForm } from './consent.js';

/** Long enough for a person to come back to the window, short enough not to linger. */
export const APPROVAL_TIMEOUT_MS = 5 * 60_000;

export interface ApprovalRequest {
  /** The tool asking. Must be the tool the client called. */
  tool: string;
  /** Stable id for this question within the tool, e.g. 'adobe_credits'. */
  key: string;
  /** What the person reads. */
  message: string;
  /** Label of the checkbox the person ticks to approve. */
  checkboxTitle: string;
}

export type ApprovalOutcome =
  /** The person ticked the box and accepted. */
  | 'approved'
  /** Declined, cancelled, left the box unticked, timed out, or the call was cancelled. */
  | 'declined'
  /** This client can't show a form, or there is no call context at all. */
  | 'unsupported'
  /** 2026-07-28: the question went out with the result; the client will retry the call. */
  | 'pending'
  /** Reached through another tool, or asked twice in one call: refused without asking. */
  | 'nested'
  /** The prompt failed for another reason. */
  | 'failed';

export type ElicitForm = {
  message: string;
  requestedSchema: {
    type: 'object';
    properties: Record<string, { type: 'boolean'; title: string; default: boolean }>;
    required: string[];
  };
};

/** Everything requestApproval needs from the connection that carries this call. */
export interface CallApprovalChannel {
  /** Whether the client declared that it can show a form. */
  supportsForm: boolean;
  /** 2025: ask now and wait. Absent on a 2026-07-28 connection. */
  elicit?: (params: ElicitForm, options: { timeout: number }) => Promise<ElicitResult>;
  /** 2026-07-28: the answers the client carried on this retry, keyed as we asked. */
  inputResponses?: Record<string, unknown>;
  /** 2026-07-28 only: this call may return input_required. */
  multiRoundTrip?: boolean;
  /** Aborts when the client cancels the call: a late yes must not render. */
  signal?: AbortSignal;
}

/** What approvalChannelFor reads off one tools/call request. */
export interface ApprovalChannelInput {
  /** 2026-07-28: the request's `_meta` envelope. */
  envelope?: Record<string, unknown>;
  /** 2026-07-28: answers carried by a retried request. */
  inputResponses?: Record<string, unknown>;
  /** 2025: what the client declared at initialize. */
  clientCapabilities?: ClientCapabilities;
  /** 2025: the SDK's elicitInput. */
  elicitInput: (
    params: ElicitForm,
    options: { timeout: number; relatedRequestId: RequestId; signal?: AbortSignal }
  ) => Promise<ElicitResult>;
  requestId: RequestId;
  signal?: AbortSignal;
}

/** The 2026-07-28 envelope key that carries the client's capabilities. */
const CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities';

/** Build the approval channel for one tools/call, on either protocol revision. */
export function approvalChannelFor(
  era: 'legacy' | 'modern',
  input: ApprovalChannelInput
): CallApprovalChannel {
  if (era === 'modern') {
    const caps = input.envelope?.[CAPABILITIES_KEY] as ClientCapabilities | undefined;
    return {
      supportsForm: clientSupportsForm(caps?.elicitation),
      multiRoundTrip: true,
      inputResponses: input.inputResponses,
      signal: input.signal,
    };
  }
  return {
    supportsForm: clientSupportsForm(input.clientCapabilities?.elicitation),
    elicit: (params, options) =>
      input.elicitInput(params, {
        ...options,
        relatedRequestId: input.requestId,
        signal: input.signal,
      }),
    signal: input.signal,
  };
}

interface CallApprovalState {
  channel: CallApprovalChannel;
  /** The tool the client called. */
  tool: string;
  /** Set once a question has been asked in this call. */
  asked: boolean;
  /** Set when a 2026-07-28 question has to go back with the result. */
  pending?: InputRequiredResult;
}

const STORE_KEY = Symbol.for('editmamei.callApprovalStore.v1');
const processGlobals = globalThis as unknown as Record<
  symbol,
  AsyncLocalStorage<CallApprovalState> | undefined
>;
const storage = (processGlobals[STORE_KEY] ??= new AsyncLocalStorage<CallApprovalState>());

/**
 * Run one tool call with an approval channel bound to `tool`. Returns the handler's result, or
 * the input_required result when a 2026-07-28 question has to go back to the client first.
 */
export async function runWithCallApproval<T>(
  channel: CallApprovalChannel,
  tool: string,
  fn: () => Promise<T>
): Promise<{ result: T; inputRequired?: InputRequiredResult }> {
  const state: CallApprovalState = { channel, tool, asked: false };
  const result = await storage.run(state, fn);
  return { result, inputRequired: state.pending };
}

function form(req: ApprovalRequest): ElicitForm {
  return {
    message: req.message,
    requestedSchema: {
      type: 'object',
      properties: { approve: { type: 'boolean', title: req.checkboxTitle, default: false } },
      required: ['approve'],
    },
  };
}

/** Accept counts only with the box ticked; anything else is a no. */
function readAnswer(action: string, content: Record<string, unknown> | undefined): ApprovalOutcome {
  return action === 'accept' && content?.approve === true ? 'approved' : 'declined';
}

/** Ask the person in this call's client. Never throws. */
export async function requestApproval(req: ApprovalRequest): Promise<ApprovalOutcome> {
  const state = storage.getStore();
  if (!state) return 'unsupported';
  if (state.tool !== req.tool || state.asked) return 'nested';
  state.asked = true;
  const { channel } = state;
  if (!channel.supportsForm) return 'unsupported';

  if (channel.multiRoundTrip) {
    const answer = inputResponse(channel.inputResponses, req.key);
    if (answer.kind === 'elicit') return readAnswer(answer.action, answer.content);
    state.pending = inputRequired({
      inputRequests: { [req.key]: inputRequired.elicit(form(req)) },
    });
    return 'pending';
  }

  if (!channel.elicit) return 'unsupported';
  try {
    const answer = await channel.elicit(form(req), { timeout: APPROVAL_TIMEOUT_MS });
    // The client gave up on the call while the person was deciding: nobody is waiting for
    // the result, so a late yes doesn't render.
    if (channel.signal?.aborted) return 'declined';
    return readAnswer(answer.action, answer.content as Record<string, unknown> | undefined);
  } catch (err) {
    if (channel.signal?.aborted) return 'declined';
    return (err as { code?: unknown } | null)?.code === SdkErrorCode.RequestTimeout
      ? 'declined'
      : 'failed';
  }
}
