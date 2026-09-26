import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  createGimpAdjustmentTools,
  ADJUST_SCHEMA_FOR_TESTS,
} from '@editmamei/tools/gimp-adjustment-tools.ts';
import { makeGimpBackend } from '../fixtures/fake-gimp-session.ts';
import { callTool, assertToolShape } from '../fixtures/tool-helpers.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

describe('createGimpAdjustmentTools', () => {
  it('returns 1 well-formed tool with this name', () => {
    const gimp = makeGimpBackend();
    const tools = createGimpAdjustmentTools(gimp.asBackend());
    expect(tools.map((t) => t.tool.name)).toEqual(['gimp_add_adjustment']);
    assertToolShape(tools);
  });

  it('requires image and type', async () => {
    const gimp = makeGimpBackend();
    const tools = createGimpAdjustmentTools(gimp.asBackend());
    expect((await callTool(tools, 'gimp_add_adjustment', { type: 'exposure' })).isError).toBe(true);
    expect((await callTool(tools, 'gimp_add_adjustment', { image: 1 })).isError).toBe(true);
    expect(gimp.calls).toHaveLength(0);
  });

  it('dispatches the SAME bridge op ("adjust") for every type', async () => {
    const gimp = makeGimpBackend({
      result: { filter_id: 1, name: 'Exposure', type: 'exposure', mask: null },
    });
    const tools = createGimpAdjustmentTools(gimp.asBackend());
    await callTool(tools, 'gimp_add_adjustment', { image: 1, type: 'exposure', exposure: 1.5 });
    expect(gimp.lastCall().op).toBe('adjust');
  });

  it('forwards curves points + channel verbatim', async () => {
    const gimp = makeGimpBackend({
      result: { filter_id: 2, name: 'Curves', type: 'curves', mask: null },
    });
    const tools = createGimpAdjustmentTools(gimp.asBackend());
    await callTool(tools, 'gimp_add_adjustment', {
      image: 1,
      type: 'curves',
      channel: 'red',
      points: [
        [0, 0],
        [255, 255],
      ],
    });
    expect(gimp.lastCall()).toEqual({
      op: 'adjust',
      args: {
        image: 1,
        type: 'curves',
        channel: 'red',
        points: [
          [0, 0],
          [255, 255],
        ],
      },
    });
  });

  it('a re-edit (filter_id given) omits every other per-type field it did not mention — the merge contract', async () => {
    const gimp = makeGimpBackend({
      result: {
        filter_id: 9,
        name: 'Brightness/Contrast',
        type: 'brightness_contrast',
        mask: null,
      },
    });
    const tools = createGimpAdjustmentTools(gimp.asBackend());
    await callTool(tools, 'gimp_add_adjustment', {
      image: 1,
      type: 'brightness_contrast',
      filter_id: 9,
      contrast: 50,
    });
    // No schema `default` for `brightness` (see the file's own doc comment) means
    // validateArgs never injects one — the bridge args carry ONLY what was given,
    // so its own merge-not-reset logic (resolve_field) is what decides `brightness`.
    expect(gimp.lastCall()).toEqual({
      op: 'adjust',
      args: { image: 1, type: 'brightness_contrast', filter_id: 9, contrast: 50 },
    });
    expect(gimp.lastCall().args).not.toHaveProperty('brightness');
  });

  it('color_temperature: to_kelvin is forwarded as given (direction handled bridge-side, described in the schema)', async () => {
    const gimp = makeGimpBackend({
      result: { filter_id: 4, name: 'Color Temperature', type: 'color_temperature', mask: null },
    });
    const tools = createGimpAdjustmentTools(gimp.asBackend());
    await callTool(tools, 'gimp_add_adjustment', {
      image: 1,
      type: 'color_temperature',
      from_kelvin: 6500,
      to_kelvin: 8000,
    });
    expect(gimp.lastCall().args).toMatchObject({ from_kelvin: 6500, to_kelvin: 8000 });
  });

  it('a NEW vibrance filter created with no vibrance given flags in the text that only saturation changed', async () => {
    const gimp = makeGimpBackend({
      result: { filter_id: 5, name: 'Vibrance', type: 'vibrance', mask: null },
    });
    const tools = createGimpAdjustmentTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_add_adjustment', {
      image: 1,
      type: 'vibrance',
      saturation: 1.2,
    });
    expect((result.content?.[0] as { text: string }).text).toContain('vibrance defaulted to 0');
  });

  it('a NEW vibrance filter that DOES set vibrance is not flagged', async () => {
    const gimp = makeGimpBackend({
      result: { filter_id: 6, name: 'Vibrance', type: 'vibrance', mask: null },
    });
    const tools = createGimpAdjustmentTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_add_adjustment', {
      image: 1,
      type: 'vibrance',
      vibrance: 40,
    });
    expect((result.content?.[0] as { text: string }).text).not.toContain('vibrance defaulted to 0');
  });

  it('a re-edit (filter_id given) of a vibrance filter is never flagged, even without vibrance', async () => {
    const gimp = makeGimpBackend({
      result: { filter_id: 7, name: 'Vibrance', type: 'vibrance', mask: null },
    });
    const tools = createGimpAdjustmentTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_add_adjustment', {
      image: 1,
      type: 'vibrance',
      filter_id: 7,
      saturation: 1.2,
    });
    expect((result.content?.[0] as { text: string }).text).not.toContain('vibrance defaulted to 0');
  });

  it('maps a bridge invalid_argument error through toolGimpErrorResult', async () => {
    // exposure: 5 is within the SCHEMA's own -10..10 bound, so validateArgs lets it
    // through to the (fake) bridge, which is what actually throws here — this is
    // testing the bridge-error mapping path, not the schema's own rejection.
    const gimp = makeGimpBackend({
      throwFor: () => new Error('invalid_argument: exposure must be within -10.0..10.0'),
    });
    const tools = createGimpAdjustmentTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_add_adjustment', {
      image: 1,
      type: 'exposure',
      exposure: 5,
    });
    expect(result.isError).toBe(true);
    expect((result.content?.[0] as { text: string }).text).toContain('invalid_argument');
  });
});

