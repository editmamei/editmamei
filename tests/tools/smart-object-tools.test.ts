/**
 * ps_filter's management ops (op=list / set_visibility / set_blend / remove —
 * the former standalone Smart-Filter tool, merged into ps_filter 2026-08-09),
 * plus ps_inspect what=smart_object's handler.
 *
 * These unit tests pin the TS→snippet (name, params) forwarding contract and
 * the per-op requirement checks the JSON schema cannot express. The Photoshop
 * semantics behind them — the 1-based write index mapping onto the 0-based read
 * list, blendOptions-only setd preserving both the filter's parameters and its
 * siblings, and all 27 blend modes round-tripping through stringIDToTypeID —
 * were measured against live PS 27.2.0 (2026-08-08); see
 * go-core/cmd/buildtemplates/fragments_smartobject.go.
 *
 * The management ops themselves are exercised THROUGH ps_filter
 * (createFilterTools), not by calling src/tools/smart-object-tools.ts's
 * exported runSmartFilterOp directly — the former standalone tool no longer
 * exists as a registered tool, so this is the only way a real caller reaches
 * this logic.
 * File kept as smart-object-tools.test.ts (1:1 with the source module it
 * exercises, src/tools/smart-object-tools.ts, which still holds this logic
 * even though it no longer registers its own tool).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createFilterTools } from '@editmamei/tools/filter-tools.ts';
import { getSmartObjectInfoHandler } from '@editmamei/tools/smart-object-tools.ts';
import { makeConnection, FakePhotoshopConnection } from '../fixtures/fake-connection.ts';
import { callTool, textOf } from '../fixtures/tool-helpers.ts';
import { makeSnippetClient, FakeSnippetClient } from '../fixtures/fake-snippet-client.ts';

describe('ps_filter — Smart Filter management ops (op=list/set_visibility/set_blend/remove)', () => {
  let conn: FakePhotoshopConnection;
  let snippetClient: FakeSnippetClient;

  beforeEach(() => {
    conn = makeConnection({
      result: {
        is_smart_object: true,
        count: 2,
        filters: [
          {
            index: 1,
            name: 'Gaussian Blur...',
            type: 'gaussianBlur',
            enabled: true,
            opacity: 100,
            blend_mode: 'NORMAL',
            filter_id: 1198747202,
          },
          {
            index: 2,
            name: 'Add Noise...',
            type: 'addNoise',
            enabled: false,
            opacity: 70,
            blend_mode: 'SCREEN',
            filter_id: 1097092723,
          },
        ],
        index: 1,
        enabled: false,
        opacity: 70,
        blend_mode: 'SCREEN',
        filter_name: 'Gaussian Blur...',
        filter_type: 'gaussianBlur',
        removed_filter_name: 'Gaussian Blur...',
        remaining_count: 1,
        layer_name: 'Portrait',
      },
    });
    snippetClient = makeSnippetClient();
  });

  it('list → listSmartFilters, no params', async () => {
    const tools = createFilterTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_filter', { op: 'list' });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('listSmartFilters');
    expect(build.params).toEqual({});
  });

  it('set_visibility → setSmartFilterVisibility forwarding index + enabled', async () => {
    const tools = createFilterTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_filter', { op: 'set_visibility', index: 2, enabled: false });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('setSmartFilterVisibility');
    expect(build.params).toEqual({ index: 2, enabled: false });
  });

  it('remove → removeSmartFilter forwarding the index', async () => {
    const tools = createFilterTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_filter', { op: 'remove', index: 1 });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('removeSmartFilter');
    expect(build.params).toEqual({ index: 1 });
  });

  it('set_blend maps blend_mode → blendMode and forwards opacity', async () => {
    const tools = createFilterTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_filter', {
      op: 'set_blend',
      index: 1,
      opacity: 70,
      blend_mode: 'SCREEN',
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('setSmartFilterBlend');
    expect(build.params).toEqual({ index: 1, opacity: 70, blendMode: 'SCREEN' });
  });

  // An omitted blendOptions key leaves that property alone in Photoshop, so
  // forwarding a defaulted value would silently reset the other half of the
  // blend. Only what the caller supplied may reach the snippet.
  it('set_blend forwards ONLY the supplied half (opacity alone)', async () => {
    const tools = createFilterTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_filter', { op: 'set_blend', index: 1, opacity: 40 });
    const build = snippetClient.lastBuild();
    expect(build.params).toEqual({ index: 1, opacity: 40 });
    expect(build.params).not.toHaveProperty('blendMode');
  });

  it('set_blend forwards ONLY the supplied half (blend_mode alone)', async () => {
    const tools = createFilterTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_filter', {
      op: 'set_blend',
      index: 1,
      blend_mode: 'MULTIPLY',
    });
    const build = snippetClient.lastBuild();
    expect(build.params).toEqual({ index: 1, blendMode: 'MULTIPLY' });
    expect(build.params).not.toHaveProperty('opacity');
  });

  it('blend_mode enum matches the shared LAYER_BLEND_MODES vocabulary', async () => {
    const { LAYER_BLEND_MODES } = await import('@editmamei/utils/blend-modes.ts');
    const tools = createFilterTools(conn.asConnection(), snippetClient);
    const schema = tools[0].tool.inputSchema as unknown as {
      properties: { blend_mode: { enum: string[] } };
    };
    expect(schema.properties.blend_mode.enum).toEqual([...LAYER_BLEND_MODES]);
  });

  describe('per-op requirements the schema cannot express', () => {
    it.each(['set_visibility', 'set_blend', 'remove'])('%s without index errors', async (op) => {
      const tools = createFilterTools(conn.asConnection(), snippetClient);
      const res = await callTool(tools, 'ps_filter', { op, enabled: true });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('needs an `index`');
      expect(snippetClient.allBuilds()).toHaveLength(0);
    });

    it('set_visibility without enabled errors', async () => {
      const tools = createFilterTools(conn.asConnection(), snippetClient);
      const res = await callTool(tools, 'ps_filter', { op: 'set_visibility', index: 1 });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('needs `enabled`');
      expect(snippetClient.allBuilds()).toHaveLength(0);
    });

    it('set_blend with neither opacity nor blend_mode errors', async () => {
      const tools = createFilterTools(conn.asConnection(), snippetClient);
      const res = await callTool(tools, 'ps_filter', { op: 'set_blend', index: 1 });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('at least one of `opacity` or `blend_mode`');
      expect(snippetClient.allBuilds()).toHaveLength(0);
    });

    it('index below 1 is rejected by the schema', async () => {
      const tools = createFilterTools(conn.asConnection(), snippetClient);
      const res = await callTool(tools, 'ps_filter', { op: 'remove', index: 0 });
      expect(res.isError).toBe(true);
      expect(snippetClient.allBuilds()).toHaveLength(0);
    });

    // The Go side narrows the index with int(), so a fractional index would
    // silently act on a different filter than the caller named.
    it('a fractional index is rejected rather than truncated', async () => {
      const tools = createFilterTools(conn.asConnection(), snippetClient);
      const res = await callTool(tools, 'ps_filter', { op: 'remove', index: 1.5 });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('integer');
      expect(snippetClient.allBuilds()).toHaveLength(0);
    });
  });

  describe('summaries', () => {
    it('list names each filter with its 1-based index and stack orientation', async () => {
      const tools = createFilterTools(conn.asConnection(), snippetClient);
      const res = await callTool(tools, 'ps_filter', { op: 'list' });
      const text = textOf(res);
      expect(text).toContain('2 Smart Filters');
      expect(text).toContain('1 = first applied');
      expect(text).toContain('1. Gaussian Blur...');
      expect(text).toContain('2. Add Noise...');
      expect(text).toContain('[hidden]');
    });

    it('list distinguishes "not a Smart Object" from "no filters yet"', async () => {
      const plain = makeConnection({
        result: { is_smart_object: false, count: 0, filters: [], layer_name: 'Background' },
      });
      let tools = createFilterTools(plain.asConnection(), makeSnippetClient());
      let res = await callTool(tools, 'ps_filter', { op: 'list' });
      expect(textOf(res)).toContain('is not a Smart Object');

      const empty = makeConnection({
        result: { is_smart_object: true, count: 0, filters: [], layer_name: 'Portrait' },
      });
      tools = createFilterTools(empty.asConnection(), makeSnippetClient());
      res = await callTool(tools, 'ps_filter', { op: 'list' });
      expect(textOf(res)).toContain('no Smart Filters yet');
      expect(textOf(res)).toContain('as_smart_filter=true');
    });
  });
});

describe('getSmartObjectInfoHandler (ps_inspect what=smart_object)', () => {
  it('builds getSmartObjectInfo and reports embedded storage', async () => {
    const conn = makeConnection({
      result: {
        is_smart_object: true,
        linked: false,
        file_reference: null,
        smart_filter_count: 2,
        layer_name: 'Portrait',
      },
    });
    const snippetClient = makeSnippetClient();
    const res = await getSmartObjectInfoHandler(conn.asConnection(), snippetClient);
    expect(snippetClient.lastBuild().name).toBe('getSmartObjectInfo');
    expect(textOf(res)).toContain('embedded Smart Object with 2 Smart Filters');
  });

  it('reports the backing file for a LINKED smart object', async () => {
    const conn = makeConnection({
      result: {
        is_smart_object: true,
        linked: true,
        file_reference: 'C:/art/logo.psd',
        smart_filter_count: 0,
        layer_name: 'Logo',
      },
    });
    const res = await getSmartObjectInfoHandler(conn.asConnection(), makeSnippetClient());
    expect(textOf(res)).toContain('linked to C:/art/logo.psd');
    expect(textOf(res)).toContain('0 Smart Filters');
  });

  it('says so plainly when the layer is not a Smart Object', async () => {
    const conn = makeConnection({
      result: { is_smart_object: false, layer_name: 'Background', layer_kind: 'LayerKind.NORMAL' },
    });
    const res = await getSmartObjectInfoHandler(conn.asConnection(), makeSnippetClient());
    expect(textOf(res)).toContain('is not a Smart Object');
  });
});
