import { describe, it, expect, beforeEach } from 'vitest';
import { createInspectTools } from '@editmamei/tools/inspect-tools.ts';
import { makeConnection, FakePhotoshopConnection } from '../fixtures/fake-connection.ts';
import { assertToolShape, callTool } from '../fixtures/tool-helpers.ts';
import { makeSnippetClient, FakeSnippetClient } from '../fixtures/fake-snippet-client.ts';

/**
 * ps_inspect consolidates the five read-only state readers
 * (metadata / layer_tree / history / selection_info / smart_object) behind a
 * `what` discriminator (Phase 1b, 2026-06-26; smart_object added
 * 2026-08-08). The metadata behaviour below is the former get_metadata
 * coverage, now driven through what='metadata'; the other four branches
 * assert each dispatches its own go-core snippet.
 */
describe('createInspectTools', () => {
  let conn: FakePhotoshopConnection;
  let snippetClient: FakeSnippetClient;
  beforeEach(() => {
    conn = makeConnection();
    snippetClient = makeSnippetClient();
  });

  it('returns 1 well-formed tool', () => {
    const tools = createInspectTools(conn.asConnection(), snippetClient);
    assertToolShape(tools);
    expect(tools.map((t) => t.tool.name)).toEqual(['ps_inspect']);
  });

  it('declares readOnlyHint + idempotentHint + openWorldHint (metadata touches the source file)', () => {
    const tools = createInspectTools(conn.asConnection(), snippetClient);
    const ann = (tools[0].tool as { annotations?: Record<string, unknown> }).annotations;
    expect(ann?.readOnlyHint).toBe(true);
    expect(ann?.idempotentHint).toBe(true);
    expect(ann?.openWorldHint).toBe(true);
  });

  it('requires the `what` discriminator and rejects unknown values', async () => {
    const tools = createInspectTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_inspect', { what: 'bogus' });
    expect(result.isError).toBe(true);
  });

  // ---- what: layer_tree / history / selection_info / smart_object dispatch ----

  it("what='layer_tree' dispatches the getLayerTree snippet", async () => {
    const tools = createInspectTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_inspect', { what: 'layer_tree' });
    expect(snippetClient.lastBuild().name).toBe('getLayerTree');
  });

  it("what='history' dispatches the getHistoryStates snippet", async () => {
    const tools = createInspectTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_inspect', { what: 'history' });
    expect(snippetClient.lastBuild().name).toBe('getHistoryStates');
  });

  it("what='selection_info' dispatches the getSelectionState snippet", async () => {
    conn = makeConnection({ result: { has_selection: false } });
    snippetClient = makeSnippetClient();
    const tools = createInspectTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_inspect', { what: 'selection_info' });
    expect(snippetClient.lastBuild().name).toBe('getSelectionState');
    const structured = (result as { structuredContent: Record<string, unknown> }).structuredContent;
    expect(structured.selection_info).toBeDefined();
  });

  it("what='smart_object' dispatches the getSmartObjectInfo snippet", async () => {
    conn = makeConnection({
      result: { is_smart_object: false, layer_name: 'Background', layer_kind: 'LayerKind.NORMAL' },
    });
    snippetClient = makeSnippetClient();
    const tools = createInspectTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_inspect', { what: 'smart_object' });
    expect(snippetClient.lastBuild().name).toBe('getSmartObjectInfo');
    const structured = (result as { structuredContent: Record<string, unknown> }).structuredContent;
    expect(structured.is_smart_object).toBeDefined();
  });

  // ---- what: metadata (former get_metadata coverage) ----

  it("what='metadata' default (no sections) dispatches getMetadata with document+iptc", async () => {
    conn = makeConnection({
      result: {
        document: { name: 'test.heic', full_path: null },
        iptc: { title: null },
        context: { hasDocument: true },
      },
    });
    snippetClient = makeSnippetClient();
    const tools = createInspectTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_inspect', { what: 'metadata' });

    const build = snippetClient.lastBuild();
    expect(build.name).toBe('getMetadata');
    expect(build.params.document).toBe(true);
    expect(build.params.iptc).toBe(true);
  });

  it("what='metadata' reports source_metadata unavailable when the document has no full_path", async () => {
    conn = makeConnection({
      result: {
        document: { name: 'untitled.psd', full_path: null },
        iptc: { title: null },
        context: { hasDocument: true },
      },
    });
    const tools = createInspectTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_inspect', { what: 'metadata' });

    const structured = (result as { structuredContent: Record<string, unknown> }).structuredContent;
    expect(structured).toBeDefined();
    expect(structured.document).toBeDefined();
    expect(structured.iptc).toBeDefined();
    const sourceMeta = structured.source_metadata as { available: boolean; reason: string };
    expect(sourceMeta.available).toBe(false);
    expect(sourceMeta.reason).toBe('no_source_path');
  });

  it("what='metadata' reports source_metadata unavailable for a nonexistent/unsupported file", async () => {
    conn = makeConnection({
      result: {
        document: {
          name: 'ghost.psd',
          full_path: 'Z:\\definitely-not-a-real-path\\ghost.psd',
        },
        iptc: { title: null },
        context: { hasDocument: true },
      },
    });
    const tools = createInspectTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_inspect', { what: 'metadata' });

    const structured = (result as { structuredContent: Record<string, unknown> }).structuredContent;
    const sourceMeta = structured.source_metadata as { available: boolean; reason: string };
    expect(sourceMeta.available).toBe(false);
    expect(sourceMeta.reason).toMatch(/^(unsupported_format|exif_error|no_metadata_found)/);
  });

  it("what='metadata' sections=['context'] skips the IPTC traversal and source-file read", async () => {
    conn = makeConnection({ result: { context: { hasDocument: true } } });
    snippetClient = makeSnippetClient();
    const tools = createInspectTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_inspect', {
      what: 'metadata',
      sections: ['context'],
    });

    const build = snippetClient.lastBuild();
    expect(build.name).toBe('getMetadata');
    expect(build.params.document).toBe(false);
    expect(build.params.iptc).toBe(false);

    const structured = (result as { structuredContent: Record<string, unknown> }).structuredContent;
    expect(structured.context).toBeDefined();
    expect(structured.document).toBeUndefined();
    expect(structured.iptc).toBeUndefined();
    expect(structured.camera).toBeUndefined();
    expect(structured.source_metadata).toBeUndefined();
  });

  it("what='metadata' sections=['camera'] fetches full_path + dom_exif, skips IPTC", async () => {
    conn = makeConnection({
      result: {
        document: { name: 'untitled.psd', full_path: null },
        dom_exif: {},
        context: { hasDocument: true },
      },
    });
    snippetClient = makeSnippetClient();
    const tools = createInspectTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_inspect', {
      what: 'metadata',
      sections: ['camera'],
    });

    const build = snippetClient.lastBuild();
    expect(build.name).toBe('getMetadata');
    expect(build.params.document).toBe(true);
    expect(build.params.dom_exif).toBe(true);
    expect(build.params.iptc).toBe(false);

    const structured = (result as { structuredContent: Record<string, unknown> }).structuredContent;
    expect(structured.document).toBeUndefined();
    expect(structured.iptc).toBeUndefined();
    expect(structured.context).toBeDefined();
    expect(structured.source_metadata).toBeDefined();
  });

  it("what='metadata' rejects unknown section values", async () => {
    const tools = createInspectTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_inspect', {
      what: 'metadata',
      sections: ['bogus'],
    });
    expect(result.isError).toBe(true);
  });

  it('returns isError on script failure', async () => {
    const failing = makeConnection({ throwOnExecute: new Error('PS unavailable') });
    const tools = createInspectTools(failing.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_inspect', { what: 'metadata' });
    expect(result.isError).toBe(true);
  });
});
