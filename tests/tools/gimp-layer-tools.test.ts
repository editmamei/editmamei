import { describe, it, expect } from 'vitest';
import { createGimpLayerTools } from '@editmamei/tools/gimp-layer-tools.ts';
import { makeGimpBackend } from '../fixtures/fake-gimp-session.ts';
import { callTool, assertToolShape } from '../fixtures/tool-helpers.ts';

// `gimp_layer`'s schema is flat (one object covers every op), so `validateArgs` applies EVERY
// declared default on EVERY call regardless of which op is active — the same "a default rides
// along on an op that ignores it" behavior gimp_transform_canvas's own test file documents for
// `expand`. `fill`/`position` therefore appear in every dispatched call below. `to_top_level` gets
// the same default, but `layerBridgeArgs` always strips it before the bridge ever sees it (see its
// own tests further down) -- a tool-only field, never one of the bridge's own.
const LAYER_DEFAULTS = { fill: 'transparent', position: 0 };

describe('createGimpLayerTools', () => {
  it('returns 2 well-formed tools with these names', () => {
    const gimp = makeGimpBackend();
    const tools = createGimpLayerTools(gimp.asBackend());
    expect(tools.map((t) => t.tool.name).sort()).toEqual(['gimp_bake', 'gimp_layer']);
    assertToolShape(tools);
  });

  describe('gimp_layer', () => {
    it('requires image and op', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpLayerTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_layer', {});
      expect(result.isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });

    it('an unknown op is refused before any dispatch', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpLayerTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_layer', { image: 1, op: 'paint' });
      expect(result.isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });

    it('op=create dispatches the layer op with create fields', async () => {
      const gimp = makeGimpBackend({ result: { layer_id: 3, name: 'Backdrop', is_group: false } });
      const tools = createGimpLayerTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_layer', {
        image: 1,
        op: 'create',
        name: 'Backdrop',
        width: 100,
        height: 100,
        fill: 'white',
      });
      expect(gimp.lastCall()).toEqual({
        op: 'layer',
        args: {
          ...LAYER_DEFAULTS,
          image: 1,
          op: 'create',
          name: 'Backdrop',
          width: 100,
          height: 100,
          fill: 'white',
        },
      });
      expect(result.structuredContent).toEqual({ layer_id: 3, name: 'Backdrop', is_group: false });
    });

    it('op=create_group dispatches with create_group fields', async () => {
      const gimp = makeGimpBackend({ result: { layer_id: 4, name: 'Group A', is_group: true } });
      const tools = createGimpLayerTools(gimp.asBackend());
      await callTool(tools, 'gimp_layer', { image: 1, op: 'create_group', name: 'Group A' });
      expect(gimp.lastCall()).toEqual({
        op: 'layer',
        args: { ...LAYER_DEFAULTS, image: 1, op: 'create_group', name: 'Group A' },
      });
    });

    it('op=delete addresses by layer_id', async () => {
      const gimp = makeGimpBackend({ result: { layer_id: 5, name: 'Gone', deleted: true } });
      const tools = createGimpLayerTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_layer', { image: 1, op: 'delete', layer_id: 5 });
      expect(gimp.lastCall()).toEqual({
        op: 'layer',
        args: { ...LAYER_DEFAULTS, image: 1, op: 'delete', layer_id: 5 },
      });
      expect(result.isError).toBeFalsy();
    });

    it('op=duplicate addresses by layer (name)', async () => {
      const gimp = makeGimpBackend({
        result: { layer_id: 6, name: 'Backdrop copy', is_group: false },
      });
      const tools = createGimpLayerTools(gimp.asBackend());
      await callTool(tools, 'gimp_layer', { image: 1, op: 'duplicate', layer: 'Backdrop' });
      expect(gimp.lastCall()).toEqual({
        op: 'layer',
        args: { ...LAYER_DEFAULTS, image: 1, op: 'duplicate', layer: 'Backdrop' },
      });
    });

    it('op=duplicate refusal (an Editmamei filter on the layer) surfaces as an error result', async () => {
      const gimp = makeGimpBackend({
        throwFor: () =>
          new Error(
            "invalid_argument: cannot duplicate 'Background': it carries Editmamei filter(s) 'Curves'. " +
              'GIMP has no way to rename a copied filter in this build (DrawableFilter.set_name does not ' +
              "exist), and the ledger is keyed by filter name, so the copy's filter would silently rewrite " +
              "the original's own record the next time either is re-edited."
          ),
      });
      const tools = createGimpLayerTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_layer', {
        image: 1,
        op: 'duplicate',
        layer: 'Background',
      });
      expect(result.isError).toBe(true);
      expect((result.content?.[0] as { text: string }).text).toContain('DrawableFilter.set_name');
    });

    it('op=select dispatches with layer_id', async () => {
      const gimp = makeGimpBackend({ result: { layer_id: 2, name: 'Top' } });
      const tools = createGimpLayerTools(gimp.asBackend());
      await callTool(tools, 'gimp_layer', { image: 1, op: 'select', layer_id: 2 });
      expect(gimp.lastCall()).toEqual({
        op: 'layer',
        args: { ...LAYER_DEFAULTS, image: 1, op: 'select', layer_id: 2 },
      });
    });

    it('op=set forwards opacity/mode/visible/name together', async () => {
      const gimp = makeGimpBackend({
        result: { layer_id: 2, name: 'Renamed', opacity: 50, mode: 'multiply', visible: false },
      });
      const tools = createGimpLayerTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_layer', {
        image: 1,
        op: 'set',
        layer_id: 2,
        opacity: 50,
        mode: 'multiply',
        visible: false,
        name: 'Renamed',
      });
      expect(gimp.lastCall()).toEqual({
        op: 'layer',
        args: {
          ...LAYER_DEFAULTS,
          image: 1,
          op: 'set',
          layer_id: 2,
          opacity: 50,
          mode: 'multiply',
          visible: false,
          name: 'Renamed',
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it('rejects a mode outside the fixed blend-mode enum', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpLayerTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_layer', {
        image: 1,
        op: 'set',
        layer_id: 2,
        mode: 'vivid-light',
      });
      expect(result.isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });

    it('op=move dispatches x/y as absolute offsets', async () => {
      const gimp = makeGimpBackend({ result: { layer_id: 2, x: 10, y: 20 } });
      const tools = createGimpLayerTools(gimp.asBackend());
      await callTool(tools, 'gimp_layer', { image: 1, op: 'move', layer_id: 2, x: 10, y: 20 });
      expect(gimp.lastCall()).toEqual({
        op: 'layer',
        args: { ...LAYER_DEFAULTS, image: 1, op: 'move', layer_id: 2, x: 10, y: 20 },
      });
    });

    it('op=move refusal (masked filter) surfaces as an error result', async () => {
      const gimp = makeGimpBackend({
        throwFor: () =>
          new Error(
            "invalid_argument: move would misalign the masked adjustment(s) 'Brightness Contrast': " +
              "a filter's mask does not travel with the layer it is on."
          ),
      });
      const tools = createGimpLayerTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_layer', {
        image: 1,
        op: 'move',
        layer_id: 2,
        x: 1,
        y: 1,
      });
      expect(result.isError).toBe(true);
      expect((result.content?.[0] as { text: string }).text).toContain('masked adjustment');
    });

    it('op=reorder forwards parent_group and position', async () => {
      const gimp = makeGimpBackend({ result: { layer_id: 3, parent_group: 6 } });
      const tools = createGimpLayerTools(gimp.asBackend());
      await callTool(tools, 'gimp_layer', {
        image: 1,
        op: 'reorder',
        layer_id: 3,
        parent_group: 6,
        position: 0,
      });
      expect(gimp.lastCall()).toEqual({
        op: 'layer',
        args: {
          ...LAYER_DEFAULTS,
          image: 1,
          op: 'reorder',
          layer_id: 3,
          parent_group: 6,
          position: 0,
        },
      });
    });

    // `validateArgs` collapses an explicit `null` straight to "absent" (see its own doc comment),
    // so the schema cannot carry "parent_group: null" through from the MCP client -- to_top_level
    // is the tri-state escape hatch the tool layer translates into that explicit null instead.
    it('op=reorder with to_top_level sends parent_group: null (not omitted) to the bridge', async () => {
      const gimp = makeGimpBackend({ result: { layer_id: 3, parent_group: null } });
      const tools = createGimpLayerTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_layer', {
        image: 1,
        op: 'reorder',
        layer_id: 3,
        to_top_level: true,
      });
      expect(result.isError).toBeFalsy();
      const call = gimp.lastCall();
      expect(call.op).toBe('layer');
      expect('parent_group' in call.args).toBe(true);
      expect(call.args.parent_group).toBeNull();
      expect('to_top_level' in call.args).toBe(false);
    });

    it('op=reorder with neither parent_group nor to_top_level sends no parent_group key at all', async () => {
      const gimp = makeGimpBackend({ result: { layer_id: 3, parent_group: 6 } });
      const tools = createGimpLayerTools(gimp.asBackend());
      await callTool(tools, 'gimp_layer', { image: 1, op: 'reorder', layer_id: 3, position: 1 });
      const call = gimp.lastCall();
      expect('parent_group' in call.args).toBe(false);
    });

    it('op=merge_down reports a rasterized text layer in the success text', async () => {
      const gimp = makeGimpBackend({
        result: { layer_id: 7, name: 'Bottom', rasterized_text: true },
      });
      const tools = createGimpLayerTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_layer', {
        image: 1,
        op: 'merge_down',
        layer_id: 8,
      });
      expect(gimp.lastCall()).toEqual({
        op: 'layer',
        args: { ...LAYER_DEFAULTS, image: 1, op: 'merge_down', layer_id: 8 },
      });
      expect((result.content?.[0] as { text: string }).text).toContain('rasterized');
    });

    it('op=flatten needs no layer addressing and reports alpha dropped', async () => {
      const gimp = makeGimpBackend({
        result: { layer_id: 9, name: 'Background', rasterized_text: false, has_alpha: false },
      });
      const tools = createGimpLayerTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_layer', { image: 1, op: 'flatten' });
      expect(gimp.lastCall()).toEqual({
        op: 'layer',
        args: { ...LAYER_DEFAULTS, image: 1, op: 'flatten' },
      });
      expect((result.content?.[0] as { text: string }).text).toContain('alpha dropped');
    });
  });

  describe('gimp_bake', () => {
    it('requires image', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpLayerTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_bake', {});
      expect(result.isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });

    it('bakes one layer by layer_id', async () => {
      const gimp = makeGimpBackend({ result: { layer_id: 2, name: 'Background', baked: true } });
      const tools = createGimpLayerTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_bake', { image: 1, layer_id: 2 });
      expect(gimp.lastCall()).toEqual({ op: 'bake', args: { image: 1, layer_id: 2, all: false } });
      expect((result.content?.[0] as { text: string }).text).toContain('Baked every filter');
    });

    it('reports a no-op bake (nothing to bake) distinctly', async () => {
      const gimp = makeGimpBackend({ result: { layer_id: 2, name: 'Background', baked: false } });
      const tools = createGimpLayerTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_bake', { image: 1, layer: 'Background' });
      expect((result.content?.[0] as { text: string }).text).toContain(
        'had no live filter to bake'
      );
    });

    it('all: true bakes every layer and lists the baked names', async () => {
      const gimp = makeGimpBackend({
        result: {
          baked_layers: [
            { layer_id: 2, name: 'Background' },
            { layer_id: 3, name: 'Top' },
          ],
        },
      });
      const tools = createGimpLayerTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_bake', { image: 1, all: true });
      expect(gimp.lastCall()).toEqual({ op: 'bake', args: { image: 1, all: true } });
      const text = (result.content?.[0] as { text: string }).text;
      expect(text).toContain('Baked 2 layer(s)');
      expect(text).toContain('Background');
      expect(text).toContain('Top');
    });

    it('all: true with nothing to bake says so', async () => {
      const gimp = makeGimpBackend({ result: { baked_layers: [] } });
      const tools = createGimpLayerTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_bake', { image: 1, all: true });
      expect((result.content?.[0] as { text: string }).text).toBe(
        'No layer had a live filter to bake.'
      );
    });
  });
});
