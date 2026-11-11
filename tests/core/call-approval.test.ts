import { describe, it, expect, vi } from 'vitest';
import {
  approvalChannelFor,
  requestApproval,
  runWithCallApproval,
  type ApprovalChannelInput,
} from '@editmamei/core/call-approval.ts';

const CAPS = 'io.modelcontextprotocol/clientCapabilities';

const input = (over: Partial<ApprovalChannelInput> = {}): ApprovalChannelInput => ({
  elicitInput: vi.fn(async () => ({ action: 'accept' as const, content: { approve: true } })),
  requestId: 7,
  ...over,
});

const ask = (tool = 'ps_relight') =>
  requestApproval({ tool, key: 'k', message: 'Spend?', checkboxTitle: 'Yes' });

describe('approvalChannelFor', () => {
  it('2026-07-28: reads form support from the envelope and carries the answers', () => {
    const answers = { k: { action: 'accept', content: { approve: true } } };
    const channel = approvalChannelFor(
      'modern',
      input({ envelope: { [CAPS]: { elicitation: { form: {} } } }, inputResponses: answers })
    );
    expect(channel.supportsForm).toBe(true);
    expect(channel.multiRoundTrip).toBe(true);
    expect(channel.inputResponses).toBe(answers);
    expect(channel.elicit).toBeUndefined();
  });

  it('2026-07-28: no form support when the envelope declares no elicitation', () => {
    expect(approvalChannelFor('modern', input({ envelope: { [CAPS]: {} } })).supportsForm).toBe(
      false
    );
    expect(approvalChannelFor('modern', input()).supportsForm).toBe(false);
  });

  it('2025: reads initialize capabilities and ties the prompt to the call', async () => {
    const elicitInput = vi.fn(async () => ({ action: 'decline' as const }));
    const signal = new AbortController().signal;
    const channel = approvalChannelFor(
      'legacy',
      input({ clientCapabilities: { elicitation: {} }, elicitInput, signal })
    );
    expect(channel.supportsForm).toBe(true);
    expect(channel.multiRoundTrip).toBeUndefined();
    await channel.elicit!(
      { message: 'm', requestedSchema: { type: 'object', properties: {}, required: [] } },
      { timeout: 1000 }
    );
    expect(elicitInput).toHaveBeenCalledWith(expect.anything(), {
      timeout: 1000,
      relatedRequestId: 7,
      signal,
    });
  });

  it('2025: a URL-only client cannot show the form', () => {
    const channel = approvalChannelFor(
      'legacy',
      input({ clientCapabilities: { elicitation: { url: {} } } })
    );
    expect(channel.supportsForm).toBe(false);
  });
});

describe('requestApproval', () => {
  const formChannel = approvalChannelFor(
    'legacy',
    input({ clientCapabilities: { elicitation: {} } })
  );

  it('is unsupported outside any call', async () => {
    expect(await ask()).toBe('unsupported');
  });

  it('asks once per call: a second question in the same call is refused', async () => {
    const { result } = await runWithCallApproval(formChannel, 'ps_relight', async () => [
      await ask(),
      await ask(),
    ]);
    expect(result).toEqual(['approved', 'nested']);
  });

  it('refuses a tool the client did not call', async () => {
    const { result } = await runWithCallApproval(formChannel, 'ps_sequence', () => ask());
    expect(result).toBe('nested');
  });

  it('does not leak between calls', async () => {
    const first = await runWithCallApproval(formChannel, 'ps_relight', () => ask());
    const second = await runWithCallApproval(formChannel, 'ps_relight', () => ask());
    expect([first.result, second.result]).toEqual(['approved', 'approved']);
  });
});

describe('ps_relight call budget', () => {
  it('covers the whole approval wait plus the render', async () => {
    const { APPROVAL_TIMEOUT_MS } = await import('@editmamei/core/call-approval.ts');
    const { RELIGHT_CALL_BUDGET_MS, RELIGHT_TIMEOUT_MS } =
      await import('@editmamei/utils/operation-timeouts.ts');
    expect(RELIGHT_CALL_BUDGET_MS).toBeGreaterThanOrEqual(APPROVAL_TIMEOUT_MS + RELIGHT_TIMEOUT_MS);
  });
});
