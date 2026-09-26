import { describe, it, expect } from 'vitest';
import { createGimpFilterTools } from '@editmamei/tools/gimp-filter-tools.ts';
import { makeGimpBackend } from '../fixtures/fake-gimp-session.ts';
import { callTool, assertToolShape } from '../fixtures/tool-helpers.ts';

describe('createGimpFilterTools', () => {
  it('returns 1 well-formed tool with this name', () => {
    const gimp = makeGimpBackend();
    const tools = createGimpFilterTools(gimp.asBackend());
    expect(tools.map((t) => t.tool.name)).toEqual(['gimp_filter']);
    assertToolShape(tools);
  });

  it('requires image and op', async () => {
    const gimp = makeGimpBackend();
    const tools = createGimpFilterTools(gimp.asBackend());
    expect((await callTool(tools, 'gimp_filter', { op: 'list' })).isError).toBe(true);
    expect((await callTool(tools, 'gimp_filter', { image: 1 })).isError).toBe(true);
    expect(gimp.calls).toHaveLength(0);
  });

  it("op='list' dispatches filter and reports the filter count", async () => {
    const gimp = makeGimpBackend({ result: { filters: [{ filter_id: 1 }, { filter_id: 2 }] } });
    const tools = createGimpFilterTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_filter', { image: 5, op: 'list' });
    expect(gimp.lastCall()).toEqual({ op: 'filter', args: { image: 5, op: 'list' } });
    expect(result.isError).toBeFalsy();
    expect((result.content?.[0] as { text: string }).text).toContain('2 filter(s)');
  });

  it("op='set_visibility' dispatches with filter_id + visible", async () => {
    const gimp = makeGimpBackend({ result: { filter_id: 3, visible: false } });
    const tools = createGimpFilterTools(gimp.asBackend());
    await callTool(tools, 'gimp_filter', {
      image: 5,
      op: 'set_visibility',
      filter_id: 3,
      visible: false,
    });
    expect(gimp.lastCall()).toEqual({
      op: 'filter',
      args: { image: 5, op: 'set_visibility', filter_id: 3, visible: false },
    });
  });

  it("op='delete' dispatches with filter_id", async () => {
    const gimp = makeGimpBackend({ result: { filter_id: 3, name: 'Curves', deleted: true } });
    const tools = createGimpFilterTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_filter', { image: 5, op: 'delete', filter_id: 3 });
    expect(gimp.lastCall()).toEqual({
      op: 'filter',
      args: { image: 5, op: 'delete', filter_id: 3 },
    });
    expect((result.content?.[0] as { text: string }).text).toContain('Deleted filter 3');
  });

  it("'reorder' is not a valid op (dropped from the beta — GIMP has no API for it)", async () => {
    const gimp = makeGimpBackend();
    const tools = createGimpFilterTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_filter', { image: 5, op: 'reorder' });
    expect(result.isError).toBe(true);
    expect(gimp.calls).toHaveLength(0);
  });

  it('maps a bridge invalid_argument error through toolGimpErrorResult', async () => {
    const gimp = makeGimpBackend({
      throwFor: () => new Error('invalid_argument: no filter with id 99 on image 5'),
    });
    const tools = createGimpFilterTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_filter', { image: 5, op: 'delete', filter_id: 99 });
    expect(result.isError).toBe(true);
    expect((result.content?.[0] as { text: string }).text).toContain('invalid_argument');
  });
});

describe('gimp_filter op dispatch', () => {
  it('refuses an op outside list/set_visibility/delete without dispatching, even if the schema enum were loosened', async () => {
    // The schema enum rejects this first today; the handler's own fallback is the second line.
    // Loosen the enum for this test only, so the handler itself is exercised.
    const gimp = makeGimpBackend({ result: { filter_id: 1, name: 'x', deleted: true } });
    const tools = createGimpFilterTools(gimp.asBackend());
    const opProp = (tools[0]!.tool.inputSchema as { properties: { op: { enum: string[] } } })
      .properties.op;
    const saved = opProp.enum;
    opProp.enum = [...saved, 'reorder'];
    try {
      const result = await callTool(tools, 'gimp_filter', {
        image: 1,
        op: 'reorder',
        filter_id: 1,
      });
      expect(result.isError).toBe(true);
      expect((result.content?.[0] as { text: string }).text).toMatch(/reorder/);
      expect(gimp.calls).toHaveLength(0);
    } finally {
      opProp.enum = saved;
    }
  });
});
