import { describe, it, expect } from 'vitest';
import {
  pickThresholdLevel,
  estimateHorizon,
  computeTonalZones,
  computeComposition,
  boxArea,
  toLumaHistogram,
  type LumaHistogram,
} from '@editmamei/perception/facets.ts';

// Pure facet analyzers — no Photoshop, no decode. These pin the math that the
// scene model and select-by-reference recipes depend on.

/** Build a histogram with `count` pixels in each named bin. */
function histOf(spec: Record<number, number>): LumaHistogram {
  const bins = new Array(256).fill(0);
  let total = 0;
  for (const [k, v] of Object.entries(spec)) {
    bins[Number(k)] = v;
    total += v;
  }
  return { bins, total, mean: 0, median: 0 };
}

describe('pickThresholdLevel (Otsu)', () => {
  it('splits a clean bimodal dark/bright histogram between the two modes', () => {
    // Half the mass at luma 30 (ground), half at 220 (sky).
    const hist = histOf({ 30: 1000, 220: 1000 });
    const pick = pickThresholdLevel(hist);
    expect(pick.level).toBeGreaterThan(30);
    expect(pick.level).toBeLessThan(220);
    // Bright side (sky) should be ~half the pixels.
    expect(pick.bright_fraction).toBeGreaterThan(0.4);
    expect(pick.bright_fraction).toBeLessThan(0.6);
  });

  it('reports a small bright fraction when the bright mode is small', () => {
    const hist = histOf({ 20: 9000, 240: 1000 });
    const pick = pickThresholdLevel(hist);
    expect(pick.bright_fraction).toBeGreaterThan(0.05);
    expect(pick.bright_fraction).toBeLessThan(0.2);
  });

  it('degrades to level 128 on an empty histogram', () => {
    const pick = pickThresholdLevel(histOf({}));
    expect(pick.level).toBe(128);
    expect(pick.bright_fraction).toBe(0);
  });
});

describe('estimateHorizon', () => {
  const pick = { level: 128, bright_fraction: 0.5 };

  it('finds the horizon at the row where brightness drops below the threshold', () => {
    // 64 strips: top half bright (200), bottom half dark (40). Crossing at strip 32.
    const rows = [...Array(32).fill(200), ...Array(32).fill(40)];
    const h = estimateHorizon(rows, 1000, pick);
    // strip 32 / 64 * 1000 = 500
    expect(h.y).toBe(500);
    expect(h.placement).toBeCloseTo(0.5, 2);
    expect(h.confidence).toBeGreaterThan(0);
  });

  it('falls back to the thirds prior (low confidence) when no row profile is given', () => {
    const h = estimateHorizon(undefined, 900, pick);
    expect(h.y).toBe(300);
    expect(h.placement).toBeCloseTo(1 / 3, 2);
    expect(h.confidence).toBeLessThanOrEqual(0.2);
  });

  it('falls back to thirds when the whole frame stays above the threshold (no crossing)', () => {
    const rows = Array(64).fill(200);
    const h = estimateHorizon(rows, 1200, pick);
    expect(h.y).toBe(400); // 1200/3
    expect(h.confidence).toBeLessThanOrEqual(0.2);
  });

  // Dominant-subject guard (2026-08-01). This estimator only knows "bright band
  // on top, darker band below" — it cannot tell a skyline from the edge of a big
  // foreground subject. Live 2026-07-30 a 51MP STUDIO HEADSHOT (pale backdrop
  // above, hair/clothing below) reported horizon y=5563 at confidence 0.73;
  // there is no horizon in that frame at all.
  it('demotes a false horizon when a dominant subject explains the crossing', () => {
    const rows = [...Array(32).fill(200), ...Array(32).fill(40)];
    // Subject spans 5%..95% of a 1000px frame and swallows the crossing at 500.
    const h = estimateHorizon(rows, 1000, pick, [0, 50, 800, 950]);
    expect(h.y).toBe(333); // thirds prior, not the subject's shoulder line
    expect(h.confidence).toBeLessThanOrEqual(0.2);
  });

  it('keeps a real horizon when the subject is only a minority of the frame', () => {
    const rows = [...Array(32).fill(200), ...Array(32).fill(40)];
    // A person standing in a landscape: 30% of frame height. Must NOT suppress.
    const h = estimateHorizon(rows, 1000, pick, [400, 450, 600, 750]);
    expect(h.y).toBe(500);
    expect(h.confidence).toBeGreaterThan(0.2);
  });

  it('keeps the horizon when a tall subject does not contain the crossing', () => {
    // Subject is tall (70%) but sits BELOW the crossing — the brightness
    // transition is not explained by it, so the horizon stands.
    const rows = [...Array(16).fill(200), ...Array(48).fill(40)];
    const h = estimateHorizon(rows, 1000, pick, [100, 300, 400, 1000]);
    expect(h.y).toBe(250);
    expect(h.confidence).toBeGreaterThan(0.2);
  });

  // The FACE route into the same guard. A tight head-and-shoulders crop is
  // frequently NOT classified `person` by COCO, so mainSubjectBox is null on
  // exactly the portraits most prone to a false horizon, while the face
  // detector fires cleanly.
  it('demotes via the FACE when COCO produced no person box (tight crop)', () => {
    const rows = [...Array(32).fill(200), ...Array(32).fill(40)];
    // Face spans 20%..55% of a 1000px frame (35% — a headshot); crossing at 500
    // is below the face top, i.e. the hair/shoulder line.
    const h = estimateHorizon(rows, 1000, pick, null, [300, 200, 700, 550]);
    expect(h.y).toBe(333);
    expect(h.confidence).toBeLessThanOrEqual(0.2);
  });

  it('does NOT demote for a small face in a landscape', () => {
    const rows = [...Array(32).fill(200), ...Array(32).fill(40)];
    // A person standing in a scene: face is ~6% of frame height. A real horizon
    // behind them must survive.
    const h = estimateHorizon(rows, 1000, pick, null, [480, 600, 520, 660]);
    expect(h.y).toBe(500);
    expect(h.confidence).toBeGreaterThan(0.2);
  });

  it('does NOT demote when the crossing sits ABOVE a large face', () => {
    // Horizon above the subject's head — genuinely a horizon, not their outline.
    const rows = [...Array(8).fill(200), ...Array(56).fill(40)];
    const h = estimateHorizon(rows, 1000, pick, null, [300, 400, 700, 750]);
    expect(h.y).toBe(125);
    expect(h.confidence).toBeGreaterThan(0.2);
  });

  it('is unaffected when no subject box is supplied (back-compat)', () => {
    const rows = [...Array(32).fill(200), ...Array(32).fill(40)];
    expect(estimateHorizon(rows, 1000, pick, null).y).toBe(500);
    expect(estimateHorizon(rows, 1000, pick).y).toBe(500);
  });
});