// ---------------------------------------------------------------------------
// Schema-bounds drift test — cross-checks the TS schema's minimum/maximum
// against bridge/lib.py's actual validators (ADJUST_PARAM_BUILDERS), read as
// source text (lib.py is Python; this suite can't import it directly). Fails
// the moment either side's numeric bound changes without the other following.
//
// Scope: fields lib.py's builders themselves range-check (every type except
// curves/levels, which ops.py validates ad-hoc via `_level`'s 0..255 gate —
// asserted separately below, not parsed here). `preserve_luminosity` (bool)
// and `range` (an enum, not a numeric bound) are asserted separately too.
// ---------------------------------------------------------------------------

const LIB_PY = readFileSync(join(REPO_ROOT, 'src', 'backends', 'gimp', 'bridge', 'lib.py'), 'utf8');

interface Bound {
  lo: number;
  hi: number;
}

/** Every (field, lo, hi) triple lib.py's builders validate against, keyed by field name — a field validated more than once (a real cross-type name collision) collects every tuple it was found with. */
function parseLibPyBounds(src: string): Map<string, Bound[]> {
  const out = new Map<string, Bound[]>();
  const add = (name: string, lo: number, hi: number) => {
    const arr = out.get(name) ?? [];
    arr.push({ lo, hi });
    out.set(name, arr);
  };
  for (const m of src.matchAll(/validate_range\('([a-z_]+)',\s*v,\s*(-?[\d.]+),\s*(-?[\d.]+)\)/g)) {
    add(m[1], Number(m[2]), Number(m[3]));
  }
  for (const m of src.matchAll(
    /validate_int_range\('([a-z_]+)',\s*v,\s*(-?[\d.]+),\s*(-?[\d.]+)\)/g
  )) {
    add(m[1], Number(m[2]), Number(m[3]));
  }
  // pct_to_unit(name, v) uses its own default bounds (lo=-100.0, hi=100.0) when
  // called with no explicit lo/hi — every call site in lib.py omits them.
  for (const m of src.matchAll(/pct_to_unit\('([a-z_]+)',\s*v\)/g)) {
    add(m[1], -100, 100);
  }
  // degrees_to_unit(name, v) likewise defaults to (-180.0, 180.0).
  for (const m of src.matchAll(/degrees_to_unit\('([a-z_]+)',\s*v\)/g)) {
    add(m[1], -180, 180);
  }
  return out;
}

