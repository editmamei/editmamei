import { describe, it, expect } from 'vitest';
import { createGimpMaskTools } from '@editmamei/tools/gimp-mask-tools.ts';
import { makeGimpBackend } from '../fixtures/fake-gimp-session.ts';
import { callTool, assertToolShape } from '../fixtures/tool-helpers.ts';

describe('createGimpMaskTools', () => {
  it('returns 1 well-formed tool with this name', () => {
    const gimp = makeGimpBackend();
    const tools = createGimpMaskTools(gimp.asBackend());
    expect(tools.map((t) => t.tool.name)).toEqual(['gimp_create_mask']);
    assertToolShape(tools);
  });

  it('requires image and type', async () => {
    const gimp = makeGimpBackend();
    const tools = createGimpMaskTools(gimp.asBackend());
    expect((await callTool(tools, 'gimp_create_mask', { type: 'rectangle' })).isError).toBe(true);
    expect((await callTool(tools, 'gimp_create_mask', { image: 1 })).isError).toBe(true);
    expect(gimp.calls).toHaveLength(0);
  });

  it('dispatches create_mask for a rectangle with defaults applied (name, invert, feather_px)', async () => {
    const gimp = makeGimpBackend({
      result: { channel: 'Mask', selected_pixels: 500, fraction: 0.5 },
    });
    const tools = createGimpMaskTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_create_mask', {
      image: 1,
      type: 'rectangle',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
    expect(gimp.lastCall()).toEqual({
      op: 'create_mask',
      args: {
        image: 1,
        type: 'rectangle',
        name: 'Mask',
        invert: false,
        feather_px: 0,
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      },
    });
    expect(result.structuredContent).toEqual({
      channel: 'Mask',
      selected_pixels: 500,
      fraction: 0.5,
    });
  });

  it('dispatches create_mask for a gradient with custom name + invert', async () => {
    const gimp = makeGimpBackend({
      result: { channel: 'Vignette', selected_pixels: 0, fraction: 0 },
    });
    const tools = createGimpMaskTools(gimp.asBackend());
    await callTool(tools, 'gimp_create_mask', {
      image: 1,
      type: 'gradient_radial',
      name: 'Vignette',
      invert: true,
    });
    expect(gimp.lastCall()).toEqual({
      op: 'create_mask',
      args: { image: 1, type: 'gradient_radial', name: 'Vignette', invert: true, feather_px: 0 },
    });
  });

  it('maps a bridge invalid_argument (name already in use) through toolGimpErrorResult', async () => {
    const gimp = makeGimpBackend({
      throwFor: () =>
        new Error("invalid_argument: mask 'Mask' is already used by an existing filter"),
    });
    const tools = createGimpMaskTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_create_mask', {
      image: 1,
      type: 'rectangle',
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
    expect(result.isError).toBe(true);
    expect((result.content?.[0] as { text: string }).text).toContain('already used');
  });
});
