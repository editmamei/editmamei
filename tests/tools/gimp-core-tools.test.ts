import { describe, it, expect } from 'vitest';
import { createGimpCoreTools } from '@editmamei/tools/gimp-core-tools.ts';
import { GimpError } from '@editmamei/backends/gimp/errors.ts';
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

    it('reports session_state cold, not restarted, when a first launch that failed was retried (dead, but never ready)', async () => {
      const gimp = makeGimpBackend({
        result: { major: 3, minor: 2, micro: 6, images: [] },
        state: 'dead',
        startOrigin: 'cold',
      });
      const tools = createGimpCoreTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_ping');
      expect(result.structuredContent?.session_state).toBe('cold');
    });

    it('shows the install only by file name in a failure message (a full path carries the username)', async () => {
      const dir = 'C:/Users/someone/AppData/Local/Programs/GIMP 3/bin';
      const full = `${dir}/gimp-console-3.2.exe`;
      const gimp = makeGimpBackend({
        install: { source: 'conventional', path: full, launch: { command: full, args: [] } },
        throwFor: () =>
          new GimpError(
            'gimp_start_failed',
            `could not start GIMP at "${full}": spawn ${full} EACCES`
          ),
      });
      const tools = createGimpCoreTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_ping');
      const text = (result.content?.[0] as { text: string }).text;
      expect(text).not.toContain(dir);
      expect(text).toContain('could not start GIMP at "gimp-console-3.2.exe"');
      expect(result.structuredContent?.install_path_basename).toBe('gimp-console-3.2.exe');
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

    it('reports starting: true (still never isError) when the session is on a slow first launch', async () => {
      const gimp = makeGimpBackend({
        throwFor: () =>
          new GimpError(
            'gimp_starting',
            'GIMP is still starting. Call gimp_ping again in about 30 seconds.'
          ),
      });
      const tools = createGimpCoreTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_ping');
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ connected: false, starting: true });
      expect((result.content?.[0] as { text: string }).text).toContain('Call gimp_ping again');
    });

    it('reports session_state restarted (not warm) when the prior state was "starting" and its origin was a restart', async () => {
      const gimp = makeGimpBackend({
        result: { major: 3, minor: 2, micro: 6, images: [] },
        state: 'starting',
        startOrigin: 'restarted',
      });
      const tools = createGimpCoreTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_ping');
      expect(result.structuredContent).toMatchObject({
        connected: true,
        session_state: 'restarted',
      });
    });

    it('reports session_state cold when the prior state was "starting" and its origin was the first-ever launch', async () => {
      const gimp = makeGimpBackend({
        result: { major: 3, minor: 2, micro: 6, images: [] },
        state: 'starting',
        startOrigin: 'cold',
      });
      const tools = createGimpCoreTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_ping');
      expect(result.structuredContent).toMatchObject({ connected: true, session_state: 'cold' });
    });

    it('the gimp_starting (still-starting) branch itself reports session_state from the attempt origin, not a hard-coded cold', async () => {
      const gimp = makeGimpBackend({
        state: 'starting',
        startOrigin: 'restarted',
        throwFor: () =>
          new GimpError(
            'gimp_starting',
            'GIMP is restarting after stopping unexpectedly. Call gimp_ping again in about 30 seconds.'
          ),
      });
      const tools = createGimpCoreTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_ping');
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        connected: false,
        starting: true,
        session_state: 'restarted',
      });
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
