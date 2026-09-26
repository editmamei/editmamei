import { describe, it, expect } from 'vitest';
import { createGimpInspectTools } from '@editmamei/tools/gimp-inspect-tools.ts';
import { makeGimpBackend } from '../fixtures/fake-gimp-session.ts';
import { callTool, assertToolShape } from '../fixtures/tool-helpers.ts';

describe('createGimpInspectTools', () => {
  it('returns 1 well-formed tool with this name', () => {
    const gimp = makeGimpBackend();
    const tools = createGimpInspectTools(gimp.asBackend());
    expect(tools.map((t) => t.tool.name)).toEqual(['gimp_inspect']);
    assertToolShape(tools);
  });

  it('requires what', async () => {
    const gimp = makeGimpBackend();
    const tools = createGimpInspectTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_inspect', {});
    expect(result.isError).toBe(true);
    expect(gimp.calls).toHaveLength(0);
  });

  it("what='documents' dispatches ping and reports the open image ids", async () => {
    const gimp = makeGimpBackend({ result: { images: [4, 5] } });
    const tools = createGimpInspectTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_inspect', { what: 'documents' });
    expect(gimp.lastCall()).toEqual({ op: 'ping', args: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      what: 'documents',
      documents: [{ image: 4 }, { image: 5 }],
    });
  });

  it('an unknown what is refused before any dispatch (schema enum today only allows documents)', async () => {
    const gimp = makeGimpBackend();
    const tools = createGimpInspectTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_inspect', { what: 'layers' });
    expect(result.isError).toBe(true);
    expect(gimp.calls).toHaveLength(0);
  });
});