describe('computeTonalZones', () => {
  it('puts roughly a third of the mass in each band for a uniform histogram', () => {
    const bins: Record<number, number> = {};
    for (let i = 0; i < 256; i++) bins[i] = 10;
    const zones = computeTonalZones(histOf(bins));
    expect(zones.shadows.lower).toBe(0);
    expect(zones.highlights.upper).toBe(255);
    // Bands are contiguous and ordered.
    expect(zones.midtones.lower).toBe(zones.shadows.upper + 1);
    expect(zones.highlights.lower).toBe(zones.midtones.upper + 1);
    // Coverage sums to ~1.
    const sum = zones.shadows.coverage + zones.midtones.coverage + zones.highlights.coverage;
    expect(sum).toBeCloseTo(1, 2);
  });

  it('clamps the band cuts so they never invert on a single-spike histogram', () => {
    const zones = computeTonalZones(histOf({ 0: 10000 }));
    expect(zones.shadows.upper).toBeGreaterThanOrEqual(20);
    expect(zones.midtones.upper).toBeGreaterThan(zones.midtones.lower);
    expect(zones.highlights.lower).toBeGreaterThan(zones.midtones.upper);
  });
});

describe('computeComposition', () => {
  it('places the main subject in the correct thirds cell', () => {
    // 900×900 frame; box centred at (150,150) → top-left third.
    const main: [number, number, number, number] = [100, 100, 200, 200];
    const comp = computeComposition(main, [main], 900, 900, 0.4);
    expect(comp.main_subject_cell).toEqual({ col: 'left', row: 'top' });
    expect(comp.horizon_placement).toBe(0.4);
    // Headroom = top edge (100) / 900.
    expect(comp.headroom).toBeCloseTo(100 / 900, 3);
  });

  it('reports right-weighted balance when subject mass sits on the right', () => {
    const a: [number, number, number, number] = [700, 100, 850, 300];
    const comp = computeComposition(a, [a], 1000, 1000, null);
    expect(comp.balance).toBe('right-weighted');
  });

  it('reports balanced when a single subject is centred', () => {
    const a: [number, number, number, number] = [450, 100, 550, 300];
    const comp = computeComposition(a, [a], 1000, 1000, null);
    expect(comp.balance).toBe('balanced');
  });

  it('returns null cell + null headroom when there is no subject', () => {
    const comp = computeComposition(null, [], 1000, 1000, 0.3);
    expect(comp.main_subject_cell).toBeNull();
    expect(comp.headroom).toBeNull();
    expect(comp.balance).toBe('unknown');
    expect(comp.horizon_placement).toBe(0.3);
  });
});

describe('boxArea + toLumaHistogram', () => {
  it('boxArea is width×height and never negative', () => {
    expect(boxArea([0, 0, 10, 20])).toBe(200);
    expect(boxArea([10, 10, 5, 5])).toBe(0); // inverted → clamped to 0
  });

  it('toLumaHistogram defends against a missing/short bins array', () => {
    const h = toLumaHistogram({ bins: [1, 2, 3], total_pixels: 6 });
    expect(h.bins.length).toBe(256); // replaced with zeros
    const h2 = toLumaHistogram({ total_pixels: 100, mean: 50 });
    expect(h2.bins.length).toBe(256);
    expect(h2.mean).toBe(50);
  });
});
