import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createGimpMatchTools, MATCH_SCHEMA_FOR_TESTS } from '@editmamei/tools/gimp-match-tools.ts';
import { TOOL_TIERS } from '@editmamei/core/tool-tiers.ts';
import { TOOL_GROUPS } from '@editmamei/core/tool-groups.ts';
import { TOOL_TIMEOUT_BUDGETS_MS } from '@editmamei/utils/operation-timeouts.ts';
import { makeGimpBackend } from '../fixtures/fake-gimp-session.ts';
import { callTool, assertToolShape } from '../fixtures/tool-helpers.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB_PY = readFileSync(
  join(resolve(__dirname, '..', '..'), 'src', 'backends', 'gimp', 'bridge', 'lib.py'),
  'utf8'
);

const RESULT = {
  layer: 'Subject',
  layer_id: 7,
  match: 'both',
  reference: 'surround',
  strength: 70,
  filters: [{ filter_id: 1, name: 'Match red', channel: 'red' }],
  replaced_filter_ids: [],
  measured: { layer_pixels: 3600, reference_pixels: 4652 },
  channels: {
    red: {
      before: { mean: 220, std: 0 },
      after: { mean: 122, std: 0 },
      reference: { mean: 80, std: 0 },
      gain: 1,
    },
  },
  edge: null,
};

describe('createGimpMatchTools', () => {
  it('returns 1 well-formed tool with this name', () => {
    const tools = createGimpMatchTools(makeGimpBackend().asBackend());
    expect(tools.map((t) => t.tool.name)).toEqual(['gimp_match_layer']);
    assertToolShape(tools);
    expect(tools[0]!.tool.description).toMatch(/^Headless GIMP: /);
  });

  it('is registered at tier dev, group layers, with a timeout budget', () => {
    expect(TOOL_TIERS['gimp_match_layer']).toBe('dev');
    expect(TOOL_GROUPS['gimp_match_layer']).toBe('layers');
    expect(TOOL_TIMEOUT_BUDGETS_MS['gimp_match_layer']).toBeGreaterThanOrEqual(60_000);
  });

  it('requires image and rejects out-of-range options before reaching the bridge', async () => {
    const gimp = makeGimpBackend();
    const tools = createGimpMatchTools(gimp.asBackend());
    expect((await callTool(tools, 'gimp_match_layer', {})).isError).toBe(true);
    for (const bad of [
      { strength: 101 },
      { match: 'hue' },
      { reference: 'above' },
      { surround_px: 0 },
      { edge_contract_px: 21 },
      { edge_feather_px: 51 },
    ]) {
      expect((await callTool(tools, 'gimp_match_layer', { image: 1, ...bad })).isError).toBe(true);
    }
    expect(gimp.calls).toHaveLength(0);
  });

  it('dispatches the match_layer op with the declared defaults and layer_id', async () => {
    const gimp = makeGimpBackend({ result: RESULT });
    const tools = createGimpMatchTools(gimp.asBackend());
    await callTool(tools, 'gimp_match_layer', { image: 1, layer_id: 7, undeclared: true });
    expect(gimp.lastCall()).toEqual({
      op: 'match_layer',
      args: {
        image: 1,
        layer_id: 7,
        match: 'both',
        strength: 70,
        reference: 'surround',
        edge_contract_px: 0,
        edge_feather_px: 0,
      },
    });
  });

  it('forwards every option and reports what moved', async () => {
    const gimp = makeGimpBackend({
      result: {
        ...RESULT,
        replaced_filter_ids: [4, 5, 6],
        edge: { contract_px: 3, feather_px: 4, mask_created: true },
      },
    });
    const tools = createGimpMatchTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_match_layer', {
      image: 1,
      layer: 'Subject',
      match: 'tone',
      strength: 40,
      reference: 'below',
      surround_px: 50,
      edge_contract_px: 3,
      edge_feather_px: 4,
    });
    expect(gimp.lastCall().args).toMatchObject({
      layer: 'Subject',
      match: 'tone',
      strength: 40,
      reference: 'below',
      surround_px: 50,
      edge_contract_px: 3,
      edge_feather_px: 4,
    });
    const text = (result.content?.[0] as { text: string }).text;
    expect(text).toContain('replacing 3 earlier');
    expect(text).toContain('red 220 -> 122');
    expect(text).toContain('contracted 3 px, feathered 4 px');
    expect(result.structuredContent).toMatchObject({ layer_id: 7 });
  });

  it('maps a bridge refusal through toolGimpErrorResult', async () => {
    const gimp = makeGimpBackend({
      throwFor: () => new Error('invalid_argument: layer "T" is locked; unlock it first'),
    });
    const tools = createGimpMatchTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_match_layer', { image: 1 });
    expect(result.isError).toBe(true);
    expect((result.content?.[0] as { text: string }).text).toContain('locked');
  });

  it('names no dev-tier tool in its own text', () => {
    const tools = createGimpMatchTools(makeGimpBackend().asBackend());
    const text = JSON.stringify(tools[0]!.tool.inputSchema) + tools[0]!.tool.description;
    for (const name of text.match(/gimp_[a-z_]+/g) ?? []) {
      if (name === 'gimp_match_layer') continue;
      expect(TOOL_TIERS[name], `${name} is community-tier`).toBe('community');
    }
  });
});

describe('gimp_match_layer schema bounds match bridge/lib.py', () => {
  const props = MATCH_SCHEMA_FOR_TESTS.properties ?? {};
  const constant = (name: string): number => {
    const m = new RegExp(`^${name}\\s*=\\s*([0-9.]+)`, 'm').exec(LIB_PY);
    if (!m) throw new Error(`${name} not found in lib.py`);
    return Number(m[1]);
  };

  it('numeric bounds and defaults', () => {
    expect(props.strength?.minimum).toBe(0);
    expect(props.strength?.maximum).toBe(100);
    expect(props.strength?.default).toBe(constant('MATCH_DEFAULT_STRENGTH'));
    expect(props.surround_px?.minimum).toBe(1);
    expect(props.surround_px?.maximum).toBe(constant('MATCH_SURROUND_MAX_PX'));
    expect(props.edge_contract_px?.maximum).toBe(constant('MATCH_MAX_EDGE_CONTRACT_PX'));
    expect(props.edge_feather_px?.maximum).toBe(constant('MATCH_MAX_EDGE_FEATHER_PX'));
  });

  it('the match and reference enums are lib.py’s tuples, defaults first', () => {
    const tuple = (name: string): string[] => {
      const m = new RegExp(`^${name}\\s*=\\s*\\(([^)]*)\\)`, 'm').exec(LIB_PY);
      if (!m) throw new Error(`${name} not found in lib.py`);
      return [...m[1]!.matchAll(/'([a-z]+)'/g)].map((x) => x[1]!);
    };
    expect(props.match?.enum).toEqual(tuple('MATCH_MODES'));
    expect(props.reference?.enum).toEqual(tuple('MATCH_REFERENCES'));
    expect(props.match?.default).toBe('both');
    expect(props.reference?.default).toBe('surround');
  });
});
