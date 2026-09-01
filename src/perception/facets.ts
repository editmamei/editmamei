/**
 * Pure-JS facet analyzers for the scene model (Layer 1 perception).
 *
 * These are the "classical CV + arithmetic" facets the scene-model design calls
 * out as professional-grade in CE: horizon (sky/ground luminance split), tonal
 * zones (luminance thresholds), and composition geometry over the detected
 * subjects + horizon. They are deliberately dependency-free row/column reductions
 * over a 256-bin luminance histogram + box arithmetic, so they unit-test without
 * Photoshop or any image decode.
 *
 * Everything here works in (or returns) DOCUMENT pixels — the caller hands in the
 * doc dimensions and already-doc-px detection boxes.
 */

import type { BBox } from '../detection/detection-client.js';

/** A 256-bin luminance histogram of the composite, as getHistogram returns. */
export interface LumaHistogram {
  /** 256 counts, index = luminance 0..255. */
  bins: number[];
  total: number;
  mean: number;
  median: number;
}

export interface ThresholdPick {
  /** The 0..255 luminance level that best splits the histogram into two masses. */
  level: number;
  /** Fraction of pixels at or above `level` (the "bright"/sky side). */
  bright_fraction: number;
}

/**
 * The horizon — measured, or explicitly absent.
 *
 * `detected: false` is a real answer, not a placeholder. Every branch of this
 * facet used to return a rule-of-thirds prior (`y = docHeight/3`, confidence
 * 0.2) when it could not measure anything: a guess shaped exactly like a
 * measurement. Readers that checked `confidence` were fine; readers that took
 * `y` or `placement` at face value silently consumed a fabricated coordinate,
 * and nothing in the type stopped them.
 *
 * A refusal a caller must branch on is strictly better than a plausible number
 * with a small figure printed beside it.
 */
export type HorizonFacet =
  | {
      detected: true;
      /** Horizon y in document pixels (the sky→ground vertical boundary estimate). */
      y: number;
      /** 0..1 placement of the horizon down the frame (y / docHeight). */
      placement: number;
      /** 0..1 rough confidence from how cleanly the histogram splits (bimodality). */
      confidence: number;
    }
  | {
      detected: false;
      /** Why nothing was reported, so a caller can distinguish the cases. */
      reason: 'no-row-profile' | 'no-luminance-crossing' | 'dominant-subject';
    };

export interface TonalZones {
  /** Inclusive 0..255 luminance bounds for each band, histogram-picked. */
  shadows: { lower: 0; upper: number; coverage: number };
  midtones: { lower: number; upper: number; coverage: number };
  highlights: { lower: number; upper: 255; coverage: number };
}

export interface CompositionFacet {
  /** Rule-of-thirds cell the main subject's centre falls in, or null if no subject. */
  main_subject_cell: { col: 'left' | 'center' | 'right'; row: 'top' | 'middle' | 'bottom' } | null;
  /** 'left-weighted' | 'right-weighted' | 'balanced' from subject-mass centroid x. */
  balance: 'left-weighted' | 'right-weighted' | 'balanced' | 'unknown';
  /** 0..1 fraction of frame height above the topmost subject (null if no subject). */
  headroom: number | null;
  /** 0..1 horizon placement down the frame (mirrors HorizonFacet.placement), or null. */
  horizon_placement: number | null;
}

/**
 * Pick the luminance level that best separates the histogram into a dark mass and
 * a bright mass — Otsu's method (maximize between-class variance). This is the
 * histogram-driven threshold the scene model uses for the sky recipe and the
 * horizon split; it is per-image, not a hardcoded 120.
 */
export function pickThresholdLevel(hist: LumaHistogram): ThresholdPick {
  const { bins } = hist;
  const total = hist.total || bins.reduce((a, b) => a + b, 0);
  if (total <= 0) return { level: 128, bright_fraction: 0 };

  // Otsu: scan every threshold t, splitting [0..t] vs [t+1..255].
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * bins[i];

  let wB = 0; // weight (count) of the dark/background class
  let sumB = 0; // weighted sum of the dark class
  let bestFirst = 128;
  let bestLast = 128;
  let bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += bins[t];
    if (wB === 0) continue;
    const wF = total - wB; // bright/foreground class
    if (wF === 0) break;
    sumB += t * bins[t];
    const meanB = sumB / wB;
    const meanF = (sumAll - sumB) / wF;
    const between = wB * wF * (meanB - meanF) * (meanB - meanF);
    if (between > bestVar) {
      bestVar = between;
      bestFirst = t;
      bestLast = t;
    } else if (between === bestVar) {
      // The between-class variance plateaus across an empty gap between two
      // modes (a clean sky/ground split has no pixels between them). Track the
      // plateau so we can land the threshold at its MIDPOINT — between the modes
      // — instead of pinning it to the lower mode (the first maximum).
      bestLast = t;
    }
  }
  const level = Math.round((bestFirst + bestLast) / 2);

  // bright_fraction = mass strictly above the chosen level (the sky side for a
  // sky/ground split, where sky is the brighter region).
  let bright = 0;
  for (let i = level + 1; i < 256; i++) bright += bins[i];
  return { level, bright_fraction: bright / total };
}

