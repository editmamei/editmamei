import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  createGimpEffectTools,
  EFFECT_SCHEMA_FOR_TESTS,
} from '@editmamei/tools/gimp-effect-tools.ts';
import { makeGimpBackend } from '../fixtures/fake-gimp-session.ts';
import { callTool, assertToolShape } from '../fixtures/tool-helpers.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

describe('createGimpEffectTools', () => {
  it('returns 1 well-formed tool with this name', () => {
    const gimp = makeGimpBackend();
    const tools = createGimpEffectTools(gimp.asBackend());
    expect(tools.map((t) => t.tool.name)).toEqual(['gimp_add_effect']);
    assertToolShape(tools);
  });

  it('requires image and type', async () => {
    const gimp = makeGimpBackend();
    const tools = createGimpEffectTools(gimp.asBackend());
    expect((await callTool(tools, 'gimp_add_effect', { type: 'vignette' })).isError).toBe(true);
    expect((await callTool(tools, 'gimp_add_effect', { image: 1 })).isError).toBe(true);
    expect(gimp.calls).toHaveLength(0);
  });

  it('dispatches the bridge op ("effect") for every type', async () => {
    const gimp = makeGimpBackend({
      result: { filter_id: 1, name: 'Vignette', type: 'vignette', mask: null },
    });
    const tools = createGimpEffectTools(gimp.asBackend());
    await callTool(tools, 'gimp_add_effect', { image: 1, type: 'vignette', radius: 1.5 });
    expect(gimp.lastCall().op).toBe('effect');
  });

  it('forwards args verbatim, scoped to the schema-declared keys', async () => {
    const gimp = makeGimpBackend({
      result: { filter_id: 2, name: 'Vignette', type: 'vignette', mask: null },
    });
    const tools = createGimpEffectTools(gimp.asBackend());
    await callTool(tools, 'gimp_add_effect', {
      image: 1,
      type: 'vignette',
      radius: 1.5,
      softness: 0.6,
    });
    expect(gimp.lastCall()).toEqual({
      op: 'effect',
      args: { image: 1, type: 'vignette', radius: 1.5, softness: 0.6 },
    });
  });

  it('a re-edit (filter_id given) omits every other per-effect field it did not mention — the merge contract', async () => {
    const gimp = makeGimpBackend({
      result: { filter_id: 9, name: 'Motion Blur', type: 'motion_blur', mask: null },
    });
    const tools = createGimpEffectTools(gimp.asBackend());
    await callTool(tools, 'gimp_add_effect', {
      image: 1,
      type: 'motion_blur',
      filter_id: 9,
      angle: 45,
    });
    // No schema `default` for `length` (see the file's own doc comment) means validateArgs never
    // injects one — the bridge args carry ONLY what was given, so its own merge-not-reset logic
    // (resolve_field) decides `length`.
    expect(gimp.lastCall()).toEqual({
      op: 'effect',
      args: { image: 1, type: 'motion_blur', filter_id: 9, angle: 45 },
    });
    expect(gimp.lastCall().args).not.toHaveProperty('length');
  });

  it('reports "Added" for a new filter and "Updated" for a re-edit (filter_id given)', async () => {
    const gimp = makeGimpBackend({
      result: { filter_id: 3, name: 'Drop Shadow', type: 'drop_shadow', mask: null },
    });
    const tools = createGimpEffectTools(gimp.asBackend());
    const created = await callTool(tools, 'gimp_add_effect', { image: 1, type: 'drop_shadow' });
    expect((created.content?.[0] as { text: string }).text).toContain('Added drop_shadow filter');
    const updated = await callTool(tools, 'gimp_add_effect', {
      image: 1,
      type: 'drop_shadow',
      filter_id: 3,
    });
    expect((updated.content?.[0] as { text: string }).text).toContain('Updated drop_shadow filter');
  });

  it('reports the mask when the bridge confines a new filter to one', async () => {
    const gimp = makeGimpBackend({
      result: { filter_id: 4, name: 'Vignette', type: 'vignette', mask: 'Corners' },
    });
    const tools = createGimpEffectTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_add_effect', {
      image: 1,
      type: 'vignette',
      mask: 'Corners',
    });
    expect((result.content?.[0] as { text: string }).text).toContain('confined to mask "Corners"');
  });

  it('maps a bridge invalid_argument error through toolGimpErrorResult', async () => {
    const gimp = makeGimpBackend({
      throwFor: () => new Error('invalid_argument: radius must be within 0.0..3.0'),
    });
    const tools = createGimpEffectTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_add_effect', {
      image: 1,
      type: 'vignette',
      radius: 5,
    });
    expect(result.isError).toBe(true);
    expect((result.content?.[0] as { text: string }).text).toContain('invalid_argument');
  });
});

// ---------------------------------------------------------------------------
// Schema-bounds drift test — cross-checks the TS schema's minimum/maximum against
// bridge/lib.py's actual validators (EFFECT_PARAM_BUILDERS), read as source text (lib.py is
// Python; this suite can't import it directly). Fails the moment either side's numeric bound
// changes without the other following. Mirrors tests/tools/gimp-adjustment-tools.test.ts's own
// drift test, but scoped to lib.py's EFFECT_* tables (`val`-named lambda params, deliberately
// NOT `v` — see lib.py's own comment, right above build_vignette_params (the start of its EFFECT
// builders), for why that keeps the two files' regex scans from cross-contaminating each other).
// ---------------------------------------------------------------------------

const LIB_PY = readFileSync(join(REPO_ROOT, 'src', 'backends', 'gimp', 'bridge', 'lib.py'), 'utf8');

