/**
 * Region confidence scorer (Scene Model v2).
 *
 * A region selection has no native detector confidence — we PRODUCE it, so we
 * SCORE it. The score splits into two kinds of signal, and that split is what
 * makes model-tuning safe:
 *
 *   - Structural floor (NEVER tuned): coherence/solidity, alignment with the
 *     measured horizon, and per-type spatial sanity. Catches genuine garbage
 *     regardless of artistic intent — it doesn't care how big the region
 *     "should" be.
 *   - Compositional priors (DEFAULTS the model tunes): coverage extent + spatial
 *     strictness. These depend on the shot; the reasoning model relaxes them from
 *     the preview (a big-sky minimalist composition), so an artistic shot is not
 *     rejected for breaking the "balanced" norm — while the structural floor still
 *     rejects a fragmented urban bright-blob.
 *
 * Pure functions over already-measured signals (PS selection_info + the scene
 * model's horizon/dims) — no Photoshop, no image decode, fully unit-testable. The
 * expensive mask production + measurement runs once upstream; re-scoring with a
 * model-supplied `CompositionContext` is just re-applying these thresholds to the
 * cached signals.
 */

/** Region/target kinds the scorer knows. Mirrors the select-by-reference targets. */
export type ScoredRegionKind =
  | 'sky'
  | 'ground'
  | 'foliage'
  | 'subject'
  | 'face'
  | 'shadows'
  | 'highlights'
  | 'skin'
  | 'above_horizon';

/**
 * Measured signals for one candidate selection. Built from PS `selection_info`
 * plus the scene model's horizon + doc dims by {@link buildRegionSignals}.
 */
export interface RegionSignals {
  /** 0..1 fraction of the frame the selection covers (area_percent / 100). */
  coverage: number;
  /** 0..1 fraction of partially-selected edge pixels (feathered ⇒ higher). */
  edgeComplexity: number;
  /** 0..1 pixel_count / bounds_area — solidity of the bounding box (scattered ⇒ low). */
  fillRatio: number;
  /** Selection bounds in document px, or null when empty. */
  bounds: { left: number; top: number; right: number; bottom: number } | null;
  /** 0..1 vertical centroid (bounds centre y / docH). */
  centroidY: number;
  /** True when the selection reaches the very bottom of the frame. */
  touchesBottom: boolean;
  /** True when the selection reaches the very top of the frame. */
  touchesTop: boolean;
  /**
   * 0..1 how well the selection's LOWER edge tracks the measured horizon (1 = the
   * edge sits on the horizon) — the signal sky uses. null when no usable horizon.
   */
  horizonAlignment: number | null;
  /** 0..1 how well the selection's UPPER edge tracks the horizon — the signal ground uses. */
  upperEdgeAlignment: number | null;
  /** 0..1 confidence of the scene model's horizon estimate (passed through). */
  horizonConfidence: number;
  /**
   * 0..1 how INDOOR the scene looks, from detected furniture/appliance density
   * (bed/sofa/diningtable/…). Used to suppress a "sky" that is really a bright
   * ceiling/wall in an interior — a real outdoor sky has no indoor furniture, so
   * an artistic outdoor shot is never penalised. 1 ⇒ clearly indoors.
   */
  indoorness: number;
  /** True when a selection actually exists (has_selection). */
  hasSelection: boolean;
}

/**
 * Model-supplied compositional context that TUNES the priors (never the floor).
 * The reasoning model fills this in from the preview; everything is optional and
 * defaults apply when omitted.
 */
export interface CompositionContext {
  /**
   * A coarse composition profile the model reads off the preview. Maps to prior
   * relaxations so the common cases need no explicit numbers.
   */
  profile?: 'balanced' | 'big_sky' | 'big_foreground' | 'minimal' | 'tight_subject';
  /** Explicit override: max sky coverage before it's "too much" (default 0.55). */
  skyCoverageMax?: number;
  /** Explicit override: max ground coverage (default 0.92). */
  groundCoverageMax?: number;
  /** Explicit override: pass threshold on the 0..1 confidence (default 0.6). */
  passThreshold?: number;
}

