import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  createGimpRetouchTools,
  RETOUCH_SCHEMA_FOR_TESTS,
} from '@editmamei/tools/gimp-retouch-tools.ts';
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
  layer_name: 'Retouch',
  created_layer: true,
  method: 'heal',
  painted_bbox: [10, 20, 30, 40],
};

const STROKE = {
  image: 1,
  method: 'heal',
  points: [
    [10, 10],
    [20, 10],
  ],
};

describe('createGimpRetouchTools', () => {
  it('returns 1 well-formed tool with this name', () => {
    const tools = createGimpRetouchTools(makeGimpBackend().asBackend());
    expect(tools.map((t) => t.tool.name)).toEqual(['gimp_retouch']);
    assertToolShape(tools);
    expect(tools[0]!.tool.description).toMatch(/^Headless GIMP: /);
    expect(tools[0]!.tool.description).toContain('Do NOT use for removing whole objects');
  });

  it('is registered at tier dev, group layers, mutating, with a timeout budget', () => {
    expect(TOOL_TIERS['gimp_retouch']).toBe('dev');
    expect(TOOL_GROUPS['gimp_retouch']).toBe('layers');
    expect(MUTATING_TOOLS.has('gimp_retouch')).toBe(true);
    expect(TOOL_TIMEOUT_BUDGETS_MS['gimp_retouch']).toBeGreaterThanOrEqual(120_000);
  });

  it('rejects bad arguments before reaching the bridge', async () => {
    const gimp = makeGimpBackend({ result: RESULT });
    const tools = createGimpRetouchTools(gimp.asBackend());
    const spot = { x: 5, y: 5, radius: 4 };
    const cases: Array<Record<string, unknown>> = [
      {}, // no image, no method
      { image: 1 }, // missing method
      { image: 1, method: 'blur' },
      { image: 1, method: 'heal', source_offset: { dx: 1, dy: 1 } }, // no points
      { ...STROKE }, // no source at all
      { ...STROKE, source: { x: 1, y: 1 }, source_offset: { dx: 1, dy: 1 } }, // both
      { ...STROKE, source: { x: 1 } },
      { ...STROKE, source_offset: { dx: 1, dy: 1 }, points: [] },
      { ...STROKE, source_offset: { dx: 1, dy: 1 }, points: [[1, 2, 3]] },
      { ...STROKE, source_offset: { dx: 1, dy: 1 }, points: Array(501).fill([1, 1]) },
      { ...STROKE, source_offset: { dx: 1, dy: 1 }, brush_size: 0 },
      { ...STROKE, source_offset: { dx: 1, dy: 1 }, brush_size: 1001 },
      { ...STROKE, source_offset: { dx: 1, dy: 1 }, hardness: 1.5 },
      { ...STROKE, source_offset: { dx: 1, dy: 1 }, target: 'elsewhere' },
      { ...STROKE, source_offset: { dx: 1, dy: 1 }, spots: [spot] },
      { image: 1, method: 'heal', source_layer_id: 3, points: [[1, 1]], source: { x: 2, y: 2 } },
      { image: 1, method: 'spot_heal' }, // no spots
      { image: 1, method: 'spot_heal', spots: [] },
      { image: 1, method: 'spot_heal', spots: Array(51).fill(spot) }, // too many
      { image: 1, method: 'spot_heal', spots: [{ x: 1, y: 1, radius: 0.5 }] },
      { image: 1, method: 'spot_heal', spots: [{ x: 1, y: 1, radius: 501 }] },
      { image: 1, method: 'spot_heal', spots: [{ x: 1, y: 1 }] },
      { image: 1, method: 'spot_heal', spots: [spot], points: [[1, 1]] },
    ];
    for (const bad of cases) {
      const result = await callTool(tools, 'gimp_retouch', bad);
      expect(result.isError, JSON.stringify(bad).slice(0, 80)).toBe(true);
    }
    expect(gimp.calls).toHaveLength(0);
  });

  it('dispatches a heal with the declared defaults and drops undeclared keys', async () => {
    const gimp = makeGimpBackend({ result: RESULT });
    const tools = createGimpRetouchTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_retouch', {
      ...STROKE,
      source: { x: 50, y: 60 },
      layer_id: 4,
      undeclared: true,
    });
    expect(result.isError).toBeFalsy();
    expect(gimp.lastCall()).toEqual({
      op: 'retouch',
      args: {
        image: 1,
        layer_id: 4,
        method: 'heal',
        points: [
          [10, 10],
          [20, 10],
        ],
        source: { x: 50, y: 60 },
        brush_size: 20,
        target: 'retouch_layer',
      },
    });
    expect((result.content?.[0] as { text: string }).text).toContain('new Retouch layer');
  });

  it('forwards a clone with every option and a spot_heal with its spots', async () => {
    const gimp = makeGimpBackend({ result: RESULT });
    const tools = createGimpRetouchTools(gimp.asBackend());
    await callTool(tools, 'gimp_retouch', {
      image: 1,
      method: 'clone',
      points: [[5, 5]],
      source_offset: { dx: -3, dy: 4 },
      brush_size: 12,
      hardness: 1,
      source_layer_id: 8,
      target: 'in_place',
    });
    expect(gimp.lastCall().args).toMatchObject({
      method: 'clone',
      source_offset: { dx: -3, dy: 4 },
      brush_size: 12,
      hardness: 1,
      source_layer_id: 8,
      target: 'in_place',
    });
    const spots = [{ x: 5, y: 6, radius: 4 }];
    const healed = await callTool(tools, 'gimp_retouch', { image: 1, method: 'spot_heal', spots });
    expect(healed.isError).toBeFalsy();
    expect(gimp.lastCall().args).toMatchObject({ method: 'spot_heal', spots });
  });

  it('maps a bridge refusal through toolGimpErrorResult', async () => {
    const gimp = makeGimpBackend({
      throwFor: () => new Error('invalid_argument: cannot retouch a layer group'),
    });
    const tools = createGimpRetouchTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_retouch', {
      ...STROKE,
      source_offset: { dx: 1, dy: 1 },
    });
    expect(result.isError).toBe(true);
    expect((result.content?.[0] as { text: string }).text).toContain('layer group');
  });

  it('names no dev-tier tool in its own text', () => {
    const tools = createGimpRetouchTools(makeGimpBackend().asBackend());
    const text = JSON.stringify(tools[0]!.tool.inputSchema) + tools[0]!.tool.description;
    for (const name of text.match(/gimp_[a-z_]+/g) ?? []) {
      if (name === 'gimp_retouch') continue;
      expect(TOOL_TIERS[name], `${name} is community-tier`).toBe('community');
    }
  });
});

