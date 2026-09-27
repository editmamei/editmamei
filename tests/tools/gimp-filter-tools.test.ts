import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  createGimpFilterTools,
  FILTER_SCHEMA_FOR_TESTS,
} from '@editmamei/tools/gimp-filter-tools.ts';
import { makeGimpBackend } from '../fixtures/fake-gimp-session.ts';
import { callTool, assertToolShape } from '../fixtures/tool-helpers.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

describe('createGimpFilterTools', () => {
  it('returns 1 well-formed tool with this name', () => {
    const gimp = makeGimpBackend();
    const tools = createGimpFilterTools(gimp.asBackend());
    expect(tools.map((t) => t.tool.name)).toEqual(['gimp_filter']);
    assertToolShape(tools);
  });

  it('requires image and op', async () => {
    const gimp = makeGimpBackend();
    const tools = createGimpFilterTools(gimp.asBackend());
    expect((await callTool(tools, 'gimp_filter', { op: 'list' })).isError).toBe(true);
    expect((await callTool(tools, 'gimp_filter', { image: 1 })).isError).toBe(true);
    expect(gimp.calls).toHaveLength(0);
  });

  it("op='list' dispatches filter and reports the filter count", async () => {
    const gimp = makeGimpBackend({ result: { filters: [{ filter_id: 1 }, { filter_id: 2 }] } });
    const tools = createGimpFilterTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_filter', { image: 5, op: 'list' });
    expect(gimp.lastCall()).toEqual({ op: 'filter', args: { image: 5, op: 'list' } });
    expect(result.isError).toBeFalsy();
    expect((result.content?.[0] as { text: string }).text).toContain('2 filter(s)');
  });

  it("op='set_visibility' dispatches with filter_id + visible", async () => {
    const gimp = makeGimpBackend({ result: { filter_id: 3, visible: false } });
    const tools = createGimpFilterTools(gimp.asBackend());
    await callTool(tools, 'gimp_filter', {
      image: 5,
      op: 'set_visibility',
      filter_id: 3,
      visible: false,
    });
    expect(gimp.lastCall()).toEqual({
      op: 'filter',
      args: { image: 5, op: 'set_visibility', filter_id: 3, visible: false },
    });
  });

  it("op='delete' dispatches with filter_id", async () => {
    const gimp = makeGimpBackend({ result: { filter_id: 3, name: 'Curves', deleted: true } });
    const tools = createGimpFilterTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_filter', { image: 5, op: 'delete', filter_id: 3 });
    expect(gimp.lastCall()).toEqual({
      op: 'filter',
      args: { image: 5, op: 'delete', filter_id: 3 },
    });
    expect((result.content?.[0] as { text: string }).text).toContain('Deleted filter 3');
  });

  it("'reorder' is not a valid op (dropped from the beta — GIMP has no API for it)", async () => {
    const gimp = makeGimpBackend();
    const tools = createGimpFilterTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_filter', { image: 5, op: 'reorder' });
    expect(result.isError).toBe(true);
    expect(gimp.calls).toHaveLength(0);
  });

  it('maps a bridge invalid_argument error through toolGimpErrorResult', async () => {
    const gimp = makeGimpBackend({
      throwFor: () => new Error('invalid_argument: no filter with id 99 on image 5'),
    });
    const tools = createGimpFilterTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_filter', { image: 5, op: 'delete', filter_id: 99 });
    expect(result.isError).toBe(true);
    expect((result.content?.[0] as { text: string }).text).toContain('invalid_argument');
  });
});

describe('gimp_filter op dispatch', () => {
  it('refuses an op outside list/set_visibility/delete/apply without dispatching, even if the schema enum were loosened', async () => {
    // The schema enum rejects this first today; the handler's own fallback is the second line.
    // Loosen the enum for this test only, so the handler itself is exercised.
    const gimp = makeGimpBackend({ result: { filter_id: 1, name: 'x', deleted: true } });
    const tools = createGimpFilterTools(gimp.asBackend());
    const opProp = (
      tools[0]!.tool.inputSchema as unknown as { properties: { op: { enum: string[] } } }
    ).properties.op;
    const saved = opProp.enum;
    opProp.enum = [...saved, 'reorder'];
    try {
      const result = await callTool(tools, 'gimp_filter', {
        image: 1,
        op: 'reorder',
        filter_id: 1,
      });
      expect(result.isError).toBe(true);
      expect((result.content?.[0] as { text: string }).text).toMatch(/reorder/);
      expect(gimp.calls).toHaveLength(0);
    } finally {
      opProp.enum = saved;
    }
  });
});