export interface RegionScore {
  kind: ScoredRegionKind;
  /** 0..1 overall confidence. */
  confidence: number;
  /** confidence ≥ the (tunable) pass threshold AND no hard structural veto. */
  passed: boolean;
  /** Human/agent-readable contributors (for the oversight surface + debugging). */
  reasons: string[];
  signals: RegionSignals;
}

const DEFAULTS = {
  skyCoverageMax: 0.55,
  groundCoverageMax: 0.92,
  passThreshold: 0.6,
};

/** Resolve the effective priors from defaults + profile + explicit overrides. */
function resolvePriors(ctx: CompositionContext | undefined): {
  skyCoverageMax: number;
  groundCoverageMax: number;
  passThreshold: number;
} {
  let skyMax = DEFAULTS.skyCoverageMax;
  let groundMax = DEFAULTS.groundCoverageMax;
  switch (ctx?.profile) {
    case 'big_sky':
    case 'minimal':
      skyMax = 0.9; // a dramatic sky may fill most of the frame
      break;
    case 'big_foreground':
      skyMax = 0.4;
      break;
    case 'tight_subject':
    case 'balanced':
    default:
      break;
  }
  // Explicit overrides win over the profile.
  if (typeof ctx?.skyCoverageMax === 'number') skyMax = ctx.skyCoverageMax;
  if (typeof ctx?.groundCoverageMax === 'number') groundMax = ctx.groundCoverageMax;
  const passThreshold =
    typeof ctx?.passThreshold === 'number' ? ctx.passThreshold : DEFAULTS.passThreshold;
  return { skyCoverageMax: skyMax, groundCoverageMax: groundMax, passThreshold };
}

/** Linear ramp: 1 below `good`, 0 above `bad`, linear between. */
function rampDown(v: number, good: number, bad: number): number {
  if (v <= good) return 1;
  if (v >= bad) return 0;
  return 1 - (v - good) / (bad - good);
}

/**
 * Build measured signals from a PS `selection_info` payload + the scene context.
 * Pure: the caller supplies the already-read selection_info (from getSelectionState
 * or a selection snippet) and the doc/horizon facts.
 */
export function buildRegionSignals(
  info: {
    has_selection?: boolean;
    bounds?: { left: number; top: number; right: number; bottom: number } | null;
    area_percent?: number;
    edge_complexity?: number;
    bounds_fill_ratio?: number;
  } | null,
  scene: {
    docW: number;
    docH: number;
    /** null when no horizon was measured — never substitute a prior. */
    horizonY: number | null;
    horizonConfidence: number;
    /** Count of detected INDOOR furniture/appliance objects (bed/sofa/…). */
    indoorObjectCount?: number;
  }
): RegionSignals {
  const hasSelection = info?.has_selection ?? (info?.bounds ? true : false);
  const bounds = info?.bounds ?? null;
  const docH = scene.docH > 0 ? scene.docH : 1;
  const coverage = Math.max(0, Math.min(1, (info?.area_percent ?? 0) / 100));
  const edgeComplexity = Math.max(0, Math.min(1, info?.edge_complexity ?? 0));
  const fillRatio = Math.max(0, Math.min(1, info?.bounds_fill_ratio ?? 0));

  let centroidY = 0.5;
  let touchesBottom = false;
  let touchesTop = false;
  let lowerEdgeAlign: number | null = null;
  let upperEdgeAlign: number | null = null;
  if (bounds) {
    centroidY = (bounds.top + bounds.bottom) / 2 / docH;
    touchesBottom = bounds.bottom >= docH * 0.97;
    touchesTop = bounds.top <= docH * 0.03;
    // Alignment requires BOTH a positive confidence and a measured y. Confidence
    // alone is the semantic gate — a zero-confidence horizon means "no usable
    // horizon", so alignment stays null and sky/ground take the neutral 0.5
    // rather than trusting a guessed line. The null check is not redundant:
    // buildRegionSignals is exported, so a direct caller can pass a refused
    // horizon, and subtracting null would yield NaN alignment.
    if (scene.horizonConfidence > 0 && scene.horizonY !== null) {
      // |edge − horizon| as a fraction of frame height → alignment in [0,1].
      lowerEdgeAlign = 1 - Math.min(1, Math.abs(bounds.bottom - scene.horizonY) / docH);
      upperEdgeAlign = 1 - Math.min(1, Math.abs(bounds.top - scene.horizonY) / docH);
    }
  }

  return {
    coverage,
    edgeComplexity,
    fillRatio,
    bounds,
    centroidY,
    touchesBottom,
    touchesTop,
    horizonAlignment: lowerEdgeAlign,
    upperEdgeAlignment: upperEdgeAlign,
    horizonConfidence: Math.max(0, Math.min(1, scene.horizonConfidence)),
    // 2+ indoor objects ⇒ fully indoors; clamps a single ambiguous hit to 0.5.
    indoorness: Math.max(0, Math.min(1, (scene.indoorObjectCount ?? 0) / 2)),
    hasSelection,
  };
}

