import { describe, it, expect, beforeEach } from 'vitest';
import { createTextTools, TEXT_OP_SCHEMAS } from '@editmamei/tools/text-tools.ts';
import { createLayerTools } from '@editmamei/tools/layer-tools.ts';
import { makeConnection, FakePhotoshopConnection } from '../fixtures/fake-connection.ts';
import { assertToolShape, callTool, textOf } from '../fixtures/tool-helpers.ts';
import { makeSnippetClient, FakeSnippetClient } from '../fixtures/fake-snippet-client.ts';

// 2026-06-20 — Phase 1 consolidation. set_text_font / set_text_color /
// set_text_alignment / update_text_content collapsed into one ps_set_text
// with a `property` discriminator. Per-property handlers unchanged.
//
// 2026-08-13 — ps_create_text_layer (layer-tools.ts) + ps_set_text collapsed
// into one ps_text with a flattened op enum (create / set_content / set_font
// / set_color / set_alignment), folding the old `property` sub-discriminator
// up a level rather than keeping a two-level op+property shape. Both old
// tools stay registered as deprecated aliases for one release.

describe('createTextTools', () => {
  let conn: FakePhotoshopConnection;
  let snippetClient: FakeSnippetClient;

  beforeEach(() => {
    conn = makeConnection();
    snippetClient = makeSnippetClient();
  });

  it('returns two well-formed tools: ps_text and the deprecated ps_set_text', () => {
    const tools = createTextTools(conn.asConnection(), snippetClient);
    assertToolShape(tools);
    expect(tools.map((t) => t.tool.name)).toEqual(['ps_text', 'ps_set_text']);
  });

  it('the deprecated ps_set_text property field enumerates all four attributes', () => {
    const tools = createTextTools(conn.asConnection(), snippetClient);
    const tool = tools.find((t) => t.tool.name === 'ps_set_text')!;
    const schema = tool.tool.inputSchema as unknown as {
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

  // ===========================================================================
  // ps_text (2026-08-13) — the flattened op enum. Each op dispatches the
  // exact same handler function (and therefore the exact same snippet) the
  // deprecated tools call, so behavior-preservation is proven both by direct
  // dispatch tests here and by the equivalence tests below.
  // ===========================================================================

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

  // The important equivalence: ps_set_text's four deprecated `property`
  // values and ps_text's matching `op` values must build the identical
  // snippet. Both routes call the same handler function.
  it('each deprecated ps_set_text property builds the identical snippet + params as the matching ps_text op', async () => {
    const cases: Array<{ property: string; op: string; args: Record<string, unknown> }> = [
      { property: 'font', op: 'set_font', args: { font_name: 'Georgia', font_size: 18 } },
      { property: 'color', op: 'set_color', args: { red: 10, green: 20, blue: 30 } },
      { property: 'alignment', op: 'set_alignment', args: { alignment: 'RIGHT' } },
      { property: 'content', op: 'set_content', args: { text: 'Updated' } },
    ];

    for (const { property, op, args } of cases) {
      const oldClient = makeSnippetClient();
      const newClient = makeSnippetClient();
      const oldTools = createTextTools(conn.asConnection(), oldClient);
      const newTools = createTextTools(conn.asConnection(), newClient);

      await callTool(oldTools, 'ps_set_text', { property, ...args });
      await callTool(newTools, 'ps_text', { op, ...args });

      const oldBuild = oldClient.lastBuild();
      const newBuild = newClient.lastBuild();
      expect(oldBuild.name, op).toBe(newBuild.name);
      expect(oldBuild.params, op).toEqual(newBuild.params);
    }
  });

  // ps_create_text_layer lives in layer-tools.ts (a different source file) —
  // this equivalence spans files, proving ps_text(op=create) reaches the
  // exact same createTextLayer function the deprecated cross-file alias does.
  it('the deprecated ps_create_text_layer (layer-tools.ts) builds the identical snippet + params as ps_text op=create', async () => {
    const oldClient = makeSnippetClient();
    const newClient = makeSnippetClient();
    const oldTools = createLayerTools(conn.asConnection(), oldClient);
    const newTools = createTextTools(conn.asConnection(), newClient);

    const args = { text: 'Hero grade', x: 10, y: 20, font_size: 42 };
    await callTool(oldTools, 'ps_create_text_layer', args);
    await callTool(newTools, 'ps_text', { op: 'create', ...args });

    const oldBuild = oldClient.lastBuild();
    const newBuild = newClient.lastBuild();
    expect(oldBuild.name).toBe(newBuild.name);
    expect(oldBuild.name).toBe('createTextLayer');
    expect(oldBuild.params).toEqual(newBuild.params);
  });

  // The equivalence above passes x/y/font_size explicitly, so a defaulting
  // divergence between the two routes would still look identical. Call each
  // with the bare minimum and let the defaults do the talking.
  it('ps_text op=create with only text defaults identically to ps_create_text_layer with only text', async () => {
    const oldClient = makeSnippetClient();
    const newClient = makeSnippetClient();
    const oldTools = createLayerTools(conn.asConnection(), oldClient);
    const newTools = createTextTools(conn.asConnection(), newClient);

    await callTool(oldTools, 'ps_create_text_layer', { text: 'Hero grade' });
    await callTool(newTools, 'ps_text', { op: 'create', text: 'Hero grade' });

    const oldBuild = oldClient.lastBuild();
    const newBuild = newClient.lastBuild();
    expect(newBuild.name).toBe(oldBuild.name);
    expect(newBuild.params).toEqual(oldBuild.params);
    // Pin the defaults themselves, so "identical" can't quietly become
    // "identically wrong" if one route's defaults drift.
    expect(newBuild.params).toEqual({ text: 'Hero grade', x: 100, y: 100, fontSize: 24 });
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
