import { describe, it, expect } from 'vitest';
import { createGimpGeometryTools } from '@editmamei/tools/gimp-geometry-tools.ts';
import { makeGimpBackend } from '../fixtures/fake-gimp-session.ts';
import { callTool, assertToolShape } from '../fixtures/tool-helpers.ts';

describe('createGimpGeometryTools', () => {
  it('returns 3 well-formed tools with these names', () => {
    const gimp = makeGimpBackend();
    const tools = createGimpGeometryTools(gimp.asBackend());
    expect(tools.map((t) => t.tool.name).sort()).toEqual([
      'gimp_crop_document',
      'gimp_resize_image',
      'gimp_transform_canvas',
    ]);
    assertToolShape(tools);
  });

  describe('gimp_crop_document', () => {
    const FULL_ARGS = { image: 1, left: 10, top: 20, width: 400, height: 300 };

    it.each(['image', 'left', 'top', 'width', 'height'] as const)(
      'requires %s (rejected when it alone is missing, every other required field present)',
      async (missingField) => {
        const gimp = makeGimpBackend();
        const tools = createGimpGeometryTools(gimp.asBackend());
        const args = { ...FULL_ARGS };
        delete (args as Record<string, unknown>)[missingField];
        const result = await callTool(tools, 'gimp_crop_document', args);
        expect(result.isError, `missing "${missingField}" should be rejected`).toBe(true);
        expect(gimp.calls).toHaveLength(0);
      }
    );

    it('dispatches crop with the given rect', async () => {
      const gimp = makeGimpBackend({ result: { width: 400, height: 300 } });
      const tools = createGimpGeometryTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_crop_document', {
        image: 1,
        left: 10,
        top: 20,
        width: 400,
        height: 300,
      });
      expect(gimp.lastCall()).toEqual({
        op: 'crop',
        args: { image: 1, left: 10, top: 20, width: 400, height: 300 },
      });
      expect(result.structuredContent).toEqual({ width: 400, height: 300 });
    });
  });

  describe('gimp_resize_image', () => {
    it('requires image', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpGeometryTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_resize_image', {});
      expect(result.isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });

    it('dispatches resize with long_edge', async () => {
      const gimp = makeGimpBackend({ result: { width: 2048, height: 1365 } });
      const tools = createGimpGeometryTools(gimp.asBackend());
      await callTool(tools, 'gimp_resize_image', { image: 1, long_edge: 2048 });
      expect(gimp.lastCall()).toEqual({ op: 'resize', args: { image: 1, long_edge: 2048 } });
    });

    it('maps a bridge invalid_argument (masked-filter refusal) through toolGimpErrorResult', async () => {
      const gimp = makeGimpBackend({
        throwFor: () =>
          new Error(
            "invalid_argument: resize would misalign the masked adjustment(s) 'Lift shadows'"
          ),
      });
      const tools = createGimpGeometryTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_resize_image', { image: 1, long_edge: 1024 });
      expect(result.isError).toBe(true);
      expect((result.content?.[0] as { text: string }).text).toContain('masked adjustment');
    });
  });

  describe('gimp_transform_canvas', () => {
    it('requires op (image given alone)', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpGeometryTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_transform_canvas', { image: 1 });
      expect(result.isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });

    it('requires image (op given alone)', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpGeometryTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_transform_canvas', {
        op: 'flip',
        orientation: 'horizontal',
      });
      expect(result.isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });

    it("op='rotate' dispatches op 'rotate' with degrees + expand", async () => {
      const gimp = makeGimpBackend({ result: { width: 900, height: 900, degrees: 15 } });
      const tools = createGimpGeometryTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_transform_canvas', {
        image: 1,
        op: 'rotate',
        degrees: 15,
        expand: true,
      });
      expect(gimp.lastCall()).toEqual({
        op: 'rotate',
        args: { image: 1, op: 'rotate', degrees: 15, expand: true },
      });
      expect(result.structuredContent).toEqual({ width: 900, height: 900, degrees: 15 });
    });

    it("op='flip' dispatches op 'flip' with orientation", async () => {
      const gimp = makeGimpBackend({ result: { width: 800, height: 600 } });
      const tools = createGimpGeometryTools(gimp.asBackend());
      await callTool(tools, 'gimp_transform_canvas', {
        image: 1,
        op: 'flip',
        orientation: 'horizontal',
      });
      // `expand` carries a schema-wide default (only rotate reads it) — it rides
      // along on a flip call too since the schema is flat; op_flip simply ignores it.
      expect(gimp.lastCall()).toEqual({
        op: 'flip',
        args: { image: 1, op: 'flip', orientation: 'horizontal', expand: false },
      });
    });

    it("an unknown op is refused before any dispatch (schema enum rejects it; the handler's own unknownDiscriminator fallback is unreachable while the enum stands)", async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpGeometryTools(gimp.asBackend());
      // 'skew' isn't in the schema enum, so validateArgs itself refuses it —
      // still exercises the same "no dispatch on an unrecognized op" contract.
      const result = await callTool(tools, 'gimp_transform_canvas', { image: 1, op: 'skew' });
      expect(result.isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });
  });
});
