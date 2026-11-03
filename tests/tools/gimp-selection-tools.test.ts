import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGimpSelectionTools } from '@editmamei/tools/gimp-selection-tools.ts';
import { FakeGimpBackend, makeGimpBackend } from '../fixtures/fake-gimp-session.ts';
import { callTool, assertToolShape } from '../fixtures/tool-helpers.ts';

const scratchDir = mkdtempSync(join(tmpdir(), 'gimp-selection-tools-test-'));
afterAll(() => rmSync(scratchDir, { recursive: true, force: true }));

const allow = () => true;
const deny = () => false;

/** A fake backend whose tempPath() points at a real file this test controls, the same trick
 * gimp-verify-tools.test.ts uses for gimp_get_preview: `selectionPreview` reads the bytes back
 * with `readRender`, so the path has to resolve to something real rather than the fixture's fake
 * `/fake/gimp/...` string. */
function makeGimpBackendWithRealPaths(
  opts: Parameters<typeof makeGimpBackend>[0] = {}
): FakeGimpBackend {
  const gimp = makeGimpBackend(opts);
  gimp.tempPath = (name: string) => {
    const p = join(scratchDir, name);
    writeFileSync(p, Buffer.from([0xff, 0xd8, 0xff, 0xd9])); // minimal JPEG SOI/EOI
    return p;
  };
  return gimp;
}