describe('gimp_retouch schema bounds match bridge/lib.py', () => {
  const props = RETOUCH_SCHEMA_FOR_TESTS.properties ?? {};
  const constant = (name: string): number => {
    const m = new RegExp(`^${name}\\s*=\\s*([0-9.]+)`, 'm').exec(LIB_PY);
    if (!m) throw new Error(`${name} not found in lib.py`);
    return Number(m[1]);
  };
  const tuple = (name: string): string[] => {
    const m = new RegExp(`^${name}\\s*=\\s*\\(([^)]*)\\)`, 'm').exec(LIB_PY);
    if (!m) throw new Error(`${name} not found in lib.py`);
    return [...m[1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!);
  };

  it('counts, ranges and enums', () => {
    expect(props.points?.maxItems).toBe(constant('RETOUCH_MAX_POINTS'));
    expect(props.spots?.maxItems).toBe(constant('RETOUCH_MAX_SPOTS'));
    expect(props.brush_size?.minimum).toBe(constant('RETOUCH_MIN_BRUSH'));
    expect(props.brush_size?.maximum).toBe(constant('RETOUCH_MAX_BRUSH'));
    expect(props.brush_size?.default).toBe(constant('RETOUCH_DEFAULT_BRUSH'));
    expect(props.method?.enum).toEqual(tuple('RETOUCH_METHODS'));
    expect(props.target?.enum).toEqual(tuple('RETOUCH_TARGETS'));
    expect(props.target?.default).toBe('retouch_layer');
    expect(LIB_PY).toMatch(/RETOUCH_MAX_SPOT_RADIUS = 500/);
  });
});
