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
 * The server sets up one context per tools/call (runWithCallApproval); a handler reads it through
 * requestApproval. With no context (a nested kernel call, a test) the answer is 'unsupported'.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import {
  SdkErrorCode,
  inputRequired,
  inputResponse,
  type ElicitResult,
  type InputRequiredResult,
} from '@modelcontextprotocol/server';

/** Long enough for a person to come back to the window, short enough not to linger. */
export const APPROVAL_TIMEOUT_MS = 5 * 60_000;

export interface ApprovalRequest {
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
  /** Declined, cancelled, left the box unticked, or the prompt timed out. */
  | 'declined'
  /** This client can't show a form, or the call has no approval channel. */
  | 'unsupported'
  /** 2026-07-28: the question went out with the result; the client will retry the call. */
  | 'pending'
  /** The prompt failed for another reason. */
  | 'failed';

type ElicitForm = {
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
  /** 2026-07-28 only: present when this call may return input_required. */
  multiRoundTrip?: boolean;
}

interface CallApprovalState {
  channel: CallApprovalChannel;
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
 * Run one tool call with an approval channel. Returns the handler's result, or the
 * input_required result when a 2026-07-28 question has to go back to the client first.
 */
export async function runWithCallApproval<T>(
  channel: CallApprovalChannel,
  fn: () => Promise<T>
): Promise<{ result: T; inputRequired?: InputRequiredResult }> {
  const state: CallApprovalState = { channel };
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
  if (!state || !state.channel.supportsForm) return 'unsupported';
  const { channel } = state;

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
    return readAnswer(answer.action, answer.content as Record<string, unknown> | undefined);
  } catch (err) {
    return (err as { code?: unknown } | null)?.code === SdkErrorCode.RequestTimeout
      ? 'declined'
      : 'failed';
  }
}