/**
 * Estimate the horizon y from the per-row brightness profile: the sky is the
 * bright band at the top, the ground the darker band below, and the horizon is
 * the row where the running brightness crosses the histogram-picked threshold.
 *
 * `rowMeans` is a top→bottom array of mean luminance per row strip (length R,
 * each strip covering docHeight/R px). When row data isn't available we fall
 * back to a thirds-rule prior (horizon at 1/3 down) flagged with low confidence.
 */
export function estimateHorizon(
  rowMeans: number[] | undefined,
  docHeight: number,
  pick: ThresholdPick,
  /**
   * The main detected subject's box in DOCUMENT pixels, when there is one. Used
   * only to suppress a false horizon — see the dominant-subject guard below.
   */
  mainSubjectBox?: readonly [number, number, number, number] | null,
  /**
   * The primary detected FACE box in DOCUMENT pixels, when there is one. A
   * second, independent route into the same guard — see
   * isDominantSubjectCrossing for why the subject box alone isn't enough.
   */
  primaryFaceBox?: readonly [number, number, number, number] | null
): HorizonFacet {
  // Confidence from how decisively the histogram split bright vs dark: a clean
  // sky/ground photo splits near 50/50-ish with a strong Otsu separation; a flat
  // or textured frame splits weakly. We proxy that as distance of bright_fraction
  // from the degenerate extremes (0 or 1).
  const split = pick.bright_fraction;
  const splitConfidence = Math.max(0, Math.min(1, 1 - Math.abs(0.5 - split) * 2)) * 0.6 + 0.2;

  if (!rowMeans || rowMeans.length === 0) {
    return { detected: false, reason: 'no-row-profile' };
  }

  const R = rowMeans.length;
  // Find the first row (scanning top→bottom) where the mean drops below the
  // threshold level — the sky→ground transition. If the whole frame is above or
  // below threshold, there's no clear horizon; fall back to thirds.
  let crossRow = -1;
  for (let r = 0; r < R; r++) {
    if (rowMeans[r] < pick.level) {
      crossRow = r;
      break;
    }
  }
  if (crossRow <= 0) {
    return { detected: false, reason: 'no-luminance-crossing' };
  }
  const y = Math.round((crossRow / R) * docHeight);

  // DOMINANT-SUBJECT GUARD: this method only knows "bright band on top, darker
  // band below" — it cannot tell a skyline from the edge of a big foreground
  // subject. On a studio portrait (pale backdrop above, hair/clothing below) it
  // finds a crossing at the subject's shoulders and reports it as a horizon.
  // Live 2026-07-30: a 51MP studio headshot returned horizon y=5563 at
  // confidence 0.73 — there is no horizon in that frame at all.
  //
  // When a subject fills most of the frame AND the crossing falls inside that
  // subject's box, the transition is explained by the subject, so there is no
  // horizon to report. This previously demoted to the thirds prior because the
  // field was non-optional and composition math consumed `placement` — the
  // facet is now a discriminated union precisely so this case can say so.
  if (
    (mainSubjectBox && isDominantSubjectCrossing(y, docHeight, mainSubjectBox)) ||
    (primaryFaceBox && isPortraitFaceCrossing(y, docHeight, primaryFaceBox))
  ) {
    return { detected: false, reason: 'dominant-subject' };
  }

  return {
    detected: true,
    y,
    placement: y / docHeight,
    confidence: Math.max(0, Math.min(1, splitConfidence)),
  };
}

/**
 * True when the detected brightness crossing is better explained by a dominant
 * foreground subject than by a horizon: the subject covers a majority of the
 * frame's height AND the crossing row sits inside its vertical span.
 *
 * The height fraction is deliberately high (0.6). A person standing in a
 * landscape occupies a minority of the frame and must NOT suppress a real
 * horizon; a studio portrait's subject spans nearly the whole frame.
 */
function isDominantSubjectCrossing(
  y: number,
  docHeight: number,
  box: readonly [number, number, number, number]
): boolean {
  if (docHeight <= 0) return false;
  const [, top, , bottom] = box;
  const spans = (bottom - top) / docHeight;
  return spans >= 0.6 && y >= top && y <= bottom;
}

/**
 * The FACE route into the same guard, for the case the subject box misses.
 *
 * A tight head-and-shoulders crop is frequently NOT classified `person` by
 * COCO — the detector wants more of a body — so `mainSubjectBox` is null on
 * exactly the portraits most likely to produce a false horizon, while the face
 * detector fires cleanly. Without this, the studio-headshot case survives the
 * subject guard untouched.
 *
 * Two conditions, both deliberately conservative:
 *  - the face spans >= 25% of frame height. That is a headshot or half-body,
 *    not a person standing in a landscape (whose face is a few percent). The
 *    threshold is high on purpose: a real horizon in an environmental portrait
 *    must not be suppressed.
 *  - the crossing sits BELOW the top of the face. In a portrait the brightness
 *    transition is the hair/shoulder line, always below the face top; a genuine
 *    horizon above the subject's head is left alone.
 */
