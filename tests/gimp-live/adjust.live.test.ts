/**
 * Per-adjustment-type pixel verifiers against real headless GIMP: apply known params to a small
 * synthetic image, export a lossless PNG, decode it independently (`support.ts`'s `readPng`, no
 * image-decoding dependency involved), and check the expected transfer -- exact for curves/levels/exposure
 * (against an independently computed LUT), direction+magnitude for the color-relationship
 * adjustments (against flat color swatches), and property-level checks (edge contrast up /
 * variance down) for sharpen/noise_reduction, which have no single scalar transfer function to
 * check exactly. Same skip/require-GIMP shape as `session.live.test.ts`.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectGimp, type GimpInstall } from '@editmamei/backends/gimp/detect.ts';
import { GimpSession } from '@editmamei/backends/gimp/session.ts';
import {
  readPng,
  pixelAt,
  patchMean,
  patchVariance,
  writeGrayRamp,
  writeColorSwatches,
  writeNoisyField,
  lerpCurve,
  srgbToLinear,
  linearToSrgb,
  SWATCHES,
  SWATCH_SIZE,
} from './support.ts';

// This file alone, not the project default: it spawns a real headless GIMP process, and vitest
// running several such files in parallel workers can push the first test in one past the
// project's normal ceiling on cold-start contention alone (measured), with nothing actually
// wrong.
vi.setConfig({ testTimeout: 30_000 });

const install: GimpInstall | null = await detectGimp();

describe.skipIf(!install)('adjust: per-type pixel verifiers', () => {
  const RAMP_WIDTH = 256;
  const RAMP_HEIGHT = 32;
  let workDir: string;
  let session: GimpSession;
  let rampPath: string;
  let swatchesPath: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'em-gimp-adjust-'));
    session = new GimpSession({ install: install!, rootDir: join(workDir, 'session-root') });
    rampPath = join(workDir, 'ramp.png');
    swatchesPath = join(workDir, 'swatches.png');
    writeGrayRamp(rampPath, RAMP_WIDTH, RAMP_HEIGHT);
    writeColorSwatches(swatchesPath);
  });

  afterAll(async () => {
    await session.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  });

  /** Open the gray ramp, apply one `adjust` call, export a PNG, decode it. Caller reads columns. */
  async function applyToRamp(args: Record<string, unknown>, tag: string) {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    await session.call('adjust', { image: opened.image, ...args });
    const outPath = join(workDir, `ramp-${tag}.png`);
    await session.call('export', { image: opened.image, path: outPath });
    await session.call('close', { image: opened.image });
    return readPng(outPath);
  }

  async function applyToSwatches(args: Record<string, unknown>, tag: string) {
    const opened = await session.call<{ image: number }>('open', { path: swatchesPath });
    await session.call('adjust', { image: opened.image, ...args });
    const outPath = join(workDir, `swatch-${tag}.png`);
    await session.call('export', { image: opened.image, path: outPath });
    await session.call('close', { image: opened.image });
    return readPng(outPath);
  }

  function swatchMean(ppm: ReturnType<typeof readPng>, name: string) {
    const swatch = SWATCHES.find((s) => s.name === name)!;
    return patchMean(ppm, swatch.x * SWATCH_SIZE, 0, SWATCH_SIZE, SWATCH_SIZE);
  }

  // ---- curves / levels: exact against an independently computed LUT (tolerance: +/-1 level) --

  it('curves: exact per-column against a 2-point linear LUT (tolerance +/-1 level)', async () => {
    const points: Array<[number, number]> = [
      [0, 40],
      [255, 215],
    ];
    const ppm = await applyToRamp({ type: 'curves', points }, 'curves');
    for (const x of [0, 32, 64, 128, 192, 224, 255]) {
      const expected = lerpCurve(points, x);
      const [r] = pixelAt(ppm, x, 16);
      expect(Math.abs(r - expected), `x=${x} expected~${expected} got ${r}`).toBeLessThanOrEqual(1);
    }
  });

  it('levels: exact per-column against the levels formula (tolerance +/-1 level)', async () => {
    const inLow = 20,
      inHigh = 235,
      gamma = 1.0,
      outLow = 10,
      outHigh = 245;
    const ppm = await applyToRamp(
      { type: 'levels', in_low: inLow, in_high: inHigh, gamma, out_low: outLow, out_high: outHigh },
      'levels'
    );
    for (const x of [0, 10, 64, 128, 192, 250, 255]) {
      // Verified live: GIMP does NOT clamp the normalized (x-in_low)/(in_high-in_low) term to
      // 0..1 before applying gamma/output scaling -- only the final 0-255 result is clamped. A
      // pre-clamped formula matches at every interior sample but is off by double digits at the
      // extremes (x=0 here: unclamped norm is negative, so the true output UNDERSHOOTS out_low).
      const norm = (x - inLow) / (inHigh - inLow);
      const expected = Math.max(0, Math.min(255, Math.round(outLow + norm * (outHigh - outLow))));
      const [r] = pixelAt(ppm, x, 16);
      expect(Math.abs(r - expected), `x=${x} expected~${expected} got ${r}`).toBeLessThanOrEqual(1);
    }
  });

  it('levels: gamma bends the midtones as the formula predicts', async () => {
    const gamma = 2.0;
    const ppm = await applyToRamp(
      { type: 'levels', in_low: 0, in_high: 255, gamma, out_low: 0, out_high: 255 },
      'levels-gamma'
    );
    const x = 128;
    const norm = (x / 255) ** (1 / gamma);
    const expected = Math.round(norm * 255);
    const [r] = pixelAt(ppm, x, 16);
    expect(Math.abs(r - expected)).toBeLessThanOrEqual(1);
  });

  // ---- exposure: 2^stops in LINEAR light (tolerance: +/-2 levels) ----------------------------

  it('exposure: matches 2^stops applied in linear light (tolerance +/-2 levels)', async () => {
    const stops = 1.0;
    const ppm = await applyToRamp({ type: 'exposure', exposure: stops }, 'exposure');
    for (const x of [40, 90, 140, 190]) {
      const linear = srgbToLinear(x) * 2 ** stops;
      const expected = linearToSrgb(linear);
      const [r] = pixelAt(ppm, x, 16);
      expect(Math.abs(r - expected), `x=${x} expected~${expected} got ${r}`).toBeLessThanOrEqual(2);
    }
  });

  // ---- brightness/contrast: direction + rough magnitude ---------------------------------------

  it('brightness_contrast: positive brightness raises the midtones', async () => {
    const before = await applyToRamp(
      { type: 'brightness_contrast', brightness: 0, contrast: 0 },
      'bc-0'
    );
    const after = await applyToRamp(
      { type: 'brightness_contrast', brightness: 40, contrast: 0 },
      'bc-40'
    );
    const [rBefore] = pixelAt(before, 128, 16);
    const [rAfter] = pixelAt(after, 128, 16);
    expect(rAfter).toBeGreaterThan(rBefore);
  });

  it('brightness_contrast: positive contrast steepens the curve (shadows down, highlights up)', async () => {
    const ppm = await applyToRamp(
      { type: 'brightness_contrast', brightness: 0, contrast: 60 },
      'bc-contrast'
    );
    const [shadow] = pixelAt(ppm, 32, 16);
    const [highlight] = pixelAt(ppm, 224, 16);
    expect(shadow).toBeLessThan(32);
    expect(highlight).toBeGreaterThan(224);
  });

  // ---- hue/saturation, color balance, color temperature, vibrance, saturation: direction ------
  // checked on flat color swatches, since these are color-RELATIONSHIP adjustments with no single
  // scalar transfer function to replicate independently.

  it('hue_saturation: a 60-degree hue rotation moves red toward green/yellow', async () => {
    const ppm = await applyToSwatches({ type: 'hue_saturation', range: 'all', hue: 60 }, 'hue60');
    const [r, g, b] = swatchMean(ppm, 'red');
    // Rotating red's hue toward green raises green relative to red -- direction, not magnitude.
    expect(g).toBeGreaterThan(r * 0.5);
    expect(b).toBeLessThan(g);
  });

  it('hue_saturation: saturation -100 desaturates every swatch to its gray-equivalent', async () => {
    const ppm = await applyToSwatches(
      { type: 'hue_saturation', range: 'all', saturation: -100 },
      'desat'
    );
    const [r, g, b] = swatchMean(ppm, 'red');
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(2);
  });

  it('color_balance: shadows cyan-red toward red raises red in the dark swatch', async () => {
    const before = swatchMean(
      await applyToSwatches({ type: 'color_balance', range: 'shadows' }, 'cb-0'),
      'black'
    );
    const after = swatchMean(
      await applyToSwatches({ type: 'color_balance', range: 'shadows', cyan_red: 80 }, 'cb-80'),
      'black'
    );
    expect(after[0]).toBeGreaterThan(before[0]);
  });

  it('color_temperature: raising the intended temperature warms the image (red rises, blue falls)', async () => {
    // Verified live: `intended-temperature` is "what temperature the output should look shot
    // at" -- raising it tells the op "the true light was bluer/cooler than assumed", so it
    // ADDS warmth (orange) to compensate. (`original-temperature` alone, held fixed, is the
    // "what the input currently looks shot at" side of the same pair.)
    const gray = 'gray';
    const before = swatchMean(
      await applyToSwatches(
        { type: 'color_temperature', from_kelvin: 6500, to_kelvin: 6500 },
        'ct-0'
      ),
      gray
    );
    const after = swatchMean(
      await applyToSwatches(
        { type: 'color_temperature', from_kelvin: 6500, to_kelvin: 10000 },
        'ct-warm'
      ),
      gray
    );
    expect(after[0] - before[0]).toBeGreaterThan(0); // red rises
    expect(after[2] - before[2]).toBeLessThan(0); // blue falls
  });

  it('vibrance: positive vibrance increases saturation of a mid-saturation swatch', async () => {
    const before = swatchMean(
      await applyToSwatches({ type: 'vibrance', vibrance: 0 }, 'vib-0'),
      'red'
    );
    const after = swatchMean(
      await applyToSwatches({ type: 'vibrance', vibrance: 80 }, 'vib-80'),
      'red'
    );
    const spread = (rgb: [number, number, number]) => Math.max(...rgb) - Math.min(...rgb);
    expect(spread(after)).toBeGreaterThan(spread(before));
  });

  it('saturation: scale 0 removes all color (gray-equivalent)', async () => {
    const ppm = await applyToSwatches({ type: 'saturation', scale: 0 }, 'sat-0');
    const [r, g, b] = swatchMean(ppm, 'red');
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(2);
  });

  // ---- shadows/highlights: direction on a gray ramp's dark/light ends ------------------------

  it('shadows_highlights: positive shadows lifts the dark end, negative highlights pulls in the bright end', async () => {
    const before = await applyToRamp({ type: 'shadows_highlights' }, 'sh-0');
    const after = await applyToRamp(
      { type: 'shadows_highlights', shadows: 60, highlights: -60, radius: 40 },
      'sh-60'
    );
    const [darkBefore] = pixelAt(before, 16, 16);
    const [darkAfter] = pixelAt(after, 16, 16);
    const [lightBefore] = pixelAt(before, 240, 16);
    const [lightAfter] = pixelAt(after, 240, 16);
    expect(darkAfter).toBeGreaterThan(darkBefore);
    expect(lightAfter).toBeLessThan(lightBefore);
  });

  // ---- sharpen / noise_reduction: property-level checks, not exact values --------------------

  it('sharpen: raises local contrast at an edge (property check, not an exact value)', async () => {
    // A smooth ramp has almost no local (high-frequency) variance for unsharp-masking to
    // amplify -- a real step edge is needed, so this uses the color swatches' black/white
    // boundary and measures the window straddling it, not the ramp fixture.
    const boundary = SWATCH_SIZE; // the black|white edge
    const before = await applyToSwatches({ type: 'sharpen', radius: 0.1, amount: 0 }, 'sharp-0');
    const after = await applyToSwatches(
      { type: 'sharpen', radius: 3, amount: 2.0, threshold: 0 },
      'sharp-strong'
    );
    const varBefore = patchVariance(before, boundary - 8, 0, 16, SWATCH_SIZE);
    const varAfter = patchVariance(after, boundary - 8, 0, 16, SWATCH_SIZE);
    expect(varAfter).toBeGreaterThan(varBefore);
  });

  it('noise_reduction: reduces variance on a genuinely noisy fixture', async () => {
    // A smooth ramp has near-zero high-frequency variance to begin with -- asserting a REDUCTION
    // against it would either flake or pass vacuously, so this uses a fixture with real
    // deterministic per-pixel noise instead (support.ts's writeNoisyField), the same "give the
    // filter something real to act on" fix the sharpen/proxy-fidelity tests needed.
    const noisyPath = join(workDir, 'noisy.png');
    writeNoisyField(noisyPath, 64, 64);
    const before = await (async () => {
      const opened = await session.call<{ image: number }>('open', { path: noisyPath });
      const outPath = join(workDir, 'noisy-before.png');
      await session.call('export', { image: opened.image, path: outPath });
      await session.call('close', { image: opened.image });
      return readPng(outPath);
    })();
    const opened = await session.call<{ image: number }>('open', { path: noisyPath });
    await session.call('adjust', { image: opened.image, type: 'noise_reduction', strength: 32 });
    const outPath = join(workDir, 'noisy-after.png');
    await session.call('export', { image: opened.image, path: outPath });
    await session.call('close', { image: opened.image });
    const after = readPng(outPath);

    const varBefore = patchVariance(before, 8, 8, 48, 48);
    const varAfter = patchVariance(after, 8, 8, 48, 48);
    expect(varAfter).toBeLessThan(varBefore);
  });

  // ---- range validation: every type rejects an out-of-range field, naming it ------------------

  it.each([
    ['exposure', { exposure: 11 }],
    ['brightness_contrast', { brightness: 150 }],
    ['hue_saturation', { hue: 200 }],
    ['color_balance', { range: 'nope' }],
    ['color_temperature', { from_kelvin: 500 }],
    ['shadows_highlights', { radius: 2000 }],
    ['saturation', { scale: 11 }],
    ['vibrance', { vibrance: 150 }],
    ['sharpen', { radius: -1 }],
    ['noise_reduction', { strength: 0 }],
  ])('adjust %s rejects an out-of-range field as invalid_argument', async (type, badArgs) => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      await expect(
        session.call('adjust', { image: opened.image, type, ...badArgs })
      ).rejects.toMatchObject({ code: 'invalid_argument' });
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('adjust rejects an unknown type', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      await expect(
        session.call('adjust', { image: opened.image, type: 'not_a_real_type' })
      ).rejects.toMatchObject({ code: 'invalid_argument' });
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('filter_id re-edit updates the same filter in place rather than stacking a new one', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      const first = await session.call<{ filter_id: number }>('adjust', {
        image: opened.image,
        type: 'exposure',
        exposure: 0.5,
      });
      await session.call('adjust', {
        image: opened.image,
        type: 'exposure',
        filter_id: first.filter_id,
        exposure: 1.0,
      });
      const listed = await session.call<{ filters: Array<{ filter_id: number }> }>('filter', {
        image: opened.image,
        op: 'list',
      });
      expect(listed.filters).toHaveLength(1);
      expect(listed.filters[0]!.filter_id).toBe(first.filter_id);
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  // ---- re-edit is a MERGE, for every adjust type (not just exposure) -------------------------
  // A partial re-edit (only some fields given) must keep every OTHER field exactly as it was,
  // not silently reset it to that type's create-time default -- verified per type by checking the
  // ledger's own recorded params (`filter op=list`'s `params`) after the re-edit.

  const REEDIT_MERGE_CASES: Array<{
    type: string;
    create: Record<string, unknown>;
    reedit: Record<string, unknown>;
    unchangedGeglKey: string;
    expectedUnchanged: unknown;
  }> = [
    {
      type: 'exposure',
      create: { exposure: 2, black_level: 0.05 },
      reedit: { exposure: 3 },
      unchangedGeglKey: 'black-level',
      expectedUnchanged: 0.05,
    },
    {
      type: 'brightness_contrast',
      create: { brightness: 40, contrast: 20 },
      reedit: { contrast: 10 },
      unchangedGeglKey: 'brightness',
      expectedUnchanged: 0.4,
    },
    {
      type: 'hue_saturation',
      create: { range: 'red', hue: 90, saturation: 50 },
      reedit: { saturation: 20 },
      unchangedGeglKey: 'hue',
      expectedUnchanged: 0.5,
    },
    {
      type: 'color_balance',
      create: { range: 'shadows', cyan_red: 50 },
      reedit: { magenta_green: 30 },
      unchangedGeglKey: 'cyan-red',
      expectedUnchanged: 0.5,
    },
    {
      type: 'color_temperature',
      create: { from_kelvin: 5000, to_kelvin: 8000 },
      reedit: { to_kelvin: 9000 },
      unchangedGeglKey: 'original-temperature',
      expectedUnchanged: 5000,
    },
    {
      type: 'shadows_highlights',
      create: { shadows: 50, highlights: -30 },
      reedit: { shadows: 10 },
      unchangedGeglKey: 'highlights',
      expectedUnchanged: -30,
    },
    {
      type: 'vibrance',
      create: { vibrance: 50, saturation: 2 },
      reedit: { vibrance: 10 },
      unchangedGeglKey: 'saturation',
      expectedUnchanged: 2,
    },
    {
      type: 'sharpen',
      create: { radius: 5, amount: 1.5, threshold: 0.2 },
      reedit: { amount: 0.8 },
      unchangedGeglKey: 'threshold',
      expectedUnchanged: 0.2,
    },
  ];

  it.each(REEDIT_MERGE_CASES)(
    'adjust %s re-edit merges: an unspecified field keeps its create-time value',
    async ({ type, create, reedit, unchangedGeglKey, expectedUnchanged }) => {
      const opened = await session.call<{ image: number }>('open', { path: rampPath });
      try {
        const created = await session.call<{ filter_id: number }>('adjust', {
          image: opened.image,
          type,
          ...create,
        });
        await session.call('adjust', {
          image: opened.image,
          type,
          filter_id: created.filter_id,
          ...reedit,
        });
        const listed = await session.call<{
          filters: Array<{ filter_id: number; params: Record<string, unknown> }>;
        }>('filter', { image: opened.image, op: 'list' });
        const rec = listed.filters.find((f) => f.filter_id === created.filter_id)!;
        expect(rec.params[unchangedGeglKey]).toBeCloseTo(expectedUnchanged as number, 5);
      } finally {
        await session.call('close', { image: opened.image });
      }
    }
  );

  // saturation and noise_reduction are single-field adjust types -- there is no OTHER field for
  // the REEDIT_MERGE_CASES table's "does an unspecified field keep its create value" shape to
  // exercise, so the meaningful merge check for these two is: a filter_id re-edit that gives NO
  // new value for that one field keeps the create-time value rather than resetting to the type's
  // ADJUST_CREATE_DEFAULTS (scale 1.0 / iterations 4, i.e. strength 4).
  const SINGLE_FIELD_REEDIT_CASES: Array<{
    type: string;
    create: Record<string, unknown>;
    geglKey: string;
    expectedUnchanged: unknown;
  }> = [
    { type: 'saturation', create: { scale: 3.5 }, geglKey: 'scale', expectedUnchanged: 3.5 },
    {
      type: 'noise_reduction',
      create: { strength: 12 },
      geglKey: 'iterations',
      expectedUnchanged: 12,
    },
  ];

  it.each(SINGLE_FIELD_REEDIT_CASES)(
    'adjust %s re-edit with no new value keeps the create-time value (not the type default)',
    async ({ type, create, geglKey, expectedUnchanged }) => {
      const opened = await session.call<{ image: number }>('open', { path: rampPath });
      try {
        const created = await session.call<{ filter_id: number }>('adjust', {
          image: opened.image,
          type,
          ...create,
        });
        await session.call('adjust', {
          image: opened.image,
          type,
          filter_id: created.filter_id,
        });
        const listed = await session.call<{
          filters: Array<{ filter_id: number; params: Record<string, unknown> }>;
        }>('filter', { image: opened.image, op: 'list' });
        const rec = listed.filters.find((f) => f.filter_id === created.filter_id)!;
        expect(rec.params[geglKey]).toBeCloseTo(expectedUnchanged as number, 5);
      } finally {
        await session.call('close', { image: opened.image });
      }
    }
  );

  it('adjust curves re-edit merges: omitting channel keeps it, omitting points keeps them', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      const created = await session.call<{ filter_id: number }>('curves', {
        image: opened.image,
        channel: 'red',
        points: [
          [0, 10],
          [255, 240],
        ],
      });
      // Re-edit points only -- channel must stay 'red', not reset to 'value'.
      await session.call('curves', {
        image: opened.image,
        filter_id: created.filter_id,
        points: [
          [0, 20],
          [255, 230],
        ],
      });
      let listed = await session.call<{
        filters: Array<{ filter_id: number; params: { channel: string; points: number[][] } }>;
      }>('filter', { image: opened.image, op: 'list' });
      let rec = listed.filters.find((f) => f.filter_id === created.filter_id)!;
      expect(rec.params.channel).toBe('red');
      expect(rec.params.points).toEqual([
        [0, 20],
        [255, 230],
      ]);

      // Re-edit with NEITHER channel nor points -- both must keep their current values.
      await session.call('curves', { image: opened.image, filter_id: created.filter_id });
      listed = await session.call<{
        filters: Array<{ filter_id: number; params: { channel: string; points: number[][] } }>;
      }>('filter', { image: opened.image, op: 'list' });
      rec = listed.filters.find((f) => f.filter_id === created.filter_id)!;
      expect(rec.params.channel).toBe('red');
      expect(rec.params.points).toEqual([
        [0, 20],
        [255, 230],
      ]);
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('adjust levels re-edit merges: re-editing only gamma keeps every other field', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      const created = await session.call<{ filter_id: number }>('levels', {
        image: opened.image,
        channel: 'red',
        in_low: 10,
        in_high: 240,
        gamma: 1.0,
        out_low: 5,
        out_high: 250,
      });
      await session.call('levels', {
        image: opened.image,
        filter_id: created.filter_id,
        gamma: 2.2,
      });
      const listed = await session.call<{
        filters: Array<{
          filter_id: number;
          params: {
            channel: string;
            in_low: number;
            in_high: number;
            gamma: number;
            out_low: number;
            out_high: number;
          };
        }>;
      }>('filter', { image: opened.image, op: 'list' });
      const rec = listed.filters.find((f) => f.filter_id === created.filter_id)!;
      expect(rec.params.channel).toBe('red');
      expect(rec.params.in_low).toBe(10);
      expect(rec.params.in_high).toBe(240);
      expect(rec.params.out_low).toBe(5);
      expect(rec.params.out_high).toBe(250);
      expect(rec.params.gamma).toBe(2.2);
    } finally {
      await session.call('close', { image: opened.image });
    }
  });
});
