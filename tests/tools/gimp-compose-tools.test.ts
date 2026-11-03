import { describe, it, expect } from 'vitest';
import { createGimpComposeTools } from '@editmamei/tools/gimp-compose-tools.ts';
import { makeGimpBackend } from '../fixtures/fake-gimp-session.ts';
import { callTool, assertToolShape } from '../fixtures/tool-helpers.ts';

/**
 * `requireAbsoluteGimpPath` (the tool layer's absolute-path gate every gimp_* handler calls)
 * defaults to `process.platform` when the handler doesn't pass one explicitly, so every example
 * path here must be absolute on WHATEVER platform this suite actually runs on -- same reasoning
 * `gimp-document-tools.test.ts`'s own `absPath` helper documents.
 */
const absPath = (suffix: string): string =>
  process.platform === 'win32' ? `C:/${suffix}` : `/${suffix}`;

// gimp_create_document's schema declares defaults for mode/fill (not precision/name), so
// `validateArgs` applies them on EVERY dispatched call regardless of what the caller passed.
const CREATE_DOCUMENT_DEFAULTS = { mode: 'rgb', fill: 'white' };

// gimp_place_image's schema declares defaults for x/y/position (not width/height/name/
// parent_group), so those three ride along on every dispatched call.
const PLACE_IMAGE_DEFAULTS = { x: 0, y: 0, position: 0 };

// gimp_canvas's schema declares a default for fill only.
const CANVAS_DEFAULTS = { fill: 'transparent' };

