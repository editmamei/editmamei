import { describe, it, expect } from 'vitest';
import { createGimpInspectTools } from '@editmamei/tools/gimp-inspect-tools.ts';
import { GimpError } from '@editmamei/backends/gimp/errors.ts';
import { makeGimpBackend } from '../fixtures/fake-gimp-session.ts';
import { callTool, assertToolShape } from '../fixtures/tool-helpers.ts';

describe('createGimpInspectTools', () => {
  it('returns 1 well-formed tool with this name', () => {
    const gimp = makeGimpBackend();
    const tools = createGimpInspectTools(gimp.asBackend());
    expect(tools.map((t) => t.tool.name)).toEqual(['gimp_inspect']);
    assertToolShape(tools);
  });

  it('requires what', async () => {
    const gimp = makeGimpBackend();
    const tools = createGimpInspectTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_inspect', {});
    expect(result.isError).toBe(true);
    expect(gimp.calls).toHaveLength(0);
  });

  it("what='documents' dispatches ping and reports the open image ids", async () => {
    const gimp = makeGimpBackend({ result: { images: [4, 5] } });
    const tools = createGimpInspectTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_inspect', { what: 'documents' });
    expect(gimp.lastCall()).toEqual({ op: 'ping', args: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      what: 'documents',
      documents: [{ image: 4 }, { image: 5 }],
    });
  });

  it("what='document' dispatches describe with image and reports a one-line summary", async () => {
    const layerTree = [
      {
        layer_id: 1,
        name: 'Background',
        opacity: 100,
        mode: 'normal',
        visible: true,
        offsets: { x: 0, y: 0 },
        has_alpha: false,
        is_group: false,
        is_text_layer: false,
        children: [],
      },
    ];
    const documentResult = {
      image: 5,
      width: 100,
      height: 50,
      base_type: 'rgb',
      precision: 'u8-non-linear',
      resolution: { x: 72, y: 72 },
      layers: layerTree,
      truncated: false,
      top_level_count: 1,
      total_nodes: 1,
      // 'document' channels are id/name only -- no coverage (that's what='channels'' job).
      channels: [{ channel_id: 9, name: 'HalfMask' }],
    };
    const gimp = makeGimpBackend({ result: documentResult });
    const tools = createGimpInspectTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_inspect', { what: 'document', image: 5 });
    expect(gimp.lastCall()).toEqual({ op: 'describe', args: { what: 'document', image: 5 } });
    expect(result.isError).toBeFalsy();
    expect((result.content?.[0] as { text: string }).text).toBe(
      'Document 5: 100x50 rgb u8-non-linear, 1 top-level layer(s), 1 channel(s).'
    );
    expect(result.structuredContent).toEqual({ what: 'document', ...documentResult });
  });

  it("what='document' notes truncation in the summary when the bridge reports it", async () => {
    const gimp = makeGimpBackend({
      result: {
        image: 5,
        width: 1,
        height: 1,
        base_type: 'rgb',
        precision: 'u8-non-linear',
        resolution: { x: 72, y: 72 },
        layers: [],
        truncated: true,
        top_level_count: 0,
        total_nodes: 0,
        channels: [],
      },
    });
    const tools = createGimpInspectTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_inspect', { what: 'document', image: 5 });
    expect((result.content?.[0] as { text: string }).text).toContain('(truncated at the node cap)');
  });

  it("what='document' summary reports top_level_count, not just the (possibly truncated) layers array's own length", async () => {
    // A truncated tree can still carry a handful of top-level nodes while top_level_count says
    // the real total is much larger -- the summary must say the real count, not len(layers).
    const gimp = makeGimpBackend({
      result: {
        image: 5,
        width: 1,
        height: 1,
        base_type: 'rgb',
        precision: 'u8-non-linear',
        resolution: { x: 72, y: 72 },
        layers: [{ layer_id: 1, name: 'A' }],
        truncated: true,
        top_level_count: 50,
        total_nodes: 2000,
        channels: [],
      },
    });
    const tools = createGimpInspectTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_inspect', { what: 'document', image: 5 });
    expect((result.content?.[0] as { text: string }).text).toContain(
      '50 top-level layer(s) (truncated at the node cap)'
    );
  });

  it("what='layers' dispatches describe with image, passes truncated through, and reports the top-level layer count", async () => {
    const layersResult = {
      layers: [
        { layer_id: 1, name: 'A' },
        { layer_id: 2, name: 'B' },
      ],
      truncated: true,
      top_level_count: 2,
      total_nodes: 2,
    };
    const gimp = makeGimpBackend({ result: layersResult });
    const tools = createGimpInspectTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_inspect', { what: 'layers', image: 5 });
    expect(gimp.lastCall()).toEqual({ op: 'describe', args: { what: 'layers', image: 5 } });
    expect((result.content?.[0] as { text: string }).text).toBe(
      '2 top-level layer(s) on image 5 (truncated at the node cap).'
    );
    expect(result.structuredContent).toEqual({ what: 'layers', ...layersResult });
  });

  it("what='layers' summary reports top_level_count over the truncated layers array's own length", async () => {
    const gimp = makeGimpBackend({
      result: {
        layers: [{ layer_id: 1, name: 'A' }],
        truncated: true,
        top_level_count: 50,
        total_nodes: 2000,
      },
    });
    const tools = createGimpInspectTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_inspect', { what: 'layers', image: 5 });
    expect((result.content?.[0] as { text: string }).text).toBe(
      '50 top-level layer(s) on image 5 (truncated at the node cap).'
    );
  });

  it("what='channels' dispatches describe with image and reports the channel count, with coverage in structuredContent", async () => {
    const channelsResult = {
      channels: [{ channel_id: 9, name: 'Mask', selected_pixels: 10, fraction: 0.5 }],
    };
    const gimp = makeGimpBackend({ result: channelsResult });
    const tools = createGimpInspectTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_inspect', { what: 'channels', image: 5 });
    expect(gimp.lastCall()).toEqual({ op: 'describe', args: { what: 'channels', image: 5 } });
    expect((result.content?.[0] as { text: string }).text).toBe('1 channel(s) on image 5.');
    expect(result.structuredContent).toEqual({ what: 'channels', ...channelsResult });
  });

  it("what='filter' dispatches describe with image and filter_id, in gimp_filter op=list's own shape (including layer_id)", async () => {
    const filterResult = {
      layer: 'Background',
      layer_id: 3,
      filter_id: 7,
      name: 'Curves',
      operation: 'gimp:curves',
      type: 'curves',
      visible: true,
      source: 'editmamei',
      mask: null,
      params: {
        channel: 'value',
        points: [
          [0, 0],
          [255, 255],
        ],
      },
    };
    const gimp = makeGimpBackend({ result: filterResult });
    const tools = createGimpInspectTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_inspect', {
      what: 'filter',
      image: 5,
      filter_id: 7,
    });
    expect(gimp.lastCall()).toEqual({
      op: 'describe',
      args: { what: 'filter', image: 5, filter_id: 7 },
    });
    expect((result.content?.[0] as { text: string }).text).toBe(
      'Filter 7 ("Curves"): gimp:curves.'
    );
    expect(result.structuredContent).toEqual({ what: 'filter', ...filterResult });
  });

  it('a what outside the enum is refused before any dispatch', async () => {
    const gimp = makeGimpBackend();
    const tools = createGimpInspectTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_inspect', { what: 'bogus' });
    expect(result.isError).toBe(true);
    expect(gimp.calls).toHaveLength(0);
  });

  it('maps a bridge invalid_argument error (e.g. a missing image) through toolGimpErrorResult', async () => {
    const gimp = makeGimpBackend({
      throwFor: () => new GimpError('invalid_argument', 'image is required'),
    });
    const tools = createGimpInspectTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_inspect', { what: 'document' });
    expect(result.isError).toBe(true);
    expect((result.content?.[0] as { text: string }).text).toContain('image is required');
  });
});
