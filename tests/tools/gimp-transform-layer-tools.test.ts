import { describe, it, expect } from 'vitest';
import { createGimpTransformLayerTools } from '@editmamei/tools/gimp-transform-layer-tools.ts';
import { makeGimpBackend } from '../fixtures/fake-gimp-session.ts';
import { callTool, assertToolShape } from '../fixtures/tool-helpers.ts';

// `interpolation` is the only field with a schema-level `default` -- it's a COMMON key every op
// reads. mode/offset_x/offset_y deliberately have NO schema default (unlike gimp_layer's own
// flat schema): each is op-specific, and a schema-level default would ride along on EVERY call
// regardless of op, tripping the bridge's per-op foreign-field check on every op that doesn't
// own it. The bridge applies each of THEIR own defaults itself when genuinely absent.
const TRANSFORM_LAYER_DEFAULTS = { interpolation: 'cubic' };

describe('createGimpTransformLayerTools', () => {
  it('returns 1 well-formed tool named gimp_transform_layer', () => {
    const gimp = makeGimpBackend();
    const tools = createGimpTransformLayerTools(gimp.asBackend());
    expect(tools.map((t) => t.tool.name)).toEqual(['gimp_transform_layer']);
    assertToolShape(tools);
  });

  it('requires image and op', async () => {
    const gimp = makeGimpBackend();
    const tools = createGimpTransformLayerTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_transform_layer', {});
    expect(result.isError).toBe(true);
    expect(gimp.calls).toHaveLength(0);
  });

  it('requires op (image given alone)', async () => {
    const gimp = makeGimpBackend();
    const tools = createGimpTransformLayerTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_transform_layer', { image: 1 });
    expect(result.isError).toBe(true);
    expect(gimp.calls).toHaveLength(0);
  });

  it('an unknown op is refused before any dispatch (schema enum rejects it)', async () => {
    const gimp = makeGimpBackend();
    const tools = createGimpTransformLayerTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_transform_layer', { image: 1, op: 'perspective' });
    expect(result.isError).toBe(true);
    expect(gimp.calls).toHaveLength(0);
  });

  describe('op=fit', () => {
    it('dispatches with the default mode (fit) when omitted', async () => {
      const gimp = makeGimpBackend({
        result: {
          layer_id: 2,
          bounds: { x: 0, y: 0, width: 200, height: 200 },
          mode: 'fit',
          scale_percent: 150,
          alpha_added: false,
          interpolation: 'cubic',
        },
      });
      const tools = createGimpTransformLayerTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_transform_layer', { image: 1, op: 'fit' });
      expect(gimp.lastCall()).toEqual({
        op: 'transform_layer',
        args: { ...TRANSFORM_LAYER_DEFAULTS, image: 1, op: 'fit' },
      });
      expect((result.content?.[0] as { text: string }).text).toContain('fitted');
      expect((result.content?.[0] as { text: string }).text).toContain('150');
    });

    it('dispatches mode=fill, and success text says "filled"', async () => {
      const gimp = makeGimpBackend({
        result: {
          layer_id: 2,
          bounds: { x: -10, y: 0, width: 220, height: 200 },
          mode: 'fill',
          scale_percent: 220,
          alpha_added: true,
          interpolation: 'cubic',
        },
      });
      const tools = createGimpTransformLayerTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_transform_layer', {
        image: 1,
        op: 'fit',
        mode: 'fill',
      });
      expect(gimp.lastCall()).toEqual({
        op: 'transform_layer',
        args: { ...TRANSFORM_LAYER_DEFAULTS, image: 1, op: 'fit', mode: 'fill' },
      });
      const text = (result.content?.[0] as { text: string }).text;
      expect(text).toContain('filled');
      expect(text).toContain('alpha channel added');
    });
  });

  describe('op=scale', () => {
    it('dispatches scale_percent (uniform)', async () => {
      const gimp = makeGimpBackend({
        result: {
          layer_id: 3,
          bounds: { x: 0, y: 0, width: 200, height: 200 },
          scale_x_percent: 200,
          scale_y_percent: 200,
          alpha_added: false,
          interpolation: 'cubic',
        },
      });
      const tools = createGimpTransformLayerTools(gimp.asBackend());
      await callTool(tools, 'gimp_transform_layer', { image: 1, op: 'scale', scale_percent: 200 });
      expect(gimp.lastCall()).toEqual({
        op: 'transform_layer',
        args: { ...TRANSFORM_LAYER_DEFAULTS, image: 1, op: 'scale', scale_percent: 200 },
      });
    });

    it('dispatches non-uniform scale_x_percent/scale_y_percent', async () => {
      const gimp = makeGimpBackend({
        result: {
          layer_id: 3,
          bounds: { x: 0, y: 0, width: 300, height: 50 },
          scale_x_percent: 300,
          scale_y_percent: 50,
          alpha_added: false,
          interpolation: 'cubic',
        },
      });
      const tools = createGimpTransformLayerTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_transform_layer', {
        image: 1,
        op: 'scale',
        scale_x_percent: 300,
        scale_y_percent: 50,
      });
      expect(gimp.lastCall()).toEqual({
        op: 'transform_layer',
        args: {
          ...TRANSFORM_LAYER_DEFAULTS,
          image: 1,
          op: 'scale',
          scale_x_percent: 300,
          scale_y_percent: 50,
        },
      });
      expect((result.content?.[0] as { text: string }).text).toContain('300% x 50%');
    });

    it('rejects a scale_percent outside the 1..10000 range before any dispatch', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpTransformLayerTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_transform_layer', {
        image: 1,
        op: 'scale',
        scale_percent: 20000,
      });
      expect(result.isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });

    it("maps the bridge's 'requires scale_percent, or scale_x_percent/scale_y_percent' refusal through toolGimpErrorResult", async () => {
      const gimp = makeGimpBackend({
        throwFor: () =>
          new Error(
            'invalid_argument: scale requires scale_percent, or scale_x_percent/scale_y_percent'
          ),
      });
      const tools = createGimpTransformLayerTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_transform_layer', { image: 1, op: 'scale' });
      expect(result.isError).toBe(true);
      expect((result.content?.[0] as { text: string }).text).toContain('scale_x_percent');
    });
  });

  describe('op=move', () => {
    it('dispatches delta (relative)', async () => {
      const gimp = makeGimpBackend({
        result: {
          layer_id: 2,
          bounds: { x: 15, y: 25, width: 100, height: 100 },
          alpha_added: false,
          interpolation: 'cubic',
        },
      });
      const tools = createGimpTransformLayerTools(gimp.asBackend());
      await callTool(tools, 'gimp_transform_layer', {
        image: 1,
        op: 'move',
        delta: { x: 5, y: 10 },
      });
      expect(gimp.lastCall()).toEqual({
        op: 'transform_layer',
        args: { ...TRANSFORM_LAYER_DEFAULTS, image: 1, op: 'move', delta: { x: 5, y: 10 } },
      });
    });

    it('dispatches absolute (top-left target)', async () => {
      const gimp = makeGimpBackend({
        result: {
          layer_id: 2,
          bounds: { x: 100, y: 200, width: 50, height: 50 },
          alpha_added: false,
          interpolation: 'cubic',
        },
      });
      const tools = createGimpTransformLayerTools(gimp.asBackend());
      await callTool(tools, 'gimp_transform_layer', {
        image: 1,
        op: 'move',
        absolute: { x: 100, y: 200 },
      });
      expect(gimp.lastCall()).toEqual({
        op: 'transform_layer',
        args: { ...TRANSFORM_LAYER_DEFAULTS, image: 1, op: 'move', absolute: { x: 100, y: 200 } },
      });
    });

    it('dispatches center_on (center target)', async () => {
      const gimp = makeGimpBackend({
        result: {
          layer_id: 2,
          bounds: { x: 75, y: 175, width: 50, height: 50 },
          alpha_added: false,
          interpolation: 'cubic',
        },
      });
      const tools = createGimpTransformLayerTools(gimp.asBackend());
      await callTool(tools, 'gimp_transform_layer', {
        image: 1,
        op: 'move',
        center_on: { x: 100, y: 200 },
      });
      expect(gimp.lastCall()).toEqual({
        op: 'transform_layer',
        args: { ...TRANSFORM_LAYER_DEFAULTS, image: 1, op: 'move', center_on: { x: 100, y: 200 } },
      });
    });

    it('rejects a delta object missing y before any dispatch (nested required field)', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpTransformLayerTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_transform_layer', {
        image: 1,
        op: 'move',
        delta: { x: 5 },
      });
      expect(result.isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });

    it("maps the bridge's mutual-exclusivity refusal (delta + absolute both given) through toolGimpErrorResult", async () => {
      const gimp = makeGimpBackend({
        throwFor: () =>
          new Error(
            'invalid_argument: move accepts only ONE of delta, absolute, center_on -- not more than one'
          ),
      });
      const tools = createGimpTransformLayerTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_transform_layer', {
        image: 1,
        op: 'move',
        delta: { x: 1, y: 1 },
        absolute: { x: 2, y: 2 },
      });
      expect(result.isError).toBe(true);
      expect((result.content?.[0] as { text: string }).text).toContain('only ONE of');
    });

    it("maps the bridge's 'no mode given' refusal through toolGimpErrorResult when none of delta/absolute/center_on is given", async () => {
      const gimp = makeGimpBackend({
        throwFor: () =>
          new Error(
            'invalid_argument: move requires exactly one of delta, absolute, center_on -- each ' +
              'a {x, y} object; flat fields like delta_x/absolute_x are not accepted'
          ),
      });
      const tools = createGimpTransformLayerTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_transform_layer', { image: 1, op: 'move' });
      expect(result.isError).toBe(true);
      const text = (result.content?.[0] as { text: string }).text;
      expect(text).toContain('requires exactly one of');
      expect(text).toContain('delta_x');
    });

    it("maps the bridge's predicted-position-out-of-bounds refusal through toolGimpErrorResult", async () => {
      const gimp = makeGimpBackend({
        throwFor: () =>
          new Error('invalid_argument: x must be within -30000..30100 for this 100px-wide canvas'),
      });
      const tools = createGimpTransformLayerTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_transform_layer', {
        image: 1,
        op: 'move',
        absolute: { x: 999_999, y: 0 },
      });
      expect(result.isError).toBe(true);
      expect((result.content?.[0] as { text: string }).text).toContain('must be within');
    });
  });

  describe('op=rotate', () => {
    it('dispatches degrees, and success text reports the new bounds', async () => {
      const gimp = makeGimpBackend({
        result: {
          layer_id: 4,
          bounds: { x: -8, y: -3, width: 118, height: 106 },
          degrees: 33,
          alpha_added: true,
          interpolation: 'cubic',
        },
      });
      const tools = createGimpTransformLayerTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_transform_layer', {
        image: 1,
        op: 'rotate',
        degrees: 33,
      });
      expect(gimp.lastCall()).toEqual({
        op: 'transform_layer',
        args: { ...TRANSFORM_LAYER_DEFAULTS, image: 1, op: 'rotate', degrees: 33 },
      });
      const text = (result.content?.[0] as { text: string }).text;
      expect(text).toContain('33');
      expect(text).toContain('118x106');
      expect(text).toContain('alpha channel added');
    });

    it("maps the bridge's masked-filter refusal through toolGimpErrorResult", async () => {
      const gimp = makeGimpBackend({
        throwFor: () =>
          new Error(
            "invalid_argument: rotate would misalign the masked adjustment(s) 'Brightness Contrast': " +
              "a filter's mask does not travel with content that moves beneath it."
          ),
      });
      const tools = createGimpTransformLayerTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_transform_layer', {
        image: 1,
        op: 'rotate',
        degrees: 10,
      });
      expect(result.isError).toBe(true);
      expect((result.content?.[0] as { text: string }).text).toContain('masked adjustment');
    });
  });

  describe('op=flip', () => {
    it('dispatches axis', async () => {
      const gimp = makeGimpBackend({
        result: {
          layer_id: 2,
          bounds: { x: 0, y: 0, width: 100, height: 60 },
          axis: 'horizontal',
          alpha_added: false,
          interpolation: 'cubic',
        },
      });
      const tools = createGimpTransformLayerTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_transform_layer', {
        image: 1,
        op: 'flip',
        axis: 'horizontal',
      });
      expect(gimp.lastCall()).toEqual({
        op: 'transform_layer',
        args: { ...TRANSFORM_LAYER_DEFAULTS, image: 1, op: 'flip', axis: 'horizontal' },
      });
      expect((result.content?.[0] as { text: string }).text).toContain('flipped horizontal');
    });

    it("maps the bridge's 'axis must be one of' refusal through toolGimpErrorResult when axis is omitted", async () => {
      // `axis` has no schema-level `required` (it's op-specific, like every other op's own
      // fields), so an omitted axis dispatches through to the bridge, which is what actually
      // refuses it -- simulated here via throwFor, the same pattern every other bridge-side
      // refusal in this file uses.
      const gimp = makeGimpBackend({
        throwFor: () =>
          new Error("invalid_argument: axis must be one of ['horizontal', 'vertical']"),
      });
      const tools = createGimpTransformLayerTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_transform_layer', { image: 1, op: 'flip' });
      expect(result.isError).toBe(true);
      expect((result.content?.[0] as { text: string }).text).toContain('axis must be one of');
    });

    it('rejects an axis outside the horizontal|vertical enum before any dispatch', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpTransformLayerTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_transform_layer', {
        image: 1,
        op: 'flip',
        axis: 'diagonal',
      });
      expect(result.isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });
  });

  describe('op=skew', () => {
    it('dispatches skew_h_degrees/skew_v_degrees', async () => {
      const gimp = makeGimpBackend({
        result: {
          layer_id: 2,
          bounds: { x: -5, y: 0, width: 110, height: 60 },
          skew_h_degrees: 15,
          skew_v_degrees: 0,
          alpha_added: false,
          interpolation: 'cubic',
        },
      });
      const tools = createGimpTransformLayerTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_transform_layer', {
        image: 1,
        op: 'skew',
        skew_h_degrees: 15,
      });
      expect(gimp.lastCall()).toEqual({
        op: 'transform_layer',
        args: { ...TRANSFORM_LAYER_DEFAULTS, image: 1, op: 'skew', skew_h_degrees: 15 },
      });
      expect((result.content?.[0] as { text: string }).text).toContain('h=15');
    });

    it("maps the bridge's 'at least one of' refusal through toolGimpErrorResult", async () => {
      const gimp = makeGimpBackend({
        throwFor: () =>
          new Error(
            'invalid_argument: skew requires at least one of skew_h_degrees, skew_v_degrees'
          ),
      });
      const tools = createGimpTransformLayerTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_transform_layer', { image: 1, op: 'skew' });
      expect(result.isError).toBe(true);
      expect((result.content?.[0] as { text: string }).text).toContain('at least one of');
    });
  });

  describe('op=free', () => {
    it('dispatches scale_x_percent/scale_y_percent/degrees/offset_x/offset_y (offset defaults to 0)', async () => {
      const gimp = makeGimpBackend({
        result: {
          layer_id: 2,
          bounds: { x: 10, y: 10, width: 150, height: 150 },
          scale_x_percent: 150,
          scale_y_percent: 150,
          degrees: 10,
          offset_x: 0,
          offset_y: 0,
          alpha_added: false,
          interpolation: 'cubic',
        },
      });
      const tools = createGimpTransformLayerTools(gimp.asBackend());
      await callTool(tools, 'gimp_transform_layer', {
        image: 1,
        op: 'free',
        scale_x_percent: 150,
        scale_y_percent: 150,
        degrees: 10,
      });
      expect(gimp.lastCall()).toEqual({
        op: 'transform_layer',
        args: {
          ...TRANSFORM_LAYER_DEFAULTS,
          image: 1,
          op: 'free',
          scale_x_percent: 150,
          scale_y_percent: 150,
          degrees: 10,
        },
      });
    });

    it('forwards an explicit interpolation choice instead of the cubic default', async () => {
      const gimp = makeGimpBackend({
        result: {
          layer_id: 2,
          bounds: { x: 0, y: 0, width: 100, height: 100 },
          alpha_added: false,
          interpolation: 'none',
        },
      });
      const tools = createGimpTransformLayerTools(gimp.asBackend());
      await callTool(tools, 'gimp_transform_layer', {
        image: 1,
        op: 'free',
        interpolation: 'none',
      });
      expect(gimp.lastCall()).toEqual({
        op: 'transform_layer',
        args: { ...TRANSFORM_LAYER_DEFAULTS, image: 1, op: 'free', interpolation: 'none' },
      });
    });

    it('rejects an interpolation value outside the fixed enum before any dispatch', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpTransformLayerTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_transform_layer', {
        image: 1,
        op: 'free',
        interpolation: 'bicubic-smoother',
      });
      expect(result.isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });
  });

  describe('layer addressing', () => {
    it('forwards layer_id', async () => {
      const gimp = makeGimpBackend({
        result: {
          layer_id: 9,
          bounds: { x: 0, y: 0, width: 10, height: 10 },
          axis: 'vertical',
          alpha_added: false,
          interpolation: 'cubic',
        },
      });
      const tools = createGimpTransformLayerTools(gimp.asBackend());
      await callTool(tools, 'gimp_transform_layer', {
        image: 1,
        op: 'flip',
        axis: 'vertical',
        layer_id: 9,
      });
      expect(gimp.lastCall()).toEqual({
        op: 'transform_layer',
        args: { ...TRANSFORM_LAYER_DEFAULTS, image: 1, op: 'flip', axis: 'vertical', layer_id: 9 },
      });
    });

    it('forwards layer (name)', async () => {
      const gimp = makeGimpBackend({
        result: {
          layer_id: 9,
          bounds: { x: 0, y: 0, width: 10, height: 10 },
          axis: 'vertical',
          alpha_added: false,
          interpolation: 'cubic',
        },
      });
      const tools = createGimpTransformLayerTools(gimp.asBackend());
      await callTool(tools, 'gimp_transform_layer', {
        image: 1,
        op: 'flip',
        axis: 'vertical',
        layer: 'Subject',
      });
      expect(gimp.lastCall()).toEqual({
        op: 'transform_layer',
        args: {
          ...TRANSFORM_LAYER_DEFAULTS,
          image: 1,
          op: 'flip',
          axis: 'vertical',
          layer: 'Subject',
        },
      });
    });
  });

  it('declares bounds/alpha_added/interpolation in the outputSchema', () => {
    const gimp = makeGimpBackend();
    const tools = createGimpTransformLayerTools(gimp.asBackend());
    const schema = tools[0]!.tool.outputSchema as unknown as {
      properties: {
        bounds: { type: string };
        alpha_added: { type: string };
        interpolation: { type: string };
      };
    };
    expect(schema.properties.bounds.type).toBe('object');
    expect(schema.properties.alpha_added.type).toBe('boolean');
    expect(schema.properties.interpolation.type).toBe('string');
  });
});
