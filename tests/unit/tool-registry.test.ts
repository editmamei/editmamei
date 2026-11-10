import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry, type ToolDefinition } from '@editmamei/core/tool-registry.ts';
import {
  budgetContextFor,
  currentToolBudget,
  runWithToolBudget,
} from '@editmamei/utils/tool-budget-context.ts';

function dummyTool(name: string, response = 'ok'): ToolDefinition {
  return {
    tool: {
      name,
      description: `${name} description`,
      inputSchema: { type: 'object', properties: {} },
    },
    handler: async () => ({
      content: [{ type: 'text', text: response }],
    }),
  };
}

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it('starts empty', () => {
    expect(registry.count()).toBe(0);
    expect(registry.list()).toEqual([]);
  });

  it('registers and retrieves tools by name', () => {
    const def = dummyTool('alpha');
    registry.register('alpha', def);

    expect(registry.get('alpha')).toBe(def);
    expect(registry.count()).toBe(1);
    expect(registry.list().map((t) => t.name)).toEqual(['alpha']);
  });

  it('overwrites when registering a duplicate name', () => {
    registry.register('alpha', dummyTool('alpha', 'first'));
    registry.register('alpha', dummyTool('alpha', 'second'));
    expect(registry.count()).toBe(1);
  });

  it('unregister removes exactly the named tool, leaving the rest', () => {
    registry.registerAll([dummyTool('a'), dummyTool('b')]);
    registry.unregister('a');
    expect(registry.get('a')).toBeUndefined();
    expect(registry.get('b')).toBeDefined();
    expect(registry.count()).toBe(1);
  });

  it('unregister is a no-op for a name that was never registered', () => {
    registry.register('alpha', dummyTool('alpha'));
    registry.unregister('missing');
    expect(registry.count()).toBe(1);
  });

  it('registerAll batch-registers an array of definitions', () => {
    registry.registerAll([dummyTool('a'), dummyTool('b'), dummyTool('c')]);
    expect(registry.count()).toBe(3);
    expect(registry.list().map((t) => t.name)).toEqual(['a', 'b', 'c']);
  });

  it('execute invokes the handler and returns the result', async () => {
    registry.register('alpha', dummyTool('alpha', 'hello'));
    const result = await registry.execute('alpha', {});
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'hello' });
  });

  it('execute throws when the tool is missing', async () => {
    await expect(registry.execute('missing', {})).rejects.toThrow(
      /No tool is registered under the name 'missing'/
    );
  });

  it('execute propagates handler errors without double-wrapping', async () => {
    registry.register('boom', {
      tool: {
        name: 'boom',
        description: 'd',
        inputSchema: { type: 'object', properties: {} },
      },
      handler: async () => {
        throw new Error('handler failed');
      },
    });
    await expect(registry.execute('boom', {})).rejects.toThrow(/handler failed/);
  });
});

describe('ToolRegistry decorate', () => {
  it('sees each result before it is returned', async () => {
    const registry = new ToolRegistry({
      decorate: (tool, result) => ({
        ...result,
        content: [{ type: 'text', text: `${tool}: noted` }],
      }),
    });
    registry.register('alpha', dummyTool('alpha'));
    const result = await registry.execute('alpha', {});
    expect(result.content[0]).toMatchObject({ text: 'alpha: noted' });
  });

  it('a decorate that throws leaves the result as the handler made it', async () => {
    const registry = new ToolRegistry({
      decorate: () => {
        throw new Error('no late results here');
      },
    });
    registry.register('alpha', dummyTool('alpha', 'hello'));
    const result = await registry.execute('alpha', {});
    expect(result.content[0]).toMatchObject({ text: 'hello' });
    expect(result.isError).toBeUndefined();
  });
});

