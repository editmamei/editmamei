import { describe, it, expect, beforeEach } from 'vitest';
import { createHistoryTools } from '@editmamei/tools/history-tools.ts';
import { makeConnection, FakePhotoshopConnection } from '../fixtures/fake-connection.ts';
import { assertToolShape, callTool, textOf } from '../fixtures/tool-helpers.ts';
import { makeSnippetClient, FakeSnippetClient } from '../fixtures/fake-snippet-client.ts';

describe('createHistoryTools', () => {
  let conn: FakePhotoshopConnection;
  let snippetClient: FakeSnippetClient;
  beforeEach(() => {
    conn = makeConnection();
    snippetClient = makeSnippetClient();
  });

  it('returns 2 well-formed tools', () => {
    const tools = createHistoryTools(conn.asConnection(), snippetClient);
    assertToolShape(tools);
    // get_history merged into ps_inspect(what='history') — Phase 1b.
    expect(tools.map((t) => t.tool.name)).toEqual(['ps_undo', 'ps_redo']);
  });

  it('undo dispatches a script and defaults steps to 1', async () => {
    const tools = createHistoryTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_undo', {});
    expect(conn.executions).toHaveLength(1);
    expect(textOf(result)).toContain('Undo successful (1 step)');
  });

  it('undo handles multi-step counts and pluralizes', async () => {
    const tools = createHistoryTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_undo', { steps: 3 });
    expect(textOf(result)).toContain('Undo successful (3 steps)');
  });

  it('redo dispatches a script and pluralizes correctly', async () => {
    const tools = createHistoryTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_redo', { steps: 2 });
    expect(conn.executions).toHaveLength(1);
    expect(textOf(result)).toContain('Redo successful (2 steps)');
  });
});
