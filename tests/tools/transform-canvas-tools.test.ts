import { describe, it, expect, beforeEach } from 'vitest';
import { createTransformCanvasTools } from '@editmamei/tools/transform-canvas-tools.ts';
import { makeConnection, FakePhotoshopConnection } from '../fixtures/fake-connection.ts';
import { makeSnippetClient, FakeSnippetClient } from '../fixtures/fake-snippet-client.ts';
import { assertToolShape, callTool } from '../fixtures/tool-helpers.ts';

// M2 (2026-06-21) — ps_transform_canvas (op=rotate|flip). dev-tier.
// Document-level transforms; the snippet bodies are verified in go-core.
describe('createTransformCanvasTools', () => {
  let conn: FakePhotoshopConnection;
  let sc: FakeSnippetClient;
  beforeEach(() => {
    conn = makeConnection();
    sc = makeSnippetClient();
  });

  it('returns one ps_transform_canvas tool', () => {
    const tools = createTransformCanvasTools(conn.asConnection(), sc);
    assertToolShape(tools);
    expect(tools.map((t) => t.tool.name)).toEqual(['ps_transform_canvas']);
  });

  it('the op field enumerates rotate + flip', () => {
    const tools = createTransformCanvasTools(conn.asConnection(), sc);
    const schema = tools[0].tool.inputSchema as unknown as {
      properties: { op: { enum: string[] } };
      required: string[];
    };
    expect(schema.properties.op.enum).toEqual(['rotate', 'flip']);
    expect(schema.required).toContain('op');
  });

  it('an unknown op returns an error without dispatching', async () => {
    const tools = createTransformCanvasTools(conn.asConnection(), sc);
    const result = await callTool(tools, 'ps_transform_canvas', { op: 'bogus' });
    expect(result.isError).toBe(true);
    expect(conn.executions.length).toBe(0);
  });

  it('op=rotate forwards degrees to rotateCanvas', async () => {
    const tools = createTransformCanvasTools(conn.asConnection(), sc);
    await callTool(tools, 'ps_transform_canvas', { op: 'rotate', degrees: 15 });
    expect(sc.lastBuild().name).toBe('rotateCanvas');
    expect(sc.lastBuild().params.degrees).toBe(15);
  });

  it('op=flip forwards orientation to flipCanvas', async () => {
    const tools = createTransformCanvasTools(conn.asConnection(), sc);
    await callTool(tools, 'ps_transform_canvas', { op: 'flip', orientation: 'horizontal' });
    expect(sc.lastBuild().name).toBe('flipCanvas');
    expect(sc.lastBuild().params.orientation).toBe('horizontal');
  });

  it('op=flip rejects an invalid orientation via schema validation', async () => {
    const tools = createTransformCanvasTools(conn.asConnection(), sc);
    const result = await callTool(tools, 'ps_transform_canvas', {
      op: 'flip',
      orientation: 'diagonal',
    });
    expect(result.isError).toBe(true);
    expect(conn.executions.length).toBe(0);
  });
});
