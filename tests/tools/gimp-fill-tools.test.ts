import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  createGimpFillTools,
  FILL_MAX_COORD_PX,
  FILL_MAX_STOPS,
  FILL_MAX_STRING_LEN,
  FILL_MIN_STOPS,
  FILL_MODE_NAMES,
  FILL_SCHEMA_FOR_TESTS,
} from '@editmamei/tools/gimp-fill-tools.ts';
import { TOOL_TIERS } from '@editmamei/core/tool-tiers.ts';
import { TOOL_GROUPS } from '@editmamei/core/tool-groups.ts';
import { MUTATING_TOOLS } from '@editmamei/core/tool-activity.ts';
import { TOOL_TIMEOUT_BUDGETS_MS } from '@editmamei/utils/operation-timeouts.ts';
import { makeGimpBackend } from '../fixtures/fake-gimp-session.ts';
import { callTool, assertToolShape } from '../fixtures/tool-helpers.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB_PY = readFileSync(
  join(resolve(__dirname, '..', '..'), 'src', 'backends', 'gimp', 'bridge', 'lib.py'),
  'utf8'
);

const RESULT = {
  layer_id: 9,
  layer_name: 'Gradient',
  op: 'linear_gradient',
  mode: 'normal',
  opacity: 100,
  masked: false,
};

const STOPS = [
  { offset: 0, color: '#000000' },
  { offset: 1, color: '#ffffff', opacity: 50 },
];

describe('createGimpFillTools', () => {
  it('returns 1 well-formed tool with this name', () => {
    const tools = createGimpFillTools(makeGimpBackend().asBackend());
    expect(tools.map((t) => t.tool.name)).toEqual(['gimp_fill']);
    assertToolShape(tools);
    expect(tools[0]!.tool.description).toMatch(/^Headless GIMP: /);
    expect(tools[0]!.tool.description).toContain('Do NOT use for painting strokes');
  });

  it('is registered at tier dev, group layers, mutating, with a timeout budget', () => {
    expect(TOOL_TIERS['gimp_fill']).toBe('dev');
    expect(TOOL_GROUPS['gimp_fill']).toBe('layers');
    expect(MUTATING_TOOLS.has('gimp_fill')).toBe(true);
    expect(TOOL_TIMEOUT_BUDGETS_MS['gimp_fill']).toBeGreaterThanOrEqual(30_000);
  });

  it('rejects bad arguments before reaching the bridge', async () => {
    const gimp = makeGimpBackend({ result: RESULT });
    const tools = createGimpFillTools(gimp.asBackend());
    const eight = Array.from({ length: 9 }, (_, i) => ({ offset: i / 10, color: '#000000' }));
    const cases: Array<Record<string, unknown>> = [
      {},
      { image: 1 }, // no op
      { image: 1, op: 'spiral' },
      { image: 1, op: 'solid' }, // no colour
      { image: 1, op: 'solid', color: 'red' },
      { image: 1, op: 'solid', color: '#abc' },
      { image: 1, op: 'solid', color: '#12345g' },
      { image: 1, op: 'solid', color: '#000000', stops: STOPS },
      { image: 1, op: 'solid', color: '#000000', mode: 'hsl-color' },
      { image: 1, op: 'solid', color: '#000000', opacity: 101 },
      { image: 1, op: 'linear_gradient' }, // no stops
      { image: 1, op: 'linear_gradient', stops: STOPS.slice(0, 1) },
      { image: 1, op: 'linear_gradient', stops: eight },
      { image: 1, op: 'linear_gradient', stops: [...STOPS].reverse() }, // unsorted
      {
        image: 1,
        op: 'linear_gradient',
        stops: [{ offset: 0, color: '#12' }, STOPS[1]],
      },
      { image: 1, op: 'linear_gradient', stops: [{ offset: 2, color: '#000000' }, STOPS[1]] },
      {
        image: 1,
        op: 'linear_gradient',
        stops: [{ offset: 0, color: '#000000', opacity: 120 }, STOPS[1]],
      },
      { image: 1, op: 'linear_gradient', stops: STOPS, color: '#000000' },
      { image: 1, op: 'linear_gradient', stops: STOPS, start: { x: 1 } },
      { image: 1, op: 'linear_gradient', stops: STOPS, center: { x: 1, y: 1 } },
      { image: 1, op: 'linear_gradient', stops: STOPS, radius: 10 },
      { image: 1, op: 'radial_gradient', stops: STOPS, radius: 0 },
      { image: 1, op: 'radial_gradient', stops: STOPS, center: { x: 'a', y: 1 } },
      { image: 1, op: 'radial_gradient', stops: STOPS, end: { x: 1, y: 1 } },
      // geometry and string bounds
      { image: 1, op: 'radial_gradient', stops: STOPS, center: { x: 1e308, y: 0 } },
      {
        image: 1,
        op: 'radial_gradient',
        stops: STOPS,
        center: { x: 0, y: -FILL_MAX_COORD_PX - 1 },
      },
      { image: 1, op: 'radial_gradient', stops: STOPS, radius: FILL_MAX_COORD_PX + 1 },
      { image: 1, op: 'linear_gradient', stops: STOPS, start: { x: 0, y: 1e308 } },
      {
        image: 1,
        op: 'linear_gradient',
        stops: STOPS,
        start: { x: 5, y: 5 },
        end: { x: 5, y: 5.5 }, // under 1 px apart
      },
      { image: 1, op: 'solid', color: '#000000', name: 'x'.repeat(FILL_MAX_STRING_LEN + 1) },
      { image: 1, op: 'solid', color: '#000000', mask: 'x'.repeat(FILL_MAX_STRING_LEN + 1) },
    ];
    for (const bad of cases) {
      const result = await callTool(tools, 'gimp_fill', bad);
      expect(result.isError, JSON.stringify(bad).slice(0, 90)).toBe(true);
    }
    expect(gimp.calls).toHaveLength(0);
  });

  it('dispatches a gradient, dropping undeclared keys', async () => {
    const gimp = makeGimpBackend({ result: RESULT });
    const tools = createGimpFillTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_fill', {
      image: 1,
      op: 'linear_gradient',
      stops: STOPS,
      start: { x: 0, y: 0 },
      end: { x: 100, y: 0 },
      mode: 'lch_color',
      mask: 'Shirt',
      undeclared: true,
    });
    expect(result.isError).toBeFalsy();
    expect(gimp.lastCall()).toEqual({
      op: 'fill',
      args: {
        image: 1,
        op: 'linear_gradient',
        stops: STOPS,
        start: { x: 0, y: 0 },
        end: { x: 100, y: 0 },
        mode: 'lch_color',
        mask: 'Shirt',
        opacity: 100,
      },
    });
    expect((result.content?.[0] as { text: string }).text).toContain('new layer "Gradient"');
  });

  it('dispatches a solid fill', async () => {
    const gimp = makeGimpBackend({ result: { ...RESULT, op: 'solid', layer_name: 'Fill' } });
    const tools = createGimpFillTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_fill', { image: 2, op: 'solid', color: '#AABBCC' });
    expect(result.isError).toBeFalsy();
    expect(gimp.lastCall()).toEqual({
      op: 'fill',
      args: { image: 2, op: 'solid', color: '#AABBCC', mode: 'normal', opacity: 100 },
    });
  });
});