/**
 * Score a candidate region. `kind` selects the per-type weighting; `signals` are
 * measured; `ctx` tunes the compositional priors (never the structural floor).
 */
export function scoreRegion(
  kind: ScoredRegionKind,
  signals: RegionSignals,
  ctx?: CompositionContext
): RegionScore {
  const priors = resolvePriors(ctx);
  const reasons: string[] = [];

  if (!signals.hasSelection || signals.coverage <= 0) {
    return {
      kind,
      confidence: 0,
      passed: false,
      reasons: ['empty selection'],
      signals,
    };
  }

  let confidence: number;

  switch (kind) {
    case 'sky': {
      // Structural FLOOR (never tuned, weights sum to 1): a sky is a coherent
      // upper band whose lower edge tracks the horizon, does NOT reach the
      // bottom, and is backed by a confident horizon.
      const upper = rampDown(signals.centroidY, 0.35, 0.65); // mass should sit high
      const notBottom = signals.touchesBottom ? 0 : 1;
      const align = signals.horizonAlignment ?? 0.5;
      const floor =
        0.34 * upper + 0.3 * notBottom + 0.22 * align + 0.14 * signals.horizonConfidence;
      // TUNABLE coverage gate (multiplicative): a region covering most of the
      // frame is suspect BY DEFAULT (could be an over-grab) — the model relaxes
      // skyCoverageMax for a genuine big-sky composition. A low floor (urban
      // bright blob) can't be rescued by relaxing coverage.
      const coverageGate = rampDown(
        signals.coverage,
        priors.skyCoverageMax,
        priors.skyCoverageMax + 0.3
      );
      // Interior suppression (multiplicative, structural): a bright UPPER region
      // in a furnished room is a ceiling/wall, not sky. Detected indoor furniture
      // density drives the penalty; an outdoor scene has none, so a legitimate
      // (even artistic) sky is never touched. The model can still override via a
      // lower pass_threshold when it really means an interior window-sky.
      const indoorPenalty = 1 - 0.7 * signals.indoorness;
      confidence = floor * coverageGate * indoorPenalty;
      reasons.push(
        `floor=${floor.toFixed(2)}`,
        `upper=${upper.toFixed(2)}`,
        `notBottom=${notBottom}`,
        `align=${align.toFixed(2)}`,
        `coverageGate=${coverageGate.toFixed(2)}(cov=${signals.coverage.toFixed(2)}/${priors.skyCoverageMax})`,
        `indoorPenalty=${indoorPenalty.toFixed(2)}(indoor=${signals.indoorness.toFixed(2)})`
      );
      break;
    }
    case 'ground': {
      // Ground = invert(confident sky) − subjects: the complement of a region
      // that ALREADY cleared the sky gate, so it inherits a BASELINE validity
      // (0.35). Sitting low + tracking the horizon are bonuses, not gates — a
      // mountainous scene where the not-sky landmass reaches high (mid centroid)
      // is still a valid ground. Coverage still gates a degenerate near-full grab.
      const lower = rampDown(1 - signals.centroidY, 0.35, 0.65); // bonus: mass sits low
      const align = signals.upperEdgeAlignment ?? signals.horizonAlignment ?? 0.5;
      const floor = 0.35 + 0.3 * lower + 0.2 * align + 0.15 * signals.horizonConfidence;
      const coverageGate = rampDown(signals.coverage, priors.groundCoverageMax, 0.99);
      confidence = floor * coverageGate;
      reasons.push(
        `floor=${floor.toFixed(2)}`,
        `lower=${lower.toFixed(2)}`,
        `upperAlign=${align.toFixed(2)}`,
        `coverageGate=${coverageGate.toFixed(2)}`
      );
      break;
    }
    case 'foliage': {
      // Foliage: a real (non-trivial) selection that isn't the whole frame.
      const sized = rampDown(Math.abs(signals.coverage - 0.3), 0.25, 0.6); // peak near a meaningful patch
      const notAll = signals.coverage < 0.85 ? 1 : 0;
      confidence = 0.6 * sized + 0.4 * notAll;
      reasons.push(`coverage=${signals.coverage.toFixed(2)}`, `notAll=${notAll}`);
      break;
    }
    case 'shadows':
    case 'highlights': {
      // Tonal bands exist in essentially every image; confident as long as the
      // band has a meaningful, non-degenerate coverage.
      const sized = signals.coverage >= 0.03 && signals.coverage <= 0.95 ? 1 : 0.3;
      confidence = 0.85 * sized + 0.15;
      reasons.push(`coverage=${signals.coverage.toFixed(2)}`);
      break;
    }
    case 'skin': {
      // skin = colour ∩ subject box; confident when something solid remains.
      const present = signals.coverage >= 0.01 ? 1 : 0;
      const solid = Math.min(1, signals.fillRatio * 2); // higher box fill ⇒ better
      confidence = 0.6 * present + 0.4 * solid;
      reasons.push(
        `coverage=${signals.coverage.toFixed(2)}`,
        `fill=${signals.fillRatio.toFixed(2)}`
      );
      break;
    }
    case 'subject':
    case 'face': {
      // CE subject/face: a within-box region; confident when present + reasonably
      // solid. (Pro refine, when entitled, supersedes this method entirely.)
      // Presence GATES the score multiplicatively: when the box-posterize-wand
      // grabs essentially nothing (coverage ≈ 0 — the dog-on-grass case where CE
      // extraction fails), box-fill alone must NOT float it to a borderline 0.45.
      // No selection ⇒ honest absence (0), so the caller can fall back / Pro-refine.
      const present = signals.coverage >= 0.005 ? 1 : 0;
      const solid = signals.fillRatio >= 0.15 ? 1 : signals.fillRatio / 0.15;
      confidence = present * (0.55 + 0.45 * solid);
      reasons.push(
        `coverage=${signals.coverage.toFixed(2)}`,
        `fill=${signals.fillRatio.toFixed(2)}`
      );
      break;
    }
    case 'above_horizon': {
      // Honest geometric region — always valid when a horizon exists.
      confidence = signals.horizonConfidence > 0 ? 0.8 : 0.5;
      reasons.push(`horizonConf=${signals.horizonConfidence.toFixed(2)}`);
      break;
    }
    default:
      confidence = 0.5;
  }

  confidence = Math.max(0, Math.min(1, confidence));
  return {
    kind,
    confidence,
    passed: confidence >= priors.passThreshold,
    reasons,
    signals,
  };
}
