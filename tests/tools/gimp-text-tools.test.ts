import { describe, it, expect } from 'vitest';
import { createGimpTextTools, TEXT_SCHEMA_FOR_TESTS } from '@editmamei/tools/gimp-text-tools.ts';
import { createGimpInspectTools } from '@editmamei/tools/gimp-inspect-tools.ts';
import { GimpError } from '@editmamei/backends/gimp/errors.ts';
import { gimpFactories } from '@editmamei/modules/gimp/index.ts';
import { tierOf } from '@editmamei/core/tool-tiers.ts';
import { makeGimpBackend } from '../fixtures/fake-gimp-session.ts';
import { callTool, assertToolShape } from '../fixtures/tool-helpers.ts';

const TEXT_RESULT = {
  layer_id: 9,
  name: 'Hello',
  text: 'Hello',
  font: 'Sans-serif',
  font_size: 24,
  color: { red: 0, green: 0, blue: 0 },
  alignment: 'LEFT',
  bounds: { x: 100, y: 100, width: 80, height: 30 },
};

describe('createGimpTextTools', () => {
  it('returns 1 well-formed tool with this name', () => {
    const gimp = makeGimpBackend();
    const tools = createGimpTextTools(gimp.asBackend());
    expect(tools.map((t) => t.tool.name)).toEqual(['gimp_text']);
    assertToolShape(tools);
  });

  it('is registered with the gimp module at tier dev', () => {
    const gimp = makeGimpBackend();
    const names = gimpFactories.flatMap((f) => f(gimp.asBackend())).map((d) => d.tool.name);
    expect(names).toContain('gimp_text');
    expect(tierOf('gimp_text')).toBe('dev');
  });

  it('mirrors ps_text: the same op names and parameter names', () => {
    const props = TEXT_SCHEMA_FOR_TESTS.properties!;
    expect((props.op as { enum: string[] }).enum).toEqual([
      'create',
      'set_content',
      'set_font',
      'set_color',
      'set_alignment',
    ]);
    for (const key of [
      'text',
      'x',
      'y',
      'font_size',
      'font_name',
      'red',
      'green',
      'blue',
      'alignment',
    ]) {
      expect(props, key).toHaveProperty(key);
    }
    expect(props.font_size).toMatchObject({ minimum: 1, maximum: 1296 });
    expect(props.red).toMatchObject({ minimum: 0, maximum: 255 });
    expect((props.alignment as { enum: string[] }).enum).toEqual([
      'LEFT',
      'CENTER',
      'RIGHT',
      'FULLYJUSTIFIED',
      'LEFTJUSTIFIED',
      'CENTERJUSTIFIED',
      'RIGHTJUSTIFIED',
    ]);
    expect(TEXT_SCHEMA_FOR_TESTS.required).toEqual(['image', 'op']);
  });

  it('declares no font_size default, so set_font without a size leaves the size alone', () => {
    expect(TEXT_SCHEMA_FOR_TESTS.properties!.font_size).not.toHaveProperty('default');
  });

  it('requires image and op, and rejects an unknown op without calling the bridge', async () => {
    const gimp = makeGimpBackend();
    const tools = createGimpTextTools(gimp.asBackend());
    expect((await callTool(tools, 'gimp_text', { op: 'create', text: 'x' })).isError).toBe(true);
    expect((await callTool(tools, 'gimp_text', { image: 1 })).isError).toBe(true);
    expect((await callTool(tools, 'gimp_text', { image: 1, op: 'spin' })).isError).toBe(true);
    expect(gimp.calls).toHaveLength(0);
  });

  it('rejects out-of-range font_size and colour before reaching the bridge', async () => {
    const gimp = makeGimpBackend();
    const tools = createGimpTextTools(gimp.asBackend());
    const base = { image: 1, op: 'create', text: 'x' };
    expect((await callTool(tools, 'gimp_text', { ...base, font_size: 1297 })).isError).toBe(true);
    expect((await callTool(tools, 'gimp_text', { ...base, font_size: 0 })).isError).toBe(true);
    expect((await callTool(tools, 'gimp_text', { ...base, red: 256 })).isError).toBe(true);
    expect((await callTool(tools, 'gimp_text', { ...base, alignment: 'MIDDLE' })).isError).toBe(
      true
    );
    expect(gimp.calls).toHaveLength(0);
  });

  it('dispatches the text bridge op with the schema-declared keys only', async () => {
    const gimp = makeGimpBackend({ result: TEXT_RESULT });
    const tools = createGimpTextTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_text', {
      image: 1,
      op: 'create',
      text: 'Hello',
      font_name: 'Inter Bold',
      red: 1,
      green: 2,
      blue: 3,
      alignment: 'CENTER',
      surprise: true,
    });
    expect(result.isError).toBeFalsy();
    expect(gimp.lastCall()).toEqual({
      op: 'text',
      args: {
        image: 1,
        op: 'create',
        text: 'Hello',
        font_name: 'Inter Bold',
        red: 1,
        green: 2,
        blue: 3,
        alignment: 'CENTER',
        x: 100,
        y: 100,
      },
    });
    expect(result.structuredContent).toEqual(TEXT_RESULT);
  });

  it('forwards layer_id and layer for the set_* ops', async () => {
    const gimp = makeGimpBackend({ result: TEXT_RESULT });
    const tools = createGimpTextTools(gimp.asBackend());
    await callTool(tools, 'gimp_text', {
      image: 1,
      op: 'set_color',
      layer_id: 9,
      red: 1,
      green: 2,
      blue: 3,
    });
    expect(gimp.lastCall().args).toMatchObject({ layer_id: 9, op: 'set_color' });
    await callTool(tools, 'gimp_text', { image: 1, op: 'set_content', layer: 'Hello', text: 'x' });
    expect(gimp.lastCall().args).toMatchObject({ layer: 'Hello', op: 'set_content' });
  });

  it('surfaces a bridge refusal as an error result', async () => {
    const gimp = makeGimpBackend({
      throwFor: () =>
        new GimpError(
          'invalid_argument',
          "no installed font matches 'x'. Closest installed names: Y"
        ),
    });
    const tools = createGimpTextTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_text', {
      image: 1,
      op: 'create',
      text: 'x',
      font_name: 'x',
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Closest installed names');
  });
});

describe("gimp_inspect what='fonts'", () => {
  it('dispatches the fonts bridge op without an image, forwarding the filter', async () => {
    const gimp = makeGimpBackend({
      result: {
        fonts: ['Inter Bold', 'Inter Regular'],
        total: 2,
        returned: 2,
        truncated: false,
        default: 'Sans-serif',
      },
    });
    const tools = createGimpInspectTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_inspect', { what: 'fonts', filter: 'inter' });
    expect(result.isError).toBeFalsy();
    expect(gimp.lastCall()).toEqual({ op: 'fonts', args: { what: 'fonts', filter: 'inter' } });
    expect(result.structuredContent).toMatchObject({
      what: 'fonts',
      fonts: ['Inter Bold', 'Inter Regular'],
      total: 2,
    });
    expect(JSON.stringify(result.content)).toContain('2 font(s) installed matching');
  });

  it('says when the list was capped', async () => {
    const gimp = makeGimpBackend({
      result: { fonts: ['A', 'B'], total: 450, returned: 2, truncated: true, default: 'A' },
    });
    const tools = createGimpInspectTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_inspect', { what: 'fonts' });
    expect(JSON.stringify(result.content)).toContain('showing the first 2');
  });
});