/** Just the `build_*_params` function bodies (from `build_vignette_params` through the end of
 * `build_drop_shadow_params`, right before the `EFFECT_PARAM_BUILDERS = {` dict that follows
 * them) -- not the whole file. The `val`-vs-`v` naming trick already keeps this decoupled from
 * gimp-adjustment-tools.test.ts's own drift test, but scoping the SOURCE TEXT itself too means an
 * unrelated future function elsewhere in lib.py that happens to also use `val` (the geometry
 * transform helpers below EFFECT_PARAM_BUILDERS, say) can never silently fold a bound into this
 * table's own drift check either. */
const EFFECT_BUILDERS_SRC = LIB_PY.slice(
  LIB_PY.indexOf('def build_vignette_params'),
  LIB_PY.indexOf('EFFECT_PARAM_BUILDERS = {')
);

interface Bound {
  lo: number;
  hi: number;
}

/** Every (field, lo, hi) triple lib.py's EFFECT_PARAM_BUILDERS validate against, keyed by field
 * name -- a field validated more than once (a real cross-effect name collision) collects every
 * tuple it was found with. */
function parseEffectLibPyBounds(src: string): Map<string, Bound[]> {
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

const LIB_BOUNDS = parseEffectLibPyBounds(EFFECT_BUILDERS_SRC);

// Anti-vacuity floor -- if the regex above ever stops matching (a lib.py refactor changes the
// call shape), every assertion below would pass on an empty map. 10 is comfortably below the 15
// fields actually found today.
it('parseEffectLibPyBounds finds a healthy number of validated fields (sanity check the parser)', () => {
  expect(LIB_BOUNDS.size).toBeGreaterThan(10);
});

/** Fields lib.py validates under more than one bound (a genuine cross-effect name collision) --
 * the tool schema widens these to the UNION, per gimp-effect-tools.ts's own file doc comment. */
const KNOWN_COLLISION_FIELDS = new Set(['radius']);

describe('gimp_add_effect schema bounds match bridge/lib.py exactly (or its documented union)', () => {
  for (const [field, tuples] of LIB_BOUNDS) {
    const schemaProp = EFFECT_SCHEMA_FOR_TESTS.properties?.[field];
    it(`"${field}": schema bound tracks lib.py's validator${tuples.length > 1 ? ' (union of ' + tuples.length + ' colliding effects)' : ''}`, () => {
      expect(schemaProp, `no "${field}" property in the gimp_add_effect schema`).toBeDefined();
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

  it("the type enum matches lib.py's EFFECT_OPERATIONS keys exactly (both directions)", () => {
    const block = LIB_PY.match(/EFFECT_OPERATIONS = \{([\s\S]*?)\n\}/);
    expect(block, 'EFFECT_OPERATIONS not found in lib.py').toBeTruthy();
    const libTypes = [...block![1].matchAll(/'([a-z_]+)':\s*'[a-z]+:[a-z-]+'/g)].map((m) => m[1]);
    const schemaTypes = EFFECT_SCHEMA_FOR_TESTS.properties?.type?.enum as string[];
    expect([...schemaTypes].sort()).toEqual([...libTypes].sort());
  });

  it('"preserve_luminosity" is a boolean schema field with no numeric bound — build_black_white_params validates it with require_bool, not a bare bool()', () => {
    const prop = EFFECT_SCHEMA_FOR_TESTS.properties?.preserve_luminosity;
    expect(prop?.type).toBe('boolean');
    expect(prop?.minimum).toBeUndefined();
    expect(prop?.maximum).toBeUndefined();
    // Scoped to EFFECT_BUILDERS_SRC, not the whole file: build_color_balance_params (a gimp_add_
    // adjustment builder, unrelated to this schema) has its OWN 'preserve_luminosity' field via
    // `resolve_field(args, 'preserve_luminosity', defaults, 'preserve-luminosity', bool)` — an
    // unscoped search would match THAT instead, passing regardless of what black_white's own
    // builder actually does.
    expect(EFFECT_BUILDERS_SRC).toMatch(/require_bool\(args,\s*'preserve_luminosity'\)/);
  });

  // The reverse direction of the per-field loop above (which proves every lib.py-validated field
  // has a matching schema bound): every OTHER numeric schema property must itself map to a
  // lib.py-validated field, so a schema-only bound can never silently drift from a bridge that
  // doesn't (or no longer) enforces the same thing.
  const NON_NUMERIC_OR_SEPARATELY_HANDLED = new Set([
    'image',
    'layer',
    'type',
    'filter_id',
    'mask',
    'name',
    'preserve_luminosity', // boolean, asserted separately above
  ]);

  it('every OTHER numeric schema property maps to a lib.py-validated field (no orphaned schema-only bound)', () => {
    const props = EFFECT_SCHEMA_FOR_TESTS.properties ?? {};
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

it('the vignette field descriptions state the creation defaults lib.py actually uses', () => {
  const m = LIB_PY.match(
    /'vignette': \{'radius': ([\d.]+), 'softness': ([\d.]+), 'gamma': ([\d.]+)/
  );
  expect(m, "EFFECT_CREATE_DEFAULTS['vignette'] not found in lib.py").not.toBeNull();
  const [, radius, softness, gamma] = m!;
  const props = EFFECT_SCHEMA_FOR_TESTS.properties ?? {};
  expect(props.radius?.description).toContain(`Default (when creating): ${radius},`);
  expect(props.softness?.description).toContain(`Default (when creating): ${softness}.`);
  expect(props.gamma?.description).toContain(`Default (when creating): ${gamma}.`);
});