describe('gimp_filter op=apply', () => {
  it('requires filter for apply (validated bridge-side, not by the tool schema alone)', async () => {
    const gimp = makeGimpBackend({
      throwFor: () => new Error('invalid_argument: filter must be one of [...]'),
    });
    const tools = createGimpFilterTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_filter', { image: 1, op: 'apply' });
    expect(result.isError).toBe(true);
  });

  it('dispatches the SAME bridge op ("filter") apply uses as list/set_visibility/delete', async () => {
    const gimp = makeGimpBackend({
      result: { filter_id: 1, name: 'Vignette', type: 'vignette', mask: null },
    });
    const tools = createGimpFilterTools(gimp.asBackend());
    await callTool(tools, 'gimp_filter', {
      image: 1,
      op: 'apply',
      filter: 'vignette',
      radius: 1.5,
    });
    expect(gimp.lastCall().op).toBe('filter');
  });

  it('forwards apply args verbatim, scoped to the schema-declared keys', async () => {
    const gimp = makeGimpBackend({
      result: { filter_id: 2, name: 'Vignette', type: 'vignette', mask: null },
    });
    const tools = createGimpFilterTools(gimp.asBackend());
    await callTool(tools, 'gimp_filter', {
      image: 1,
      op: 'apply',
      filter: 'vignette',
      radius: 1.5,
      softness: 0.6,
    });
    expect(gimp.lastCall()).toEqual({
      op: 'filter',
      args: { image: 1, op: 'apply', filter: 'vignette', radius: 1.5, softness: 0.6 },
    });
  });

  it('a re-edit (filter_id given) omits every other per-effect field it did not mention — the merge contract', async () => {
    const gimp = makeGimpBackend({
      result: { filter_id: 9, name: 'Motion Blur', type: 'motion_blur', mask: null },
    });
    const tools = createGimpFilterTools(gimp.asBackend());
    await callTool(tools, 'gimp_filter', {
      image: 1,
      op: 'apply',
      filter: 'motion_blur',
      filter_id: 9,
      angle: 45,
    });
    // No schema `default` for `length` (see the file's own doc comment) means validateArgs never
    // injects one — the bridge args carry ONLY what was given, so its own merge-not-reset logic
    // (resolve_field) decides `length`.
    expect(gimp.lastCall()).toEqual({
      op: 'filter',
      args: { image: 1, op: 'apply', filter: 'motion_blur', filter_id: 9, angle: 45 },
    });
    expect(gimp.lastCall().args).not.toHaveProperty('length');
  });

  it('reports "Added" for a new filter and "Updated" for a re-edit (filter_id given)', async () => {
    const gimp = makeGimpBackend({
      result: { filter_id: 3, name: 'Drop Shadow', type: 'drop_shadow', mask: null },
    });
    const tools = createGimpFilterTools(gimp.asBackend());
    const created = await callTool(tools, 'gimp_filter', {
      image: 1,
      op: 'apply',
      filter: 'drop_shadow',
    });
    expect((created.content?.[0] as { text: string }).text).toContain('Added drop_shadow filter');
    const updated = await callTool(tools, 'gimp_filter', {
      image: 1,
      op: 'apply',
      filter: 'drop_shadow',
      filter_id: 3,
    });
    expect((updated.content?.[0] as { text: string }).text).toContain('Updated drop_shadow filter');
  });

  it('reports the mask when the bridge confines a new filter to one', async () => {
    const gimp = makeGimpBackend({
      result: { filter_id: 4, name: 'Vignette', type: 'vignette', mask: 'Corners' },
    });
    const tools = createGimpFilterTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_filter', {
      image: 1,
      op: 'apply',
      filter: 'vignette',
      mask: 'Corners',
    });
    expect((result.content?.[0] as { text: string }).text).toContain('confined to mask "Corners"');
  });

  it('maps a bridge invalid_argument error through toolGimpErrorResult', async () => {
    const gimp = makeGimpBackend({
      throwFor: () => new Error('invalid_argument: radius must be within 0.0..3.0'),
    });
    const tools = createGimpFilterTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_filter', {
      image: 1,
      op: 'apply',
      filter: 'vignette',
      radius: 5,
    });
    expect(result.isError).toBe(true);
    expect((result.content?.[0] as { text: string }).text).toContain('invalid_argument');
  });
});

// ---------------------------------------------------------------------------
// Schema-bounds drift test — cross-checks the TS schema's minimum/maximum against
// bridge/lib.py's actual validators (FILTER_PARAM_BUILDERS), read as source text (lib.py is
// Python; this suite can't import it directly). Fails the moment either side's numeric bound
// changes without the other following. Mirrors tests/tools/gimp-adjustment-tools.test.ts's own
// drift test, but scoped to lib.py's FILTER_* tables (`val`-named lambda params, deliberately
// NOT `v` — see gimp-filter-tools.ts's own file doc comment for why that keeps the two files'
// regex scans from cross-contaminating each other).
// ---------------------------------------------------------------------------

const LIB_PY = readFileSync(join(REPO_ROOT, 'src', 'backends', 'gimp', 'bridge', 'lib.py'), 'utf8');

interface Bound {
  lo: number;
  hi: number;
}

/** Every (field, lo, hi) triple lib.py's FILTER_PARAM_BUILDERS validate against, keyed by field
 * name -- a field validated more than once (a real cross-effect name collision) collects every
 * tuple it was found with. */
