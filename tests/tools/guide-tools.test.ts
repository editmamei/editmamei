import { describe, it, expect, beforeEach } from 'vitest';
import { createGuideTools } from '@editmamei/tools/guide-tools.ts';
import { makeConnection, FakePhotoshopConnection } from '../fixtures/fake-connection.ts';
import { makeSnippetClient, FakeSnippetClient } from '../fixtures/fake-snippet-client.ts';
import { assertToolShape, callTool } from '../fixtures/tool-helpers.ts';

// ps_guides (op=add|layout|clear) — non-printing HUMAN layout aids (editor-only
// chrome, absent from ps_get_preview), so no anchor-relational grounding: `add`
// takes a raw pixel position. add uses the DOM Guides API; layout/clear use AM.
describe('createGuideTools', () => {
  let conn: FakePhotoshopConnection;
  let sc: FakeSnippetClient;
  beforeEach(() => {
    conn = makeConnection();
    sc = makeSnippetClient();
  });

  it('returns one ps_guides tool', () => {
    const tools = createGuideTools(conn.asConnection(), sc);
    assertToolShape(tools);
    expect(tools.map((t) => t.tool.name)).toEqual(['ps_guides']);
  });

  it('the op field enumerates add + layout + clear', () => {
    const tools = createGuideTools(conn.asConnection(), sc);
    const schema = tools[0].tool.inputSchema as unknown as {
      properties: { op: { enum: string[] } };
      required: string[];
    };
    expect(schema.properties.op.enum).toEqual(['add', 'layout', 'clear']);
    expect(schema.required).toContain('op');
  });

  it('an unknown op returns an error without dispatching', async () => {
    const tools = createGuideTools(conn.asConnection(), sc);
    const result = await callTool(tools, 'ps_guides', { op: 'bogus' });
    expect(result.isError).toBe(true);
    expect(conn.executions.length).toBe(0);
  });

  it('op=add forwards orientation + position to addGuide', async () => {
    const tools = createGuideTools(conn.asConnection(), sc);
    await callTool(tools, 'ps_guides', {
      op: 'add',
      orientation: 'vertical',
      position: 200,
    });
    const b = sc.lastBuild();
    expect(b.name).toBe('addGuide');
    expect(b.params.orientation).toBe('vertical');
    expect(b.params.position).toBe(200);
  });

  it('op=layout forwards columns + rows to addGuideLayout', async () => {
    const tools = createGuideTools(conn.asConnection(), sc);
    await callTool(tools, 'ps_guides', { op: 'layout', columns: 3, rows: 3 });
    const b = sc.lastBuild();
    expect(b.name).toBe('addGuideLayout');
    expect(b.params.columns).toBe(3);
    expect(b.params.rows).toBe(3);
  });

  it('op=layout with neither columns nor rows errors before dispatching', async () => {
    const tools = createGuideTools(conn.asConnection(), sc);
    const result = await callTool(tools, 'ps_guides', { op: 'layout', columns: 0, rows: 0 });
    expect(result.isError).toBe(true);
    expect(conn.executions.length).toBe(0);
  });

  it('op=clear forwards to clearGuides', async () => {
    const tools = createGuideTools(conn.asConnection(), sc);
    await callTool(tools, 'ps_guides', { op: 'clear' });
    expect(sc.lastBuild().name).toBe('clearGuides');
  });

  it('op=add without a position errors (position is required) and dispatches nothing', async () => {
    const tools = createGuideTools(conn.asConnection(), sc);
    const res = await callTool(tools, 'ps_guides', { op: 'add', orientation: 'horizontal' });
    expect(res.isError).toBe(true);
    expect(conn.executions.length).toBe(0);
  });
});
