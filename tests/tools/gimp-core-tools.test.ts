import { describe, it, expect } from 'vitest';
import { createGimpCoreTools } from '@editmamei/tools/gimp-core-tools.ts';
import { makeGimpBackend } from '../fixtures/fake-gimp-session.ts';
import { callTool, assertToolShape } from '../fixtures/tool-helpers.ts';

describe('createGimpCoreTools', () => {
  it('returns 2 well-formed tools with these names', () => {
    const gimp = makeGimpBackend();
    const tools = createGimpCoreTools(gimp.asBackend());
    expect(tools.map((t) => t.tool.name).sort()).toEqual(['gimp_overview', 'gimp_ping']);
    assertToolShape(tools);
  });

  describe('gimp_ping', () => {
    it('dispatches ping with no args and reports connected + version + open images', async () => {
      const gimp = makeGimpBackend({ result: { major: 3, minor: 2, micro: 6, images: [1, 2] } });
      const tools = createGimpCoreTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_ping');
      expect(gimp.lastCall()).toEqual({ op: 'ping', args: {} });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        connected: true,
        gimp_version: '3.2.6',
        open_images: [{ image: 1 }, { image: 2 }],
      });
    });

    it('reports session_state cold when the backend was idle before this call', async () => {
      const gimp = makeGimpBackend({
        result: { major: 3, minor: 2, micro: 6, images: [] },
        state: 'idle',
      });
      const tools = createGimpCoreTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_ping');
      expect(result.structuredContent?.session_state).toBe('cold');
    });

    it('reports session_state restarted when the backend was dead (crashed/timed-out) before this call', async () => {
      const gimp = makeGimpBackend({
        result: { major: 3, minor: 2, micro: 6, images: [] },
        state: 'dead',
      });
      const tools = createGimpCoreTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_ping');
      expect(result.structuredContent?.session_state).toBe('restarted');
    });

    it('never returns isError — a failed connection reports connected: false instead', async () => {
      const gimp = makeGimpBackend({
        throwFor: () => new Error('gimp_not_installed: no GIMP install was found'),
      });
      const tools = createGimpCoreTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_ping');
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ connected: false, gimp_version: null });
    });
  });

  describe('gimp_overview', () => {
    it('returns the static markdown brief with section headings', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpCoreTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_overview');
      expect(gimp.calls).toHaveLength(0); // no bridge round trip
      const sections = result.structuredContent?.sections as string[];
      expect(sections.length).toBeGreaterThan(3);
      expect(result.content?.[0]).toMatchObject({ type: 'text' });
    });
  });
});