describe('gimp_fill schema bounds mirror lib.py', () => {
  const props = FILL_SCHEMA_FOR_TESTS.properties as Record<string, Record<string, unknown>>;
  const constant = (name: string): number => {
    const m = new RegExp(`^${name}\\s*=\\s*([\\d_]+)`, 'm').exec(LIB_PY);
    if (!m) throw new Error(`${name} not found in lib.py`);
    return Number(m[1]!.replace(/_/g, ''));
  };

  it('stop counts', () => {
    expect(FILL_MIN_STOPS).toBe(constant('FILL_MIN_STOPS'));
    expect(FILL_MAX_STOPS).toBe(constant('FILL_MAX_STOPS'));
    expect(props.stops?.minItems).toBe(FILL_MIN_STOPS);
    expect(props.stops?.maxItems).toBe(FILL_MAX_STOPS);
  });

  it('geometry and string caps', () => {
    expect(FILL_MAX_COORD_PX).toBe(10 * constant('MAX_RESIZE_SIDE_PX'));
    expect(FILL_MAX_STRING_LEN).toBe(constant('FILL_MAX_STRING_LEN'));
    expect(props.radius?.maximum).toBe(FILL_MAX_COORD_PX);
  });

  it('blend modes: gimp_layer list plus lch_color', () => {
    const layerBlock = /^LAYER_MODES = \{([\s\S]*?)^\}/m.exec(LIB_PY)![1]!;
    const names = [...layerBlock.matchAll(/'([a-z_]+)':/g)].map((m) => m[1]!);
    expect([...FILL_MODE_NAMES]).toEqual([...names, 'lch_color']);
    expect(props.mode?.enum).toEqual([...FILL_MODE_NAMES]);
  });
});