function parseFilterLibPyBounds(src: string): Map<string, Bound[]> {
  const out = new Map<string, Bound[]>();
  const add = (name: string, lo: number, hi: number) => {
    const arr = out.get(name) ?? [];
    arr.push({ lo, hi });
    out.set(name, arr);
  };
  for (const m of src.matchAll(
    /validate_range\('([a-z_]+)',\s*val,\s*(-?[\d.]+),\s*(-?[\d.]+)\)/g
  )) {
    add(m[1], Number(m[2]), Number(m[3]));
  }
  for (const m of src.matchAll(
    /validate_int_range\('([a-z_]+)',\s*val,\s*(-?[\d.]+),\s*(-?[\d.]+)\)/g
  )) {
    add(m[1], Number(m[2]), Number(m[3]));
  }
  return out;
}

const LIB_BOUNDS = parseFilterLibPyBounds(LIB_PY);

// Anti-vacuity floor -- if the regex above ever stops matching (a lib.py refactor changes the
// call shape), every assertion below would pass on an empty map. 10 is comfortably below the 15
// fields actually found today.
it('parseFilterLibPyBounds finds a healthy number of validated fields (sanity check the parser)', () => {
  expect(LIB_BOUNDS.size).toBeGreaterThan(10);
});

/** Fields lib.py validates under more than one bound (a genuine cross-effect name collision) --
 * the tool schema widens these to the UNION, per gimp-filter-tools.ts's own file doc comment. */
const KNOWN_COLLISION_FIELDS = new Set(['radius']);

describe('gimp_filter apply schema bounds match bridge/lib.py exactly (or its documented union)', () => {
  for (const [field, tuples] of LIB_BOUNDS) {
    const schemaProp = FILTER_SCHEMA_FOR_TESTS.properties?.[field];
    it(`"${field}": schema bound tracks lib.py's validator${tuples.length > 1 ? ' (union of ' + tuples.length + ' colliding effects)' : ''}`, () => {
      expect(schemaProp, `no "${field}" property in the gimp_filter schema`).toBeDefined();
      const expectedLo = Math.min(...tuples.map((t) => t.lo));
      const expectedHi = Math.max(...tuples.map((t) => t.hi));
      if (tuples.length > 1) {
        expect(
          KNOWN_COLLISION_FIELDS.has(field),
          `"${field}" collides across effects in lib.py but is not in KNOWN_COLLISION_FIELDS — ` +
            "update that set (and the schema's own doc comment) if this is a genuine new collision."
        ).toBe(true);
      }
      expect(schemaProp?.minimum, `"${field}" minimum`).toBe(expectedLo);
      expect(schemaProp?.maximum, `"${field}" maximum`).toBe(expectedHi);
    });
  }

  it("the filter enum matches lib.py's FILTER_OPERATIONS keys exactly (both directions)", () => {
    const block = LIB_PY.match(/FILTER_OPERATIONS = \{([\s\S]*?)\n\}/);
    expect(block, 'FILTER_OPERATIONS not found in lib.py').toBeTruthy();
    const libFilters = [...block![1].matchAll(/'([a-z_]+)':\s*'[a-z]+:[a-z-]+'/g)].map((m) => m[1]);
    const schemaFilters = FILTER_SCHEMA_FOR_TESTS.properties?.filter?.enum as string[];
    expect([...schemaFilters].sort()).toEqual([...libFilters].sort());
  });

  it('"preserve_luminosity" is a boolean schema field with no numeric bound — build_black_white_params converts it with a bare bool(), not validate_range', () => {
    const prop = FILTER_SCHEMA_FOR_TESTS.properties?.preserve_luminosity;
    expect(prop?.type).toBe('boolean');
    expect(prop?.minimum).toBeUndefined();
    expect(prop?.maximum).toBeUndefined();
    expect(LIB_PY).toMatch(/'preserve_luminosity',\s*defaults,\s*'preserve-luminosity',\s*bool/);
  });

  // The reverse direction of the per-field loop above (which proves every lib.py-validated field
  // has a matching schema bound): every OTHER numeric schema property must itself map to a
  // lib.py-validated field, so a schema-only bound can never silently drift from a bridge that
  // doesn't (or no longer) enforces the same thing.
  const NON_NUMERIC_OR_SEPARATELY_HANDLED = new Set([
    'image',
    'layer',
    'op',
    'filter_id',
    'mask',
    'name',
    'visible',
    'filter', // enum, asserted separately above
    'preserve_luminosity', // boolean, asserted separately above
  ]);

  it('every OTHER numeric schema property maps to a lib.py-validated field (no orphaned schema-only bound)', () => {
    const props = FILTER_SCHEMA_FOR_TESTS.properties ?? {};
    for (const [name, prop] of Object.entries(props)) {
      if (NON_NUMERIC_OR_SEPARATELY_HANDLED.has(name)) continue;
      if (prop?.type !== 'number' && prop?.type !== 'integer') continue;
      expect(
        LIB_BOUNDS.has(name),
        `"${name}" has a numeric schema bound but no lib.py validator was found for it`
      ).toBe(true);
    }
  });
});
