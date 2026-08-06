import { describe, it, expect, beforeEach } from 'vitest';
import { createTextTools } from '@editmamei/tools/text-tools.ts';
import { makeConnection, FakePhotoshopConnection } from '../fixtures/fake-connection.ts';
import { assertToolShape, callTool } from '../fixtures/tool-helpers.ts';
import { makeSnippetClient, FakeSnippetClient } from '../fixtures/fake-snippet-client.ts';

// 2026-06-20 — Phase 1 consolidation. set_text_font / set_text_color /
// set_text_alignment / update_text_content collapsed into one ps_set_text
// with a `property` discriminator. Per-property handlers unchanged.

describe('createTextTools', () => {
  let conn: FakePhotoshopConnection;
  let snippetClient: FakeSnippetClient;

  beforeEach(() => {
    conn = makeConnection();
    snippetClient = makeSnippetClient();
  });

  it('returns one consolidated set_text tool, well-formed', () => {
    const tools = createTextTools(conn.asConnection(), snippetClient);
    assertToolShape(tools);
    expect(tools.map((t) => t.tool.name)).toEqual(['ps_set_text']);
  });

  it('the property field enumerates all four attributes', () => {
    const tools = createTextTools(conn.asConnection(), snippetClient);
    const schema = tools[0].tool.inputSchema as unknown as {
      properties: { property: { enum: string[] } };
      required: string[];
    };
    expect(schema.properties.property.enum).toEqual(['font', 'color', 'alignment', 'content']);
    expect(schema.required).toContain('property');
  });

  it('an unknown property returns an error without dispatching', async () => {
    const tools = createTextTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_set_text', { property: 'bogus' });
    expect(result.isError).toBe(true);
    expect(conn.executions.length).toBe(0);
  });

  it('property=font passes font name and size to the snippet', async () => {
    const tools = createTextTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_set_text', {
      property: 'font',
      font_name: 'Arial',
      font_size: 36,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('setTextFont');
    expect(build.params.fontName).toBe('Arial');
    expect(build.params.fontSize).toBe(36);
  });

  it('property=font dispatches a script (font resolution happens in the Go snippet)', async () => {
    const tools = createTextTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_set_text', { property: 'font', font_name: 'Arial' });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('setTextFont');
    expect(build.params.fontName).toBe('Arial');
    expect(conn.executions.length).toBe(1);
  });

  it('property=color passes RGB triple to the snippet', async () => {
    const tools = createTextTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_set_text', {
      property: 'color',
      red: 200,
      green: 50,
      blue: 100,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('setTextColor');
    expect(build.params.red).toBe(200);
    expect(build.params.green).toBe(50);
    expect(build.params.blue).toBe(100);
  });

  it('property=content passes the text to the snippet', async () => {
    const tools = createTextTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_set_text', { property: 'content', text: 'He said "hi"' });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('updateTextContent');
    expect(build.params.newText).toBe('He said "hi"');
  });

  it('property=alignment passes the alignment enum value to the snippet', async () => {
    const tools = createTextTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_set_text', { property: 'alignment', alignment: 'CENTER' });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('setTextAlignment');
    expect(build.params.alignment).toBe('CENTER');
  });
});
