/**
 * The approval channel through a real tools/call, on both protocol revisions: what the server
 * reads off the connection decides whether the person is asked, so this runs a real client.
 */

import { describe, it, expect, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { Transport } from '@modelcontextprotocol/server';
import { EditmameiServer } from '@editmamei/core/server.ts';
import { requestApproval } from '@editmamei/core/call-approval.ts';
import type { ToolDefinition } from '@editmamei/core/tool-registry.ts';
import { useSessionLogSandbox } from '../fixtures/session-log-sandbox.ts';

useSessionLogSandbox();

type Internals = {
  serve(wire: Transport): void;
  toolRegistry: { register(name: string, def: ToolDefinition): void };
  telemetry: { recordClientConnected(info: unknown): void; shutdown(): Promise<void> };
};

/** A server with one extra tool that asks for approval and reports the outcome. */
function serverWithProbe() {
  const server = new EditmameiServer() as unknown as Internals;
  server.telemetry.recordClientConnected = vi.fn();
  server.telemetry.shutdown = vi.fn(async () => undefined);
  server.toolRegistry.register('ps_probe_approval', {
    tool: {
      name: 'ps_probe_approval',
      description: 'Test probe: asks for approval.',
      inputSchema: { type: 'object' },
    },
    handler: async () => {
      const outcome = await requestApproval({
        tool: 'ps_probe_approval',
        key: 'probe',
        message: 'Approve?',
        checkboxTitle: 'Yes',
      });
      return { content: [{ type: 'text', text: outcome }], structuredContent: { outcome } };
    },
  });
  return server;
}

async function connect(
  options: ConstructorParameters<typeof Client>[1],
  answer?: { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, boolean> }
) {
  const server = serverWithProbe();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  server.serve(serverTransport);
  const client = new Client({ name: 'approval-test', version: '1.0.0' }, options);
  const asked: unknown[] = [];
  if (answer) {
    client.setRequestHandler('elicitation/create', async (request) => {
      asked.push(request.params);
      return answer;
    });
  }
  await client.connect(clientTransport);
  return { client, asked };
}

const outcomeOf = (result: { structuredContent?: unknown }) =>
  (result.structuredContent as { outcome?: string } | undefined)?.outcome;

describe('approval through a real tools/call', () => {
  it('2025: asks while the call is open and reads the answer', async () => {
    const { client, asked } = await connect(
      { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: 'legacy' } },
      { action: 'accept', content: { approve: true } }
    );
    const result = await client.callTool({ name: 'ps_probe_approval', arguments: {} });
    expect(asked).toHaveLength(1);
    expect(outcomeOf(result)).toBe('approved');
    await client.close();
  });

  it('2025: a client that declared no elicitation is never asked', async () => {
    const { client } = await connect({ versionNegotiation: { mode: 'legacy' } });
    const result = await client.callTool({ name: 'ps_probe_approval', arguments: {} });
    expect(outcomeOf(result)).toBe('unsupported');
    await client.close();
  });

  it('2026-07-28: returns input_required, and the retry carries the answer', async () => {
    const { client, asked } = await connect(
      {
        capabilities: { elicitation: { form: {} } },
        versionNegotiation: { mode: { pin: '2026-07-28' } },
      },
      { action: 'decline' }
    );
    const result = await client.callTool({ name: 'ps_probe_approval', arguments: {} });
    expect(asked).toHaveLength(1);
    expect(outcomeOf(result)).toBe('declined');
    await client.close();
  });

  it('2026-07-28: a client that declared no elicitation is never asked', async () => {
    const { client } = await connect({ versionNegotiation: { mode: { pin: '2026-07-28' } } });
    const result = await client.callTool({ name: 'ps_probe_approval', arguments: {} });
    expect(outcomeOf(result)).toBe('unsupported');
    await client.close();
  });
});
