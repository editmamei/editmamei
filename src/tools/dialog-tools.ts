/**
 * ps_dialog — see and clear a modal dialog that is blocking Photoshop.
 *
 * When Photoshop raises a modal, the scripting transport blocks until it is
 * dismissed. Every other tool in this product travels over that transport, so
 * every other tool is dead until someone clears the dialog. This one is
 * reachable because it does not use the transport at all: it drives a sibling
 * process that reads the Photoshop UI directly.
 *
 * It is deliberately CALLER-DIRECTED. The tool reports what the dialog says and
 * which buttons exist; the decision of which button to press is left to whoever
 * can see the situation. Nothing here auto-clicks, because the safe answer
 * genuinely depends on context — "Continue" vs "Stop" on a failed action step
 * has no fixed correct answer, and "Don't Save" is only correct when someone
 * meant it.
 */
import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import type { SnippetClient } from '../api/snippet-client.js';
import {
  GoDialogProbe,
  describeReport,
  resolvePhotoshopPids,
  type DialogProbe,
  type DialogReport,
} from '../platform/dialog-probe.js';

const dialogSchema = {
  type: 'object' as const,
  properties: {
    action: {
      type: 'string',
      enum: ['inspect', 'click'],
      description:
        "'inspect' reports the dialog currently blocking Photoshop, if any. 'click' presses one of its buttons.",
      default: 'inspect',
    },
    token: {
      type: 'string',
      description:
        "Required for action='click'. The `token` from the inspect call that showed you this dialog. The click is refused if the dialog on screen no longer matches it, so a dialog that changed underneath you cannot be clicked by accident.",
    },
    button_id: {
      type: 'number',
      description:
        "Required for action='click'. The `id` of the button to press, taken from the same inspect call's `buttons` array. Control ids are assigned per Photoshop session and are meaningless from any other call — never reuse or hardcode one.",
    },
  },
};

/** Injectable probe seam — production uses the Go-backed one; tests pass a fake. */
export interface DialogToolDeps {
  probe?: DialogProbe;
  pids?: () => Promise<number[]>;
}

function toResult(report: DialogReport): ToolResult {
  const payload = {
    ...report,
    summary: describeReport(report),
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

export function createDialogTools(
  _connection: PhotoshopConnection,
  _snippetClient: SnippetClient,
  deps: DialogToolDeps = {}
): ToolDefinition[] {
  const probe = deps.probe ?? new GoDialogProbe();
  const pidsOf = deps.pids ?? resolvePhotoshopPids;

  return [
    {
      tool: {
        name: 'ps_dialog',
        description:
          'See and clear a modal dialog that is blocking Photoshop. Call this when another tool fails with a timeout, or reports that Photoshop is busy or unreachable — a dialog waiting for a click is a common cause, and it makes EVERY other tool fail until it is dismissed. ' +
          "action='inspect' returns the dialog's title, message and buttons, plus a `stakes` classification. " +
          "action='click' presses one button by id, and is refused unless the dialog still matches the `token` you inspected. " +
          'Read `stakes` before clicking: "running" means an operation is in progress and the only button cancels it; "data_loss" means a button on this dialog discards or overwrites work, so ASK THE USER which to press; "informational" means there is only one button and nothing to decide; "decision" means the choice depends on what the user wanted. Windows only for now — reports "unsupported" elsewhere.',
        inputSchema: dialogSchema,
        outputSchema: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            summary: { type: 'string' },
            token: { type: 'string' },
            title: { type: 'string' },
            text: { type: 'string' },
            stakes: { type: 'string' },
            buttons: { type: 'array' },
          },
        },
        annotations: {
          title: 'Inspect or clear a blocking Photoshop dialog',
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      handler: async (args: Record<string, unknown>): Promise<ToolResult> => {
        const action = (args.action as string | undefined) ?? 'inspect';
        const pids = await pidsOf();
        if (pids.length === 0) {
          return toResult({ status: 'unknown', reason: 'photoshop-not-running' });
        }

        if (action === 'inspect') {
          return toResult(await probe.probe(pids));
        }

        const token = args.token;
        const buttonId = args.button_id;
        if (typeof token !== 'string' || token === '') {
          throw new Error(
            "ps_dialog action='click' requires the `token` from a preceding inspect call. " +
              'Call ps_dialog with action=inspect first, then click using the token and button id it returns.'
          );
        }
        if (typeof buttonId !== 'number' || !Number.isInteger(buttonId)) {
          throw new Error(
            "ps_dialog action='click' requires `button_id` — an integer `id` from the `buttons` array of the inspect call that produced this token."
          );
        }
        return toResult(await probe.click(pids, token, buttonId));
      },
    },
  ];
}