const LIB_BOUNDS = parseLibPyBounds(LIB_PY);

// Anti-vacuity floor — if the regexes above ever stop matching (a lib.py
// refactor changes the call shape), every assertion below would pass on an
// empty map. 20 is comfortably below the ~24 fields actually found today.
it('parseLibPyBounds finds a healthy number of validated fields (sanity check the parser)', () => {
  expect(LIB_BOUNDS.size).toBeGreaterThan(20);
});

/** Fields lib.py validates under more than one bound (a genuine cross-`type` name collision) — the tool schema widens these to the UNION, per gimp-adjustment-tools.ts's own file doc comment. */
const KNOWN_COLLISION_FIELDS = new Set(['saturation', 'radius']);

describe('gimp_add_adjustment schema bounds match bridge/lib.py exactly (or its documented union)', () => {
  for (const [field, tuples] of LIB_BOUNDS) {
    const schemaProp = ADJUST_SCHEMA_FOR_TESTS.properties?.[field];
    it(`"${field}": schema bound tracks lib.py's validator${tuples.length > 1 ? ' (union of ' + tuples.length + ' colliding types)' : ''}`, () => {
      expect(schemaProp, `no "${field}" property in the gimp_add_adjustment schema`).toBeDefined();
      const expectedLo = Math.min(...tuples.map((t) => t.lo));
      const expectedHi = Math.max(...tuples.map((t) => t.hi));
      if (tuples.length > 1) {
        expect(
          KNOWN_COLLISION_FIELDS.has(field),
          `"${field}" collides across types in lib.py but is not in KNOWN_COLLISION_FIELDS — ` +
            "update that set (and the schema's own doc comment) if this is a genuine new collision."
        ).toBe(true);
      }
      expect(schemaProp?.minimum, `"${field}" minimum`).toBe(expectedLo);
      expect(schemaProp?.maximum, `"${field}" maximum`).toBe(expectedHi);
    });
  }

  it('"range" schema enum is a superset of BOTH lib.py enums (HUE_RANGES + TRANSFER_MODES)', () => {
    const hueRangesMatch = LIB_PY.match(/HUE_RANGES = \(([^)]+)\)/);
    const transferModesMatch = LIB_PY.match(/TRANSFER_MODES = \(([^)]+)\)/);
    expect(hueRangesMatch, 'HUE_RANGES not found in lib.py').toBeTruthy();
    expect(transferModesMatch, 'TRANSFER_MODES not found in lib.py').toBeTruthy();
    const parseTuple = (raw: string) => raw.match(/'([a-z]+)'/g)!.map((s) => s.slice(1, -1));
    const hueRanges = parseTuple(hueRangesMatch![1]);
    const transferModes = parseTuple(transferModesMatch![1]);
    const schemaEnum = ADJUST_SCHEMA_FOR_TESTS.properties?.range?.enum as string[];
    expect(schemaEnum).toBeDefined();
    for (const v of [...hueRanges, ...transferModes]) {
      expect(schemaEnum, `"${v}" missing from gimp_add_adjustment's range enum`).toContain(v);
    }
  });

  it("curves/levels 0-255 fields match ops.py's _level helper bound (0..255) — parsed separately, since curves/levels bypass lib.py's builders", () => {
    const opsPy = readFileSync(
      join(REPO_ROOT, 'src', 'backends', 'gimp', 'bridge', 'ops.py'),
      'utf8'
    );
    expect(opsPy).toMatch(/if not 0 <= v <= 255/);
    for (const field of ['in_low', 'in_high', 'out_low', 'out_high']) {
      const prop = ADJUST_SCHEMA_FOR_TESTS.properties?.[field];
      expect(prop?.minimum, `"${field}" minimum`).toBe(0);
      expect(prop?.maximum, `"${field}" maximum`).toBe(255);
    }
    const pointsItems = ADJUST_SCHEMA_FOR_TESTS.properties?.points?.items;
    expect(pointsItems?.items?.minimum).toBe(0);
    expect(pointsItems?.items?.maximum).toBe(255);
  });

  it('MAX_FEATHER_PX / MAX_RESIZE_SIDE_PX constants exist in lib.py (sanity — the geometry/mask tools rely on the bridge enforcing these, not the schema alone)', () => {
    expect(LIB_PY).toMatch(/MAX_FEATHER_PX = 1000/);
    expect(LIB_PY).toMatch(/MAX_RESIZE_SIDE_PX = 30_000/);
  });

  it('"gamma" has NO bridge-side validator at all — op_levels reads it via a bare float() — the schema bound is a client-side-only safety net, not something to drift-check against a bridge bound that does not exist', () => {
    const opsPy = readFileSync(
      join(REPO_ROOT, 'src', 'backends', 'gimp', 'bridge', 'ops.py'),
      'utf8'
    );
    // Single `\ndef ` (not `\n\ndef `) — ops.py has CRLF line endings, so a
    // "blank line" is `\r\n\r\n`, not two bare `\n`s; requiring exactly the
    // Unix-style pair here would never match at all.
    const opLevelsMatch = opsPy.match(/def op_levels\(args\):[\s\S]*?\ndef /);
    expect(opLevelsMatch, 'op_levels not found in ops.py').toBeTruthy();
    expect(opLevelsMatch![0]).not.toMatch(/validate_range\(\s*'gamma'/);
    expect(opLevelsMatch![0]).toMatch(/float\(args\.get\('gamma'/);
    const prop = ADJUST_SCHEMA_FOR_TESTS.properties?.gamma;
    expect(prop?.minimum).toBe(0.1);
    expect(prop?.maximum).toBe(10);
  });

  it('"preserve_luminosity" is a boolean schema field with no numeric bound — color_balance\'s builder converts it with a bare bool(), not validate_range', () => {
    const prop = ADJUST_SCHEMA_FOR_TESTS.properties?.preserve_luminosity;
    expect(prop?.type).toBe('boolean');
    expect(prop?.minimum).toBeUndefined();
    expect(prop?.maximum).toBeUndefined();
    expect(LIB_PY).toMatch(/'preserve_luminosity',\s*defaults,\s*'preserve-luminosity',\s*bool/);
  });

  // The reverse direction of the per-field loop above (which proves every
  // lib.py-validated field has a matching schema bound): every OTHER numeric
  // property in the schema must itself map to a lib.py validator, so a
  // schema-only bound can never silently drift from a bridge that doesn't
  // (or no longer) enforces the same thing.
  const NON_NUMERIC_OR_SEPARATELY_HANDLED = new Set([
    'image',
    'layer',
    'type',
    'filter_id',
    'mask',
    'name', // identifiers / non-numeric
    'channel',
    'points', // curves — enum / array, not a lib.py-validated number
    'in_low',
    'in_high',
    'gamma',
    'out_low',
    'out_high', // levels — asserted against ops.py's 0..255 gate above (gamma has no bound at all)
    'range', // enum, asserted separately above
    'preserve_luminosity', // boolean, asserted separately above
  ]);

  it('every OTHER numeric schema property maps to a lib.py-validated field (no orphaned schema-only bound)', () => {
    const props = ADJUST_SCHEMA_FOR_TESTS.properties ?? {};
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