describe('budgetContextFor waitDeadline', () => {
  it("an inner call inherits the outer call's longer wait, and keeps its own reply deadline", async () => {
    const now = 1_000_000;
    const outer = {
      toolName: 'gimp_sequence',
      budgetMs: 180_000,
      deadline: now + 180_000,
      waitDeadline: now + 900_000,
    };
    const inner = await runWithToolBudget(outer, async () =>
      budgetContextFor('gimp_resize_image', 45_000, now)
    );
    expect(inner).toEqual({
      toolName: 'gimp_resize_image',
      budgetMs: 45_000,
      deadline: now + 45_000,
      waitDeadline: now + 900_000,
    });
  });

  it('is absent when no outer call set one', () => {
    expect(currentToolBudget()).toBeUndefined();
    expect(budgetContextFor('gimp_resize_image', 45_000, 0)).not.toHaveProperty('waitDeadline');
  });
});

describe('ToolRegistry.onCall observer', () => {
  it('fires after a successful handler with tool name, args, success=true, duration', async () => {
    const observed: Array<Record<string, unknown>> = [];
    const reg = new ToolRegistry({
      onCall: (entry) => {
        observed.push(entry);
      },
    });
    reg.register('alpha', dummyTool('alpha'));

    await reg.execute('alpha', { foo: 'bar' });

    // Wait one microtask for the fire-and-forget observer
    await new Promise((r) => setImmediate(r));

    expect(observed).toHaveLength(1);
    expect(observed[0].tool).toBe('alpha');
    expect(observed[0].args).toEqual({ foo: 'bar' });
    expect(observed[0].success).toBe(true);
    expect(observed[0].duration_ms).toBeGreaterThanOrEqual(0);
    expect(observed[0].error).toBeUndefined();
  });

  it('fires with success=false + error when the handler throws', async () => {
    const observed: Array<Record<string, unknown>> = [];
    const reg = new ToolRegistry({
      onCall: (entry) => {
        observed.push(entry);
      },
    });
    reg.register('boom', {
      tool: { name: 'boom', description: 'd', inputSchema: { type: 'object', properties: {} } },
      handler: async () => {
        throw new Error('boom');
      },
    });

    await expect(reg.execute('boom', {})).rejects.toThrow(/boom/);
    await new Promise((r) => setImmediate(r));

    expect(observed).toHaveLength(1);
    expect(observed[0].success).toBe(false);
    expect(observed[0].error).toBe('boom');
  });

  it('fires with success=false when the handler returns isError', async () => {
    const observed: Array<Record<string, unknown>> = [];
    const reg = new ToolRegistry({
      onCall: (entry) => {
        observed.push(entry);
      },
    });
    reg.register('soft-fail', {
      tool: {
        name: 'soft-fail',
        description: 'd',
        inputSchema: { type: 'object', properties: {} },
      },
      handler: async () => ({
        content: [{ type: 'text', text: 'something went wrong' }],
        isError: true,
      }),
    });

    await reg.execute('soft-fail', {});
    await new Promise((r) => setImmediate(r));

    expect(observed[0].success).toBe(false);
    expect(observed[0].error).toBe('something went wrong');
  });

  it('fires with the result object on a successful handler call', async () => {
    const observed: Array<Record<string, unknown>> = [];
    const reg = new ToolRegistry({
      onCall: (entry) => {
        observed.push(entry);
      },
    });
    reg.register('alpha', dummyTool('alpha', 'payload'));

    await reg.execute('alpha', {});
    await new Promise((r) => setImmediate(r));

    expect(observed[0].result).toBeDefined();
    expect(observed[0].result).toMatchObject({
      content: [{ type: 'text', text: 'payload' }],
    });
  });

  it('fires with result undefined when the handler throws', async () => {
    const observed: Array<Record<string, unknown>> = [];
    const reg = new ToolRegistry({
      onCall: (entry) => {
        observed.push(entry);
      },
    });
    reg.register('boom', {
      tool: { name: 'boom', description: 'd', inputSchema: { type: 'object', properties: {} } },
      handler: async () => {
        throw new Error('boom');
      },
    });

    await expect(reg.execute('boom', {})).rejects.toThrow(/boom/);
    await new Promise((r) => setImmediate(r));

    expect(observed[0].result).toBeUndefined();
  });

  it('observer failures do NOT break the tool call', async () => {
    const reg = new ToolRegistry({
      onCall: () => {
        throw new Error('observer crashed');
      },
    });
    reg.register('alpha', dummyTool('alpha', 'still ok'));

    const result = await reg.execute('alpha', {});
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'still ok' });
  });
});