describe('createGimpSelectionTools', () => {
  it('returns 4 well-formed tools with these names', () => {
    const gimp = makeGimpBackend();
    const tools = createGimpSelectionTools(gimp.asBackend());
    expect(tools.map((t) => t.tool.name).sort()).toEqual([
      'gimp_get_selection_preview',
      'gimp_layer_mask',
      'gimp_modify_selection',
      'gimp_select',
    ]);
    assertToolShape(tools);
  });

  describe('gimp_select', () => {
    it('requires image and mode', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpSelectionTools(gimp.asBackend());
      expect((await callTool(tools, 'gimp_select', { mode: 'all' })).isError).toBe(true);
      expect((await callTool(tools, 'gimp_select', { image: 1 })).isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });

    it('rejects a mode outside the fixed enum before dispatch', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpSelectionTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_select', { image: 1, mode: 'lasso' });
      expect(result.isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });

    it('rejects a combine outside the fixed enum before dispatch', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpSelectionTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_select', {
        image: 1,
        mode: 'all',
        combine: 'xor',
      });
      expect(result.isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });

    it('rejects a threshold outside 0-255 before dispatch', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpSelectionTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_select', {
        image: 1,
        mode: 'color_range',
        color: '#ffffff',
        threshold: 300,
      });
      expect(result.isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });

    it('rejects a color that is not a well-formed "#rrggbb" hex string before dispatch', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpSelectionTools(gimp.asBackend());
      for (const bad of ['red', '#fff', '#gggggg', 'c0392b']) {
        const result = await callTool(tools, 'gimp_select', {
          image: 1,
          mode: 'color_range',
          color: bad,
        });
        expect(result.isError, bad).toBe(true);
      }
      expect(gimp.calls).toHaveLength(0);
    });

    it('mode=all dispatches with defaults applied (name, combine, threshold, sample_merged, invert, feather_px)', async () => {
      const gimp = makeGimpBackend({
        result: { channel: 'Selection', selected_pixels: 100, fraction: 1 },
      });
      const tools = createGimpSelectionTools(gimp.asBackend());
      await callTool(tools, 'gimp_select', { image: 1, mode: 'all' });
      expect(gimp.lastCall()).toEqual({
        op: 'select',
        args: {
          image: 1,
          mode: 'all',
          name: 'Selection',
          combine: 'replace',
          threshold: 15,
          sample_merged: true,
          invert: false,
          feather_px: 0,
        },
      });
    });

    it('mode=rectangle forwards x/y/width/height', async () => {
      const gimp = makeGimpBackend({
        result: { channel: 'Selection', selected_pixels: 50, fraction: 0.5 },
      });
      const tools = createGimpSelectionTools(gimp.asBackend());
      await callTool(tools, 'gimp_select', {
        image: 1,
        mode: 'rectangle',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
      });
      expect(gimp.lastCall().args).toMatchObject({
        mode: 'rectangle',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
      });
    });

    it('mode=ellipse forwards x/y/width/height', async () => {
      const gimp = makeGimpBackend({ result: {} });
      const tools = createGimpSelectionTools(gimp.asBackend());
      await callTool(tools, 'gimp_select', {
        image: 1,
        mode: 'ellipse',
        x: 1,
        y: 2,
        width: 3,
        height: 4,
      });
      expect(gimp.lastCall().args).toMatchObject({
        mode: 'ellipse',
        x: 1,
        y: 2,
        width: 3,
        height: 4,
      });
    });

    it('mode=polygon forwards points', async () => {
      const gimp = makeGimpBackend({ result: {} });
      const tools = createGimpSelectionTools(gimp.asBackend());
      const points = [
        [0, 0],
        [10, 0],
        [10, 10],
      ];
      await callTool(tools, 'gimp_select', { image: 1, mode: 'polygon', points });
      expect(gimp.lastCall().args).toMatchObject({ mode: 'polygon', points });
    });

    it('mode=color_range forwards color and threshold', async () => {
      const gimp = makeGimpBackend({ result: {} });
      const tools = createGimpSelectionTools(gimp.asBackend());
      await callTool(tools, 'gimp_select', {
        image: 1,
        mode: 'color_range',
        color: '#c0392b',
        threshold: 30,
      });
      expect(gimp.lastCall().args).toMatchObject({
        mode: 'color_range',
        color: '#c0392b',
        threshold: 30,
      });
    });

    it('mode=color_range forwards a sample point (x, y) instead of color', async () => {
      const gimp = makeGimpBackend({ result: {} });
      const tools = createGimpSelectionTools(gimp.asBackend());
      await callTool(tools, 'gimp_select', { image: 1, mode: 'color_range', x: 5, y: 6 });
      expect(gimp.lastCall().args).toMatchObject({ mode: 'color_range', x: 5, y: 6 });
      expect('color' in gimp.lastCall().args).toBe(false);
    });

    it('mode=color_range forwards sample_merged: false', async () => {
      const gimp = makeGimpBackend({ result: {} });
      const tools = createGimpSelectionTools(gimp.asBackend());
      await callTool(tools, 'gimp_select', {
        image: 1,
        mode: 'color_range',
        x: 5,
        y: 6,
        sample_merged: false,
      });
      expect(gimp.lastCall().args).toMatchObject({ sample_merged: false });
    });

    it('mode=magic_wand forwards x/y and layer', async () => {
      const gimp = makeGimpBackend({ result: {} });
      const tools = createGimpSelectionTools(gimp.asBackend());
      await callTool(tools, 'gimp_select', {
        image: 1,
        mode: 'magic_wand',
        x: 12,
        y: 34,
        layer: 'Subject',
      });
      expect(gimp.lastCall().args).toMatchObject({
        mode: 'magic_wand',
        x: 12,
        y: 34,
        layer: 'Subject',
      });
    });

    it('mode=alpha forwards layer_id, taking priority over layer per the shared convention', async () => {
      const gimp = makeGimpBackend({ result: {} });
      const tools = createGimpSelectionTools(gimp.asBackend());
      await callTool(tools, 'gimp_select', { image: 1, mode: 'alpha', layer_id: 42 });
      expect(gimp.lastCall().args).toMatchObject({ mode: 'alpha', layer_id: 42 });
    });

    it('rejects a layer_id below the shared minimum (1) before dispatch', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpSelectionTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_select', { image: 1, mode: 'alpha', layer_id: 0 });
      expect(result.isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });

    it('mode=channel forwards source', async () => {
      const gimp = makeGimpBackend({ result: {} });
      const tools = createGimpSelectionTools(gimp.asBackend());
      await callTool(tools, 'gimp_select', { image: 1, mode: 'channel', source: 'Sky' });
      expect(gimp.lastCall().args).toMatchObject({ mode: 'channel', source: 'Sky' });
    });

    it('mode=gradient_linear forwards x1/y1/x2/y2', async () => {
      const gimp = makeGimpBackend({
        result: { channel: 'Grad', selected_pixels: 0, fraction: 0 },
      });
      const tools = createGimpSelectionTools(gimp.asBackend());
      await callTool(tools, 'gimp_select', {
        image: 1,
        mode: 'gradient_linear',
        x1: 0,
        y1: 0,
        x2: 100,
        y2: 0,
        name: 'Grad',
      });
      expect(gimp.lastCall().args).toMatchObject({
        mode: 'gradient_linear',
        x1: 0,
        y1: 0,
        x2: 100,
        y2: 0,
        name: 'Grad',
      });
    });

    it('mode=gradient_radial forwards cx/cy/radius and invert', async () => {
      const gimp = makeGimpBackend({
        result: { channel: 'Vignette', selected_pixels: 0, fraction: 0 },
      });
      const tools = createGimpSelectionTools(gimp.asBackend());
      await callTool(tools, 'gimp_select', {
        image: 1,
        mode: 'gradient_radial',
        cx: 50,
        cy: 50,
        radius: 30,
        name: 'Vignette',
        invert: true,
      });
      expect(gimp.lastCall().args).toMatchObject({
        mode: 'gradient_radial',
        cx: 50,
        cy: 50,
        radius: 30,
        name: 'Vignette',
        invert: true,
      });
    });

    it('forwards a non-default combine (add/subtract/intersect) and a custom name', async () => {
      const gimp = makeGimpBackend({ result: {} });
      const tools = createGimpSelectionTools(gimp.asBackend());
      await callTool(tools, 'gimp_select', {
        image: 1,
        mode: 'all',
        name: 'Subject',
        combine: 'intersect',
      });
      expect(gimp.lastCall().args).toMatchObject({ name: 'Subject', combine: 'intersect' });
    });

    it('forwards invert and feather_px', async () => {
      const gimp = makeGimpBackend({ result: {} });
      const tools = createGimpSelectionTools(gimp.asBackend());
      await callTool(tools, 'gimp_select', { image: 1, mode: 'all', invert: true, feather_px: 12 });
      expect(gimp.lastCall().args).toMatchObject({ invert: true, feather_px: 12 });
    });

    it('success text and structuredContent report the channel and fraction', async () => {
      const gimp = makeGimpBackend({
        result: { channel: 'Subject', selected_pixels: 750, fraction: 0.75 },
      });
      const tools = createGimpSelectionTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_select', { image: 1, mode: 'all' });
      expect(result.isError).toBeFalsy();
      expect((result.content?.[0] as { text: string }).text).toBe(
        'Channel "Subject" — 75.0% of pixels selected.'
      );
      expect(result.structuredContent).toEqual({
        channel: 'Subject',
        selected_pixels: 750,
        fraction: 0.75,
      });
    });

    it('a bridge refusal (e.g. unknown source channel) surfaces as an error result', async () => {
      const gimp = makeGimpBackend({
        throwFor: () => new Error("invalid_argument: no channel named 'Sky'"),
      });
      const tools = createGimpSelectionTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_select', {
        image: 1,
        mode: 'channel',
        source: 'Sky',
      });
      expect(result.isError).toBe(true);
      expect((result.content?.[0] as { text: string }).text).toContain("no channel named 'Sky'");
    });
  });

  describe('gimp_modify_selection', () => {
    it('requires image, channel, and op', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpSelectionTools(gimp.asBackend());
      expect(
        (await callTool(tools, 'gimp_modify_selection', { channel: 'Mask', op: 'expand' })).isError
      ).toBe(true);
      expect(
        (await callTool(tools, 'gimp_modify_selection', { image: 1, op: 'expand' })).isError
      ).toBe(true);
      expect(
        (await callTool(tools, 'gimp_modify_selection', { image: 1, channel: 'Mask' })).isError
      ).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });

    it('rejects an op outside the fixed enum before dispatch', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpSelectionTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_modify_selection', {
        image: 1,
        channel: 'Mask',
        op: 'dilate',
      });
      expect(result.isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });

    it('rejects px outside 0-1000 before dispatch', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpSelectionTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_modify_selection', {
        image: 1,
        channel: 'Mask',
        op: 'expand',
        px: 1001,
      });
      expect(result.isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });

    it.each(['expand', 'contract', 'border', 'feather', 'smooth', 'invert', 'harden'])(
      'dispatches op=%s with no px key at all when omitted (the schema declares no default; the ' +
        'bridge validates px itself for expand/contract/border/feather)',
      async (op) => {
        const gimp = makeGimpBackend({
          result: { channel: 'Mask', selected_pixels: 1, fraction: 0.01 },
        });
        const tools = createGimpSelectionTools(gimp.asBackend());
        await callTool(tools, 'gimp_modify_selection', { image: 1, channel: 'Mask', op });
        expect(gimp.lastCall()).toEqual({
          op: 'modify_mask',
          args: { image: 1, channel: 'Mask', op },
        });
      }
    );

    it('forwards a non-zero px', async () => {
      const gimp = makeGimpBackend({ result: {} });
      const tools = createGimpSelectionTools(gimp.asBackend());
      await callTool(tools, 'gimp_modify_selection', {
        image: 1,
        channel: 'Mask',
        op: 'expand',
        px: 8,
      });
      expect(gimp.lastCall().args).toMatchObject({ px: 8 });
    });

    it('forwards output, writing to a different channel than the source', async () => {
      const gimp = makeGimpBackend({ result: {} });
      const tools = createGimpSelectionTools(gimp.asBackend());
      await callTool(tools, 'gimp_modify_selection', {
        image: 1,
        channel: 'Mask',
        op: 'invert',
        output: 'MaskInverted',
      });
      expect(gimp.lastCall()).toEqual({
        op: 'modify_mask',
        args: { image: 1, channel: 'Mask', op: 'invert', output: 'MaskInverted' },
      });
    });

    it('success text and structuredContent report the channel and fraction', async () => {
      const gimp = makeGimpBackend({
        result: { channel: 'Mask', selected_pixels: 200, fraction: 0.2 },
      });
      const tools = createGimpSelectionTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_modify_selection', {
        image: 1,
        channel: 'Mask',
        op: 'contract',
        px: 5,
      });
      expect((result.content?.[0] as { text: string }).text).toBe(
        'Channel "Mask" — 20.0% of pixels selected.'
      );
      expect(result.structuredContent).toEqual({
        channel: 'Mask',
        selected_pixels: 200,
        fraction: 0.2,
      });
    });

    it('maps a bridge refusal (mask already in use) through toolGimpErrorResult', async () => {
      const gimp = makeGimpBackend({
        throwFor: () =>
          new Error("invalid_argument: mask 'Mask' is already used by an existing filter"),
      });
      const tools = createGimpSelectionTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_modify_selection', {
        image: 1,
        channel: 'Mask',
        op: 'expand',
        px: 4,
      });
      expect(result.isError).toBe(true);
      expect((result.content?.[0] as { text: string }).text).toContain('already used');
    });

    it('maps a bridge px-required-or-capped refusal through toolGimpErrorResult', async () => {
      const gimp = makeGimpBackend({
        throwFor: () => new Error('invalid_argument: px must be greater than 0 and at most 150'),
      });
      const tools = createGimpSelectionTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_modify_selection', {
        image: 1,
        channel: 'Mask',
        op: 'border',
        px: 5,
      });
      expect(result.isError).toBe(true);
      expect((result.content?.[0] as { text: string }).text).toContain('at most 150');
    });

    it('a missing channel surfaces as an error result', async () => {
      const gimp = makeGimpBackend({
        throwFor: () => new Error("invalid_argument: no channel named 'Ghost'"),
      });
      const tools = createGimpSelectionTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_modify_selection', {
        image: 1,
        channel: 'Ghost',
        op: 'expand',
        px: 4,
      });
      expect(result.isError).toBe(true);
      expect((result.content?.[0] as { text: string }).text).toContain("no channel named 'Ghost'");
    });
  });

  describe('gimp_layer_mask', () => {
    it('requires image and op', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpSelectionTools(gimp.asBackend());
      expect((await callTool(tools, 'gimp_layer_mask', { image: 1 })).isError).toBe(true);
      expect((await callTool(tools, 'gimp_layer_mask', { op: 'create' })).isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });

    it('rejects an op outside the fixed enum before dispatch', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpSelectionTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_layer_mask', { image: 1, op: 'duplicate' });
      expect(result.isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });

    it('rejects a source outside the fixed enum before dispatch', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpSelectionTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_layer_mask', {
        image: 1,
        op: 'create',
        source: 'rainbow',
      });
      expect(result.isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });

    it('op=create dispatches with source defaulted to channel and invert to false', async () => {
      const gimp = makeGimpBackend({
        result: { layer: 'Background', layer_id: 1, op: 'create', has_mask: true },
      });
      const tools = createGimpSelectionTools(gimp.asBackend());
      await callTool(tools, 'gimp_layer_mask', { image: 1, op: 'create', channel: 'Subject' });
      expect(gimp.lastCall()).toEqual({
        op: 'layer_mask',
        args: { image: 1, op: 'create', channel: 'Subject', source: 'channel', invert: false },
      });
    });

    it.each(['white', 'black', 'alpha', 'grayscale'])(
      'op=create forwards source=%s',
      async (source) => {
        const gimp = makeGimpBackend({
          result: { layer: 'Background', layer_id: 1, op: 'create', has_mask: true },
        });
        const tools = createGimpSelectionTools(gimp.asBackend());
        await callTool(tools, 'gimp_layer_mask', { image: 1, op: 'create', source });
        expect(gimp.lastCall().args).toMatchObject({ source });
      }
    );

    it('op=create forwards invert=true', async () => {
      const gimp = makeGimpBackend({ result: {} });
      const tools = createGimpSelectionTools(gimp.asBackend());
      await callTool(tools, 'gimp_layer_mask', {
        image: 1,
        op: 'create',
        channel: 'Subject',
        invert: true,
      });
      expect(gimp.lastCall().args).toMatchObject({ invert: true });
    });

    it.each(['delete', 'apply', 'invert'])(
      'op=%s dispatches with only image and op (plus defaults)',
      async (op) => {
        const gimp = makeGimpBackend({
          result: { layer: 'Background', layer_id: 1, op, has_mask: op !== 'delete' },
        });
        const tools = createGimpSelectionTools(gimp.asBackend());
        await callTool(tools, 'gimp_layer_mask', { image: 1, op });
        expect(gimp.lastCall()).toEqual({
          op: 'layer_mask',
          args: { image: 1, op, source: 'channel', invert: false },
        });
      }
    );

    it('forwards layer and layer_id', async () => {
      const gimp = makeGimpBackend({ result: {} });
      const tools = createGimpSelectionTools(gimp.asBackend());
      await callTool(tools, 'gimp_layer_mask', { image: 1, op: 'apply', layer: 'Photo' });
      expect(gimp.lastCall().args).toMatchObject({ layer: 'Photo' });

      const gimp2 = makeGimpBackend({ result: {} });
      const tools2 = createGimpSelectionTools(gimp2.asBackend());
      await callTool(tools2, 'gimp_layer_mask', { image: 1, op: 'apply', layer_id: 7 });
      expect(gimp2.lastCall().args).toMatchObject({ layer_id: 7 });
    });

    it('success text reports the layer, op, and whether a mask remains', async () => {
      const gimp = makeGimpBackend({
        result: { layer: 'Photo', layer_id: 2, op: 'create', has_mask: true },
      });
      const tools = createGimpSelectionTools(gimp.asBackend());
      const created = await callTool(tools, 'gimp_layer_mask', {
        image: 1,
        op: 'create',
        channel: 'Subject',
      });
      expect((created.content?.[0] as { text: string }).text).toBe(
        'Layer "Photo": create done (has mask).'
      );
      expect(created.structuredContent).toEqual({
        layer: 'Photo',
        layer_id: 2,
        op: 'create',
        has_mask: true,
      });

      const gimpDeleted = makeGimpBackend({
        result: { layer: 'Photo', layer_id: 2, op: 'delete', has_mask: false },
      });
      const toolsDeleted = createGimpSelectionTools(gimpDeleted.asBackend());
      const deleted = await callTool(toolsDeleted, 'gimp_layer_mask', { image: 1, op: 'delete' });
      expect((deleted.content?.[0] as { text: string }).text).toBe(
        'Layer "Photo": delete done (no mask).'
      );
    });

    it('a layer with no mask (delete/apply/invert) surfaces as an error result', async () => {
      const gimp = makeGimpBackend({
        throwFor: () => new Error("invalid_argument: layer 'Photo' has no mask"),
      });
      const tools = createGimpSelectionTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_layer_mask', { image: 1, op: 'invert' });
      expect(result.isError).toBe(true);
      expect((result.content?.[0] as { text: string }).text).toContain('has no mask');
    });

    it('an unknown source channel surfaces as an error result', async () => {
      const gimp = makeGimpBackend({
        throwFor: () => new Error("invalid_argument: no channel named 'Ghost'"),
      });
      const tools = createGimpSelectionTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_layer_mask', {
        image: 1,
        op: 'create',
        channel: 'Ghost',
      });
      expect(result.isError).toBe(true);
      expect((result.content?.[0] as { text: string }).text).toContain("no channel named 'Ghost'");
    });
  });

  describe('gimp_get_selection_preview', () => {
    it('requires image and channel, without ever dispatching', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpSelectionTools(gimp.asBackend(), { previewsAllowed: allow });
      expect((await callTool(tools, 'gimp_get_selection_preview', { image: 1 })).isError).toBe(
        true
      );
      expect(
        (await callTool(tools, 'gimp_get_selection_preview', { channel: 'Mask' })).isError
      ).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });

    it('rejects a style outside overlay/mask before dispatch', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpSelectionTools(gimp.asBackend(), { previewsAllowed: allow });
      const result = await callTool(tools, 'gimp_get_selection_preview', {
        image: 1,
        channel: 'Mask',
        style: 'outline',
      });
      expect(result.isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });

    it('rejects a max_px outside 512/1024/2048 before dispatch', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpSelectionTools(gimp.asBackend(), { previewsAllowed: allow });
      const result = await callTool(tools, 'gimp_get_selection_preview', {
        image: 1,
        channel: 'Mask',
        max_px: 640,
      });
      expect(result.isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });

    it('dispatches with style defaulted to overlay and max_px to 1024, returns the image + text + structuredContent, then cleans up the temp file', async () => {
      const gimp = makeGimpBackendWithRealPaths({ result: { width: 64, height: 48 } });
      const tools = createGimpSelectionTools(gimp.asBackend(), { previewsAllowed: allow });
      const result = await callTool(tools, 'gimp_get_selection_preview', {
        image: 1,
        channel: 'Subject',
      });
      expect(result.isError).toBeFalsy();
      expect(gimp.lastCall().op).toBe('mask_preview');
      expect(gimp.lastCall().args).toMatchObject({
        image: 1,
        channel: 'Subject',
        style: 'overlay',
        max_px: 1024,
      });
      // Only schema-declared keys reach the bridge (no stray metadata a caller might attach).
      expect(Object.keys(gimp.lastCall().args).sort()).toEqual([
        'channel',
        'image',
        'max_px',
        'out_path',
        'style',
      ]);
      const outPath = gimp.lastCall().args.out_path as string;
      expect(typeof outPath).toBe('string');
      const image = result.content?.find((c) => c.type === 'image') as { data: string };
      expect(Buffer.from(image.data, 'base64')).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      expect((result.content?.[1] as { text: string }).text).toBe('Selection "Subject" 64x48.');
      expect(result.structuredContent).toEqual({ width: 64, height: 48 });
      expect(existsSync(outPath)).toBe(false); // the per-call render file is cleaned up
    });

    it('forwards style=mask', async () => {
      const gimp = makeGimpBackendWithRealPaths({ result: { width: 10, height: 10 } });
      const tools = createGimpSelectionTools(gimp.asBackend(), { previewsAllowed: allow });
      await callTool(tools, 'gimp_get_selection_preview', {
        image: 1,
        channel: 'Mask',
        style: 'mask',
      });
      expect(gimp.lastCall().args).toMatchObject({ style: 'mask' });
    });

    it('forwards a non-default max_px', async () => {
      const gimp = makeGimpBackendWithRealPaths({ result: { width: 10, height: 10 } });
      const tools = createGimpSelectionTools(gimp.asBackend(), { previewsAllowed: allow });
      await callTool(tools, 'gimp_get_selection_preview', {
        image: 1,
        channel: 'Mask',
        max_px: 2048,
      });
      expect(gimp.lastCall().args).toMatchObject({ max_px: 2048 });
    });

    it('does not extract an image when privacy.send_previews_to_llm is false, but still reports dimensions', async () => {
      const gimp = makeGimpBackendWithRealPaths({ result: { width: 32, height: 32 } });
      const tools = createGimpSelectionTools(gimp.asBackend(), { previewsAllowed: deny });
      const result = await callTool(tools, 'gimp_get_selection_preview', {
        image: 1,
        channel: 'Mask',
      });
      expect(result.isError).toBeFalsy();
      expect(result.content?.some((c) => c.type === 'image')).toBe(false);
      expect((result.content?.[0] as { text: string }).text).toContain(
        'privacy.send_previews_to_llm is false'
      );
      expect(result.structuredContent).toEqual({ width: 32, height: 32 });
    });

    it('with no injected previewsAllowed, reads privacy.send_previews_to_llm from the real settings.json', async () => {
      // Mirrors gimp-verify-tools.test.ts's identical check for gimp_get_preview/gimp_compare:
      // every other test here injects the allow/deny function, so without this one a broken
      // default (defaultPreviewsAllowed) would go unnoticed.
      const home = mkdtempSync(join(tmpdir(), 'gimp-selection-home-'));
      const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
      try {
        mkdirSync(join(home, '.editmamei'), { recursive: true });
        writeFileSync(
          join(home, '.editmamei', 'settings.json'),
          JSON.stringify({
            privacy: { send_previews_to_llm: false },
            telemetry: { install_id: 'keep0000000000' },
          })
        );
        process.env.HOME = home;
        process.env.USERPROFILE = home;

        const gimp = makeGimpBackendWithRealPaths({ result: { width: 8, height: 8 } });
        const tools = createGimpSelectionTools(gimp.asBackend());
        const result = await callTool(tools, 'gimp_get_selection_preview', {
          image: 1,
          channel: 'Mask',
        });
        expect(result.isError).toBeFalsy();
        expect(result.content?.some((c) => c.type === 'image')).toBe(false);
        expect((result.content?.at(-1) as { text: string }).text).toMatch(
          /send_previews_to_llm is false/
        );
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('surfaces an unmirrored_filters warning from the bridge in the text', async () => {
      const gimp = makeGimpBackendWithRealPaths({
        result: { width: 20, height: 20, unmirrored_filters: ['Lens Blur'] },
      });
      const tools = createGimpSelectionTools(gimp.asBackend(), { previewsAllowed: allow });
      const result = await callTool(tools, 'gimp_get_selection_preview', {
        image: 1,
        channel: 'Mask',
      });
      expect((result.content?.at(-1) as { text: string }).text).toContain('Lens Blur');
      expect((result.content?.at(-1) as { text: string }).text).toContain('could not be rendered');
    });

    it('an unknown channel surfaces as an error result', async () => {
      const gimp = makeGimpBackendWithRealPaths({
        throwFor: () => new Error("invalid_argument: no channel named 'Ghost'"),
      });
      const tools = createGimpSelectionTools(gimp.asBackend(), { previewsAllowed: allow });
      const result = await callTool(tools, 'gimp_get_selection_preview', {
        image: 1,
        channel: 'Ghost',
      });
      expect(result.isError).toBe(true);
      expect((result.content?.[0] as { text: string }).text).toContain(
        'Error previewing GIMP selection'
      );
      expect((result.content?.[0] as { text: string }).text).toContain("no channel named 'Ghost'");
    });

    it('a render GIMP never wrote is a clean gimp_op_failed, without the temp path Node would name', async () => {
      const gimp = makeGimpBackend({ result: { width: 10, height: 10 } });
      gimp.tempPath = (name: string) => join(scratchDir, 'never-written', name);
      const tools = createGimpSelectionTools(gimp.asBackend(), { previewsAllowed: allow });
      const result = await callTool(tools, 'gimp_get_selection_preview', {
        image: 1,
        channel: 'Mask',
      });
      expect(result.isError).toBe(true);
      const text = JSON.stringify(result.content);
      expect(text).toContain('the render was not written');
      expect(text).not.toContain('never-written');
    });
  });
});
