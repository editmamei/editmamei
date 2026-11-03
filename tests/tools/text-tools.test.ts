import { describe, it, expect, beforeEach } from 'vitest';
import { createTextTools, TEXT_OP_SCHEMAS } from '@editmamei/tools/text-tools.ts';
import { makeConnection, FakePhotoshopConnection } from '../fixtures/fake-connection.ts';
import { assertToolShape, callTool, textOf } from '../fixtures/tool-helpers.ts';
import { makeSnippetClient, FakeSnippetClient } from '../fixtures/fake-snippet-client.ts';

// ps_text is one tool with a flat op enum (create / set_content / set_font /
// set_color / set_alignment). op=create is a layer-lifecycle operation and
// its handler + schema live in layer-tools.ts; the four styling ops live
// here. These tests pin the TS→snippet param-forwarding contract for each.

describe('createTextTools', () => {
  let conn: FakePhotoshopConnection;
  let snippetClient: FakeSnippetClient;

  beforeEach(() => {
    conn = makeConnection();
    snippetClient = makeSnippetClient();
  });

  it('returns one well-formed tool: ps_text', () => {
    const tools = createTextTools(conn.asConnection(), snippetClient);
    assertToolShape(tools);
    expect(tools.map((t) => t.tool.name)).toEqual(['ps_text']);
  });

  it('the op field enumerates all five operations', () => {
    const tools = createTextTools(conn.asConnection(), snippetClient);
    const schema = tools[0].tool.inputSchema as unknown as {
      properties: { op: { enum: string[] } };
      required: string[];
    };
    expect(schema.properties.op.enum).toEqual([
      'create',
      'set_content',
      'set_font',
      'set_color',
      'set_alignment',
    ]);
    expect(schema.required).toEqual(['op']);
  });

  it('text op=create dispatches the createTextLayer snippet', async () => {
    const tools = createTextTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_text', { op: 'create', text: 'Hello', x: 50, y: 60, font_size: 30 });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('createTextLayer');
    expect(build.params.text).toBe('Hello');
    expect(build.params.x).toBe(50);
    expect(build.params.y).toBe(60);
    expect(build.params.fontSize).toBe(30);
  });

  it('text op=set_content dispatches the updateTextContent snippet', async () => {
    const tools = createTextTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_text', { op: 'set_content', text: 'He said "hi"' });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('updateTextContent');
    expect(build.params.newText).toBe('He said "hi"');
  });

  it('text op=set_font dispatches the setTextFont snippet', async () => {
    const tools = createTextTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_text', { op: 'set_font', font_name: 'Arial', font_size: 36 });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('setTextFont');
    expect(build.params.fontName).toBe('Arial');
    expect(build.params.fontSize).toBe(36);
  });

  // font_size is optional on set_font and must stay absent when omitted —
  // forwarding a default would silently resize type the caller only meant to
  // re-face. Font resolution itself happens in the Go snippet, so the one
  // dispatched script is the whole of this route's work.
  it('text op=set_font omitting font_size forwards no size and dispatches one script', async () => {
    const tools = createTextTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_text', { op: 'set_font', font_name: 'Arial' });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('setTextFont');
    expect(build.params.fontName).toBe('Arial');
    expect(build.params.fontSize).toBeUndefined();
    expect(conn.executions.length).toBe(1);
  });

  it('text op=set_color dispatches the setTextColor snippet', async () => {
    const tools = createTextTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_text', { op: 'set_color', red: 200, green: 50, blue: 100 });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('setTextColor');
    expect(build.params.red).toBe(200);
    expect(build.params.green).toBe(50);
    expect(build.params.blue).toBe(100);
  });

  it('text op=set_alignment dispatches the setTextAlignment snippet', async () => {
    const tools = createTextTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_text', { op: 'set_alignment', alignment: 'CENTER' });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('setTextAlignment');
    expect(build.params.alignment).toBe('CENTER');
  });

  it('text rejects an unknown op without dispatching, naming the allowed set', async () => {
    const tools = createTextTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_text', { op: 'delete' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(
      /Allowed: create, set_content, set_font, set_color, set_alignment/
    );
    expect(snippetClient.allBuilds().length).toBe(0);
    expect(conn.executions.length).toBe(0);
  });

  // The op=create dispatch test above passes x/y/font_size explicitly, which
  // hides a defaulting drift. Call it with the bare minimum and pin the
  // defaults themselves — placement and size a caller never named are exactly
  // what a schema edit can change without any test noticing.
  it('ps_text op=create with only text applies the documented position + size defaults', async () => {
    const tools = createTextTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_text', { op: 'create', text: 'Hero grade' });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('createTextLayer');
    expect(build.params).toEqual({ text: 'Hero grade', x: 100, y: 100, fontSize: 24 });
  });

  it('ps_text missing op errors with the unknown-discriminator message and dispatches nothing', async () => {
    const tools = createTextTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_text', { text: 'Hero grade' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(
      /Allowed: create, set_content, set_font, set_color, set_alignment/
    );
    expect(snippetClient.allBuilds().length).toBe(0);
    expect(conn.executions.length).toBe(0);
  });

  // The merged schema is what the caller reads in tools/list; the per-op
  // schema is what the delegate validates against. A param present only in
  // the latter is invisible and un-passable. Driven off the per-op schemas'
  // own property keys so a rename there fails here instead of silently
  // dropping the param out of the advertised surface.
  it('the ps_text schema advertises every property the five delegate schemas validate', () => {
    const tools = createTextTools(conn.asConnection(), snippetClient);
    const merged = tools.find((t) => t.tool.name === 'ps_text')!.tool.inputSchema as unknown as {
      properties: Record<string, unknown>;
    };
    const advertised = Object.keys(merged.properties);
    for (const [op, schema] of Object.entries(TEXT_OP_SCHEMAS)) {
      for (const prop of Object.keys(schema.properties ?? {})) {
        expect(
          advertised,
          `ps_text op=${op} validates "${prop}", which the merged schema hides`
        ).toContain(prop);
      }
    }
  });
});
