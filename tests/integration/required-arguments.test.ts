import { describe, it, expect } from 'vitest';
import { EditmameiServer } from '@editmamei/core/server.ts';
import { ToolRegistry } from '@editmamei/core/tool-registry.ts';
import { useSessionLogSandbox } from '../fixtures/session-log-sandbox.ts';

useSessionLogSandbox();

interface RegisteredTool {
  name: string;
  inputSchema: { required?: string[]; properties?: Record<string, { default?: unknown }> };
}

interface Internals {
  toolRegistry: {
    list(): RegisteredTool[];
    execute(
      name: string,
      args: Record<string, unknown>
    ): Promise<{ isError?: boolean; content: Array<{ type: string; text?: string }> }>;
  };
}

describe('required arguments', () => {
  it('every tool refuses a call missing a required argument, and names it', async () => {
    const { toolRegistry } = new EditmameiServer() as unknown as Internals;
    const tools = toolRegistry.list().filter((t) => {
      const props = t.inputSchema.properties ?? {};
      return (t.inputSchema.required ?? []).some((key) => props[key]?.default === undefined);
    });
    expect(tools.length).toBeGreaterThan(30);

    for (const tool of tools) {
      const props = tool.inputSchema.properties ?? {};
      const first = (tool.inputSchema.required ?? []).find(
        (key) => props[key]?.default === undefined
      );
      const result = await toolRegistry.execute(tool.name, {});
      expect(result.isError, tool.name).toBe(true);
      expect(result.content[0]?.text, tool.name).toBe(`Missing required argument: ${first}`);
    }
  });

  it('does not run the handler, and treats null as missing', async () => {
    const registry = new ToolRegistry();
    let ran = false;
    registry.register('t', {
      tool: {
        name: 't',
        inputSchema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
      },
      handler: async () => {
        ran = true;
        return { content: [] };
      },
    });
    const result = await registry.execute('t', { a: null });
    expect(result.isError).toBe(true);
    expect(ran).toBe(false);
  });

  it('lets a required argument with a schema default through to the handler', async () => {
    const registry = new ToolRegistry();
    registry.register('t', {
      tool: {
        name: 't',
        inputSchema: {
          type: 'object',
          properties: { a: { type: 'string', default: 'x' } },
          required: ['a'],
        },
      },
      handler: async () => ({ content: [] }),
    });
    expect((await registry.execute('t', {})).isError).toBeUndefined();
  });

  it('reports a refused call to the observer as a failure', async () => {
    const seen: Array<{ success: boolean; error?: string }> = [];
    const registry = new ToolRegistry({ onCall: (entry) => void seen.push(entry) });
    registry.register('t', {
      tool: { name: 't', inputSchema: { type: 'object', required: ['a'] } },
      handler: async () => ({ content: [] }),
    });
    await registry.execute('t', {});
    expect(seen[0]?.success).toBe(false);
    expect(seen[0]?.error).toBe('Missing required argument: a');
  });
});