function isPortraitFaceCrossing(
  y: number,
  docHeight: number,
  face: readonly [number, number, number, number]
): boolean {
  if (docHeight <= 0) return false;
  const [, top, , bottom] = face;
  const spans = (bottom - top) / docHeight;
  return spans >= 0.25 && y >= top;
}

/**
 * Split the luminance range into shadow / midtone / highlight bands and report
 * each band's coverage (fraction of pixels). The bounds are histogram-driven:
 * the shadow/midtone and midtone/highlight cuts are the two interior quantile
 * boundaries that put roughly a third of the mass in each band, clamped to sane
 * defaults so a flat image still yields usable bands.
 */
export function computeTonalZones(hist: LumaHistogram): TonalZones {
  const { bins } = hist;
  const total = hist.total || bins.reduce((a, b) => a + b, 0);

  const coverageBetween = (lo: number, hi: number): number => {
    if (total <= 0) return 0;
    let c = 0;
    for (let i = lo; i <= hi; i++) c += bins[i];
    return c / total;
  };

  // Default cuts (PS-ish shadow ≤ 85, highlight ≥ 170) nudged toward the actual
  // quantile boundaries so the bands track the image. We find the level where the
  // cumulative mass first exceeds 1/3 (shadow/mid cut) and 2/3 (mid/highlight cut).
  let cum = 0;
  let cut1 = 85;
  let cut2 = 170;
  let found1 = false;
  if (total > 0) {
    for (let i = 0; i < 256; i++) {
      cum += bins[i];
      const frac = cum / total;
      if (!found1 && frac >= 1 / 3) {
        cut1 = i;
        found1 = true;
      }
      if (frac >= 2 / 3) {
        cut2 = i;
        break;
      }
    }
  }
  // Clamp so the bands never invert or collapse to a sliver.
  cut1 = Math.max(20, Math.min(120, cut1));
  cut2 = Math.max(cut1 + 20, Math.min(235, cut2));

  return {
    shadows: { lower: 0, upper: cut1, coverage: coverageBetween(0, cut1) },
    midtones: { lower: cut1 + 1, upper: cut2, coverage: coverageBetween(cut1 + 1, cut2) },
    highlights: { lower: cut2 + 1, upper: 255, coverage: coverageBetween(cut2 + 1, 255) },
  };
}

/** Centre x/y of a box. */
function boxCenter(b: BBox): { x: number; y: number } {
  return { x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2 };
}

/** Area of a box (clamped to ≥0). */
export function boxArea(b: BBox): number {
  return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
}

/**
 * Geometry-over-the-others composition facet: which thirds cell the main subject
 * sits in, left/right balance from the subject-mass centroid, headroom above the
 * topmost subject, and the horizon placement passed through.
 *
 * `mainBox` is the chosen main-subject box (largest, by convention); `allBoxes`
 * are every subject box (for the balance centroid). Both in document pixels.
 */
export function computeComposition(
  mainBox: BBox | null,
  allBoxes: BBox[],
  docWidth: number,
  docHeight: number,
  horizonPlacement: number | null
): CompositionFacet {
  let cell: CompositionFacet['main_subject_cell'] = null;
  let headroom: number | null = null;
  if (mainBox && docWidth > 0 && docHeight > 0) {
    const c = boxCenter(mainBox);
    const col = c.x < docWidth / 3 ? 'left' : c.x < (2 * docWidth) / 3 ? 'center' : 'right';
    const row = c.y < docHeight / 3 ? 'top' : c.y < (2 * docHeight) / 3 ? 'middle' : 'bottom';
    cell = { col, row };
    // Headroom = fraction of frame above the topmost subject edge.
    const top = Math.min(...allBoxes.map((b) => b[1]), mainBox[1]);
    headroom = Math.max(0, Math.min(1, top / docHeight));
  }

  let balance: CompositionFacet['balance'] = 'unknown';
  if (allBoxes.length > 0 && docWidth > 0) {
    // Area-weighted centroid x of all subject mass.
    let wsum = 0;
    let xsum = 0;
    for (const b of allBoxes) {
      const a = boxArea(b);
      wsum += a;
      xsum += a * boxCenter(b).x;
    }
    if (wsum > 0) {
      const cx = xsum / wsum / docWidth; // 0..1
      balance = cx < 0.42 ? 'left-weighted' : cx > 0.58 ? 'right-weighted' : 'balanced';
    }
  }

  return {
    main_subject_cell: cell,
    balance,
    headroom,
    horizon_placement: horizonPlacement,
  };
}

/** Build a LumaHistogram from a raw getHistogram payload, defensively. */
export function toLumaHistogram(raw: {
  bins?: number[];
  total_pixels?: number;
  mean?: number;
  median?: number;
}): LumaHistogram {
  const bins =
    Array.isArray(raw.bins) && raw.bins.length === 256 ? raw.bins : new Array(256).fill(0);
  const total =
    typeof raw.total_pixels === 'number' ? raw.total_pixels : bins.reduce((a, b) => a + b, 0);
  return {
    bins,
    total,
    mean: typeof raw.mean === 'number' ? raw.mean : 0,
    median: typeof raw.median === 'number' ? raw.median : 0,
  };
}
