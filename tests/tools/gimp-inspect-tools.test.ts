import { describe, it, expect } from 'vitest';
import { createGimpInspectTools } from '@editmamei/tools/gimp-inspect-tools.ts';
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
    const gimp = makeGimpBackend({
      result: {
        image: 5,
        width: 100,
        height: 50,
        base_type: 'rgb',
        precision: 'u8-non-linear',
        resolution: { x: 72, y: 72 },
        layers: layerTree,
        channels: [],
      },
    });
    const tools = createGimpInspectTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_inspect', { what: 'document', image: 5 });
    expect(gimp.lastCall()).toEqual({ op: 'describe', args: { what: 'document', image: 5 } });
    expect(result.isError).toBeFalsy();
    expect((result.content?.[0] as { text: string }).text).toBe(
      'Document 5: 100x50 rgb u8-non-linear, 1 top-level layer(s), 0 channel(s).'
    );
    expect(result.structuredContent).toEqual({
      what: 'document',
      image: 5,
      width: 100,
      height: 50,
      base_type: 'rgb',
      precision: 'u8-non-linear',
      resolution: { x: 72, y: 72 },
      layers: layerTree,
      channels: [],
    });
  });

  it("what='layers' dispatches describe with image and reports the top-level layer count", async () => {
    const gimp = makeGimpBackend({
      result: {
        layers: [
          { layer_id: 1, name: 'A' },
          { layer_id: 2, name: 'B' },
        ],
      },
    });
    const tools = createGimpInspectTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_inspect', { what: 'layers', image: 5 });
    expect(gimp.lastCall()).toEqual({ op: 'describe', args: { what: 'layers', image: 5 } });
    expect((result.content?.[0] as { text: string }).text).toBe('2 top-level layer(s) on image 5.');
  });

  it("what='channels' dispatches describe with image and reports the channel count", async () => {
    const gimp = makeGimpBackend({
      result: { channels: [{ name: 'Mask', selected_pixels: 10, fraction: 0.5 }] },
    });
    const tools = createGimpInspectTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_inspect', { what: 'channels', image: 5 });
    expect(gimp.lastCall()).toEqual({ op: 'describe', args: { what: 'channels', image: 5 } });
    expect((result.content?.[0] as { text: string }).text).toBe('1 channel(s) on image 5.');
  });

  it("what='filter' dispatches describe with image and filter_id, in gimp_filter op=list's own shape", async () => {
    const gimp = makeGimpBackend({
      result: {
        layer: 'Background',
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
      },
    });
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
      throwFor: () => new Error('invalid_argument: image is required'),
    });
    const tools = createGimpInspectTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_inspect', { what: 'document' });
    expect(result.isError).toBe(true);
    expect((result.content?.[0] as { text: string }).text).toContain('image is required');
  });
});
