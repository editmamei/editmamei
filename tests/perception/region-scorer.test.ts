import { describe, it, expect } from 'vitest';
import { buildRegionSignals, scoreRegion } from '@editmamei/perception/region-scorer.ts';

// The region scorer is pure: it turns measured selection_info + scene facts into
// a confidence, splitting a NEVER-tuned structural floor from model-tunable
// compositional priors. These tests pin the two behaviours that matter:
//   - garbage (urban bright blob) is rejected by the floor, and tuning can't
//     rescue it;
//   - a legitimate big-sky shot is rejected by the DEFAULT coverage prior but
//     PASSES once the model relaxes it (tunability), proving artistic shots
//     aren't punished for breaking the "balanced" norm.

const scene = (
  over: Partial<{ horizonY: number; horizonConfidence: number; indoorObjectCount: number }> = {}
) => ({
  docW: 1000,
  docH: 1000,
  horizonY: over.horizonY ?? 400,
  horizonConfidence: over.horizonConfidence ?? 0.7,
  indoorObjectCount: over.indoorObjectCount ?? 0,
});

const info = (o: { bottom: number; top?: number; cov: number; fill?: number; edge?: number }) => ({
  has_selection: true,
  bounds: { left: 0, top: o.top ?? 0, right: 1000, bottom: o.bottom },
  area_percent: o.cov * 100,
  bounds_fill_ratio: o.fill ?? 0.8,
  edge_complexity: o.edge ?? 0.05,
});

describe('region-scorer', () => {
  it('buildRegionSignals derives spatial signals from bounds', () => {
    const s = buildRegionSignals(info({ bottom: 1000, top: 0, cov: 1 }), scene());
    expect(s.touchesBottom).toBe(true);
    expect(s.touchesTop).toBe(true);
    expect(s.centroidY).toBeCloseTo(0.5, 5);
    const upper = buildRegionSignals(info({ bottom: 400, cov: 0.35 }), scene({ horizonY: 420 }));
    expect(upper.touchesBottom).toBe(false);
    expect(upper.centroidY).toBeCloseTo(0.2, 5);
    expect(upper.horizonAlignment).toBeGreaterThan(0.9); // lower edge 400 ≈ horizon 420
  });

  it('sky: a clean upper band tracking the horizon PASSES', () => {
    const s = buildRegionSignals(
      info({ bottom: 400, cov: 0.35 }),
      scene({ horizonY: 420, horizonConfidence: 0.76 })
    );
    const score = scoreRegion('sky', s);
    expect(score.passed).toBe(true);
    expect(score.confidence).toBeGreaterThan(0.8);
  });

  it('sky: an urban bright blob (touches bottom, 68%, misaligned) FAILS the floor', () => {
    const s = buildRegionSignals(
      info({ bottom: 1000, cov: 0.68, fill: 0.68, edge: 0.2 }),
      scene({ horizonY: 330, horizonConfidence: 0.2 })
    );
    expect(scoreRegion('sky', s).passed).toBe(false);
    // Tuning the coverage prior can NOT rescue a low structural floor.
    expect(scoreRegion('sky', s, { profile: 'big_sky' }).passed).toBe(false);
  });

  it('sky: a big-sky shot is rejected by DEFAULT but PASSES when the model relaxes the prior', () => {
    // 75% sky, upper, not touching bottom, well aligned → strong floor, but over
    // the default coverage prior.
    const s = buildRegionSignals(
      info({ bottom: 800, cov: 0.75, fill: 0.9 }),
      scene({ horizonY: 780, horizonConfidence: 0.7 })
    );
    expect(scoreRegion('sky', s).passed).toBe(false); // default prior rejects the large region
    expect(scoreRegion('sky', s, { profile: 'big_sky' }).passed).toBe(true); // model relaxes ⇒ confident
    expect(scoreRegion('sky', s, { skyCoverageMax: 0.85 }).passed).toBe(true); // explicit override too
  });

  it('sky: a bright UPPER region in a furnished room (ceiling) is suppressed by indoorness', () => {
    // Same clean-upper-band geometry that PASSES outdoors (cov 0.35, aligned)…
    const outdoor = buildRegionSignals(
      info({ bottom: 400, cov: 0.35 }),
      scene({ horizonY: 420, horizonConfidence: 0.76 })
    );
    expect(scoreRegion('sky', outdoor).passed).toBe(true);
    // …but with indoor furniture detected (bed + sofa) it's a ceiling, not sky.
    const indoor = buildRegionSignals(
      info({ bottom: 400, cov: 0.35 }),
      scene({ horizonY: 420, horizonConfidence: 0.76, indoorObjectCount: 2 })
    );
    expect(scoreRegion('sky', indoor).passed).toBe(false);
    // The model can still force it through with an explicit low pass_threshold.
    expect(scoreRegion('sky', indoor, { passThreshold: 0.2 }).passed).toBe(true);
  });

  it('ground: a lower mass whose upper edge tracks the horizon PASSES; an upper mass FAILS', () => {
    const low = buildRegionSignals(
      info({ top: 400, bottom: 1000, cov: 0.55 }),
      scene({ horizonY: 400 })
    );
    expect(scoreRegion('ground', low).passed).toBe(true);

    const high = buildRegionSignals(
      info({ top: 0, bottom: 300, cov: 0.25 }),
      scene({ horizonY: 400 })
    );
    expect(scoreRegion('ground', high).passed).toBe(false);
  });

  it('skin: a present, solid selection passes; an empty selection is rejected', () => {
    const present = buildRegionSignals(
      info({ top: 100, bottom: 500, cov: 0.08, fill: 0.7 }),
      scene()
    );
    expect(scoreRegion('skin', present).passed).toBe(true);

    const empty = buildRegionSignals({ has_selection: false }, scene());
    const score = scoreRegion('skin', empty);
    expect(score.passed).toBe(false);
    expect(score.confidence).toBe(0);
  });

  it('shadows/highlights are confident whenever the band has a non-degenerate coverage', () => {
    const s = buildRegionSignals(info({ bottom: 1000, cov: 0.3 }), scene());
    expect(scoreRegion('shadows', s).passed).toBe(true);
    expect(scoreRegion('highlights', s).passed).toBe(true);
  });

  it('subject: a present, solid within-box region passes; empty is rejected', () => {
    const present = buildRegionSignals(
      info({ top: 200, bottom: 600, cov: 0.1, fill: 0.5 }),
      scene()
    );
    expect(scoreRegion('subject', present).passed).toBe(true);
    expect(
      scoreRegion('subject', buildRegionSignals({ has_selection: false }, scene())).passed
    ).toBe(false);

    // The dog-on-grass case: a non-empty but near-zero-coverage wand grab (CE
    // extraction failed) must be HONEST ABSENCE, not floated to ~0.45 by box-fill
    // alone. Presence gates multiplicatively, so confidence collapses to 0.
    const nearEmpty = buildRegionSignals(
      info({ top: 200, bottom: 600, cov: 0.003, fill: 0.31 }),
      scene()
    );
    const sc = scoreRegion('subject', nearEmpty);
    expect(sc.passed).toBe(false);
    expect(sc.confidence).toBe(0);
  });

  it('above_horizon is confident when a horizon exists (honest geometric region)', () => {
    const s = buildRegionSignals(
      info({ bottom: 400, cov: 0.4 }),
      scene({ horizonConfidence: 0.7 })
    );
    expect(scoreRegion('above_horizon', s).passed).toBe(true);
  });
});