describe('createGimpComposeTools', () => {
  it('returns 4 well-formed tools with these names', () => {
    const gimp = makeGimpBackend();
    const tools = createGimpComposeTools(gimp.asBackend());
    expect(tools.map((t) => t.tool.name).sort()).toEqual([
      'gimp_canvas',
      'gimp_convert_image_mode',
      'gimp_create_document',
      'gimp_place_image',
    ]);
    assertToolShape(tools);
  });

  describe('gimp_create_document', () => {
    it('requires width and height', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpComposeTools(gimp.asBackend());
      expect((await callTool(tools, 'gimp_create_document', {})).isError).toBe(true);
      expect((await callTool(tools, 'gimp_create_document', { width: 10 })).isError).toBe(true);
      expect((await callTool(tools, 'gimp_create_document', { height: 10 })).isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });

    it('rejects a non-positive dimension before dispatch', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpComposeTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_create_document', { width: 0, height: 10 });
      expect(result.isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });

    it('dispatches with defaults applied (mode=rgb, fill=white)', async () => {
      const gimp = makeGimpBackend({
        result: {
          image: 1,
          width: 20,
          height: 10,
          base_type: 'rgb',
          precision: 'u8-non-linear',
          layers: ['Background'],
        },
      });
      const tools = createGimpComposeTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_create_document', { width: 20, height: 10 });
      expect(gimp.lastCall()).toEqual({
        op: 'create_document',
        args: { ...CREATE_DOCUMENT_DEFAULTS, width: 20, height: 10 },
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ image: 1, width: 20, height: 10 });
      expect((result.content?.[0] as { text: string }).text).toContain('Created a new 20x10');
    });

    it('forwards fill/mode/precision/name when given', async () => {
      const gimp = makeGimpBackend({
        result: {
          image: 2,
          width: 5,
          height: 5,
          base_type: 'gray',
          precision: 'u16-non-linear',
          layers: ['Base'],
        },
      });
      const tools = createGimpComposeTools(gimp.asBackend());
      await callTool(tools, 'gimp_create_document', {
        width: 5,
        height: 5,
        mode: 'grayscale',
        fill: 'black',
        precision: '16',
        name: 'Base',
      });
      expect(gimp.lastCall()).toEqual({
        op: 'create_document',
        args: {
          width: 5,
          height: 5,
          mode: 'grayscale',
          fill: 'black',
          precision: '16',
          name: 'Base',
        },
      });
    });

    it('rejects a fill/mode outside the fixed enums before dispatch', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpComposeTools(gimp.asBackend());
      expect(
        (await callTool(tools, 'gimp_create_document', { width: 5, height: 5, fill: 'purple' }))
          .isError
      ).toBe(true);
      expect(
        (await callTool(tools, 'gimp_create_document', { width: 5, height: 5, mode: 'cmyk' }))
          .isError
      ).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });
  });

  describe('gimp_place_image', () => {
    it('requires image and file_path', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpComposeTools(gimp.asBackend());
      expect((await callTool(tools, 'gimp_place_image', { image: 1 })).isError).toBe(true);
      expect(
        (await callTool(tools, 'gimp_place_image', { file_path: absPath('a.png') })).isError
      ).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });

    it.each([
      ['a relative path', 'photo.jpg'],
      ['a UNC share', '\\\\server\\share\\photo.jpg'],
      ['a UNC share with forward slashes', '//server/share/photo.jpg'],
      ['a \\\\?\\ device path', '\\\\?\\C:\\photo.jpg'],
    ])('rejects %s BEFORE ever dispatching to the bridge', async (_label, filePath) => {
      const gimp = makeGimpBackend();
      const tools = createGimpComposeTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_place_image', { image: 1, file_path: filePath });
      expect(result.isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });

    it('on win32, rejects a drive-less absolute path ("\\photo.jpg") BEFORE ever dispatching', async () => {
      if (process.platform !== 'win32') return; // this shape is only ambiguous on win32
      const gimp = makeGimpBackend();
      const tools = createGimpComposeTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_place_image', {
        image: 1,
        file_path: '\\photo.jpg',
      });
      expect(result.isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });

    it("remaps file_path to the bridge's `path` field, and file_path never leaks into the dispatched args", async () => {
      const gimp = makeGimpBackend({
        result: {
          layer_id: 3,
          name: 'photo',
          width: 10,
          height: 10,
          x: 0,
          y: 0,
          parent_group: null,
        },
      });
      const tools = createGimpComposeTools(gimp.asBackend());
      const filePath = absPath('photos/photo.png');
      await callTool(tools, 'gimp_place_image', { image: 1, file_path: filePath });
      const call = gimp.lastCall();
      expect(call.op).toBe('place_image');
      expect(call.args.path).toBe(filePath);
      expect('file_path' in call.args).toBe(false);
    });

    it('dispatches with x/y/position defaults, and no width/height/name/parent_group when omitted', async () => {
      const gimp = makeGimpBackend({
        result: {
          layer_id: 3,
          name: 'photo',
          width: 10,
          height: 10,
          x: 0,
          y: 0,
          parent_group: null,
        },
      });
      const tools = createGimpComposeTools(gimp.asBackend());
      const filePath = absPath('photo.png');
      await callTool(tools, 'gimp_place_image', { image: 1, file_path: filePath });
      expect(gimp.lastCall()).toEqual({
        op: 'place_image',
        args: { ...PLACE_IMAGE_DEFAULTS, image: 1, path: filePath },
      });
    });

    it('forwards x/y/width/height/name/parent_group when given', async () => {
      const gimp = makeGimpBackend({
        result: {
          layer_id: 4,
          name: 'Placed',
          width: 40,
          height: 20,
          x: 5,
          y: 6,
          parent_group: 9,
        },
      });
      const tools = createGimpComposeTools(gimp.asBackend());
      const filePath = absPath('photo.png');
      await callTool(tools, 'gimp_place_image', {
        image: 1,
        file_path: filePath,
        x: 5,
        y: 6,
        width: 40,
        height: 20,
        name: 'Placed',
        parent_group: 9,
        position: 2,
      });
      expect(gimp.lastCall()).toEqual({
        op: 'place_image',
        args: {
          image: 1,
          path: filePath,
          x: 5,
          y: 6,
          width: 40,
          height: 20,
          name: 'Placed',
          parent_group: 9,
          position: 2,
        },
      });
    });

    it('rejects width/height below the schema minimum before dispatch', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpComposeTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_place_image', {
        image: 1,
        file_path: absPath('photo.png'),
        width: 0,
      });
      expect(result.isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });

    it('success text names the basename only (never the full path)', async () => {
      const gimp = makeGimpBackend({
        result: {
          layer_id: 3,
          name: 'photo',
          width: 10,
          height: 10,
          x: 0,
          y: 0,
          parent_group: null,
        },
      });
      const tools = createGimpComposeTools(gimp.asBackend());
      const filePath = absPath('deep/nested/photo.png');
      const result = await callTool(tools, 'gimp_place_image', { image: 1, file_path: filePath });
      const text = (result.content?.[0] as { text: string }).text;
      expect(text).toContain('photo.png');
      expect(text).not.toContain(filePath);
      expect(text).not.toContain('deep/nested');
    });

    it('success text notes baked_filters when present, and omits any mention when absent', async () => {
      const gimp = makeGimpBackend({
        result: {
          layer_id: 3,
          name: 'photo',
          width: 10,
          height: 10,
          x: 0,
          y: 0,
          parent_group: null,
          baked_filters: ['Grade'],
        },
      });
      const tools = createGimpComposeTools(gimp.asBackend());
      const withBaked = await callTool(tools, 'gimp_place_image', {
        image: 1,
        file_path: absPath('photo.png'),
      });
      expect((withBaked.content?.[0] as { text: string }).text).toContain('baked');
      expect((withBaked.content?.[0] as { text: string }).text).toContain('Grade');

      const gimpNoBake = makeGimpBackend({
        result: {
          layer_id: 3,
          name: 'photo',
          width: 10,
          height: 10,
          x: 0,
          y: 0,
          parent_group: null,
        },
      });
      const toolsNoBake = createGimpComposeTools(gimpNoBake.asBackend());
      const withoutBaked = await callTool(toolsNoBake, 'gimp_place_image', {
        image: 1,
        file_path: absPath('photo.png'),
      });
      expect((withoutBaked.content?.[0] as { text: string }).text).not.toContain('baked');
    });

    it('a bridge refusal surfaces as an error result', async () => {
      const gimp = makeGimpBackend({
        throwFor: () =>
          new Error('invalid_argument: x must be within -30000..30040 for this 40px-wide canvas'),
      });
      const tools = createGimpComposeTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_place_image', {
        image: 1,
        file_path: absPath('photo.png'),
        x: 999999,
      });
      expect(result.isError).toBe(true);
      expect((result.content?.[0] as { text: string }).text).toContain('must be within');
    });
  });

  describe('gimp_canvas', () => {
    it('requires image, width, and height', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpComposeTools(gimp.asBackend());
      expect((await callTool(tools, 'gimp_canvas', { image: 1, width: 10 })).isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });

    it('dispatches with fill defaulted to transparent when omitted', async () => {
      const gimp = makeGimpBackend({ result: { width: 20, height: 20, offset_x: 0, offset_y: 0 } });
      const tools = createGimpComposeTools(gimp.asBackend());
      await callTool(tools, 'gimp_canvas', { image: 1, width: 20, height: 20 });
      expect(gimp.lastCall()).toEqual({
        op: 'canvas',
        args: { ...CANVAS_DEFAULTS, image: 1, width: 20, height: 20 },
      });
    });

    it.each(['white', 'black', 'transparent', '#336699'])(
      'passes fill=%s straight through to the bridge',
      async (fill) => {
        const gimp = makeGimpBackend({
          result: { width: 20, height: 20, offset_x: 0, offset_y: 0 },
        });
        const tools = createGimpComposeTools(gimp.asBackend());
        await callTool(tools, 'gimp_canvas', { image: 1, width: 20, height: 20, fill });
        expect(gimp.lastCall().args.fill).toBe(fill);
      }
    );

    it('rejects a fill matching neither the fixed words nor the hex pattern, before dispatch', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpComposeTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_canvas', {
        image: 1,
        width: 20,
        height: 20,
        fill: 'red',
      });
      expect(result.isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });

    it('forwards anchor when given', async () => {
      const gimp = makeGimpBackend({ result: { width: 20, height: 20, offset_x: 5, offset_y: 0 } });
      const tools = createGimpComposeTools(gimp.asBackend());
      await callTool(tools, 'gimp_canvas', { image: 1, width: 20, height: 20, anchor: 'center' });
      expect(gimp.lastCall()).toEqual({
        op: 'canvas',
        args: { ...CANVAS_DEFAULTS, image: 1, width: 20, height: 20, anchor: 'center' },
      });
    });

    it('forwards explicit offset_x/offset_y when given, with no anchor key at all', async () => {
      const gimp = makeGimpBackend({ result: { width: 20, height: 20, offset_x: 3, offset_y: 4 } });
      const tools = createGimpComposeTools(gimp.asBackend());
      await callTool(tools, 'gimp_canvas', {
        image: 1,
        width: 20,
        height: 20,
        offset_x: 3,
        offset_y: 4,
      });
      const call = gimp.lastCall();
      expect(call.args).toEqual({
        ...CANVAS_DEFAULTS,
        image: 1,
        width: 20,
        height: 20,
        offset_x: 3,
        offset_y: 4,
      });
      expect('anchor' in call.args).toBe(false);
    });

    it('success text reports the new size and the content offset', async () => {
      const gimp = makeGimpBackend({ result: { width: 30, height: 25, offset_x: 5, offset_y: 5 } });
      const tools = createGimpComposeTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_canvas', { image: 1, width: 30, height: 25 });
      const text = (result.content?.[0] as { text: string }).text;
      expect(text).toContain('30x25');
      expect(text).toContain('5, 5');
    });

    it('a masked-filter refusal from the bridge surfaces as an error result', async () => {
      const gimp = makeGimpBackend({
        throwFor: () =>
          new Error(
            "invalid_argument: canvas would misalign the masked filter(s) 'Grade': a filter's mask cannot move with this transform."
          ),
      });
      const tools = createGimpComposeTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_canvas', { image: 1, width: 40, height: 40 });
      expect(result.isError).toBe(true);
      expect((result.content?.[0] as { text: string }).text).toContain('masked filter');
    });
  });

  describe('gimp_convert_image_mode', () => {
    it('requires image and mode', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpComposeTools(gimp.asBackend());
      expect((await callTool(tools, 'gimp_convert_image_mode', { image: 1 })).isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });

    it('rejects a mode outside rgb/grayscale before dispatch', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpComposeTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_convert_image_mode', { image: 1, mode: 'cmyk' });
      expect(result.isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });

    it('dispatches image+mode exactly', async () => {
      const gimp = makeGimpBackend({ result: { mode: 'grayscale', converted: true } });
      const tools = createGimpComposeTools(gimp.asBackend());
      await callTool(tools, 'gimp_convert_image_mode', { image: 1, mode: 'grayscale' });
      expect(gimp.lastCall()).toEqual({
        op: 'convert_image_mode',
        args: { image: 1, mode: 'grayscale' },
      });
    });

    it('success text distinguishes converted vs. a reported no-op', async () => {
      const gimpConverted = makeGimpBackend({ result: { mode: 'grayscale', converted: true } });
      const toolsConverted = createGimpComposeTools(gimpConverted.asBackend());
      const converted = await callTool(toolsConverted, 'gimp_convert_image_mode', {
        image: 1,
        mode: 'grayscale',
      });
      expect((converted.content?.[0] as { text: string }).text).toContain('Converted image 1');

      const gimpNoop = makeGimpBackend({ result: { mode: 'rgb', converted: false } });
      const toolsNoop = createGimpComposeTools(gimpNoop.asBackend());
      const noop = await callTool(toolsNoop, 'gimp_convert_image_mode', { image: 1, mode: 'rgb' });
      expect((noop.content?.[0] as { text: string }).text).toContain('already rgb');
    });

    it('a live-filter refusal from the bridge surfaces as an error result', async () => {
      const gimp = makeGimpBackend({
        throwFor: () =>
          new Error(
            "invalid_argument: gimp_convert_image_mode refuses while any live filter is present ('Curves')"
          ),
      });
      const tools = createGimpComposeTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_convert_image_mode', {
        image: 1,
        mode: 'grayscale',
      });
      expect(result.isError).toBe(true);
      expect((result.content?.[0] as { text: string }).text).toContain('live filter is present');
    });
  });
});
