import { describe, it, expect } from 'vitest';
import { resolveSelection } from '@editmamei/perception/select-recipes.ts';
import type { SceneModel } from '@editmamei/perception/scene-model.ts';
import { makeConnection } from '../fixtures/fake-connection.ts';
import { makeSnippetClient } from '../fixtures/fake-snippet-client.ts';

// select-recipes.ts merge (2026-07-29): every recipe used to do a DERIVE round
// trip, then a SEPARATE `getSelectionInfo()` measure round trip before the
// Node-side region scorer could decide pass/fail. Two facts make that second
// trip redundant for most recipes:
//   1. The inline derive scripts (threshold-sky / posterize-region) can embed
//      `getSelectionInfo()` themselves and return its result directly — ONE
//      script does derive + measure.
//   2. The proven go-core snippets (selectLuminanceRange / selectColorPreset /
//      selectRectangle / selectEllipse) ALREADY return their own
//      `selection_info` — the separate measure call was discarding that and
//      re-measuring from scratch.
// These tests pin the resulting PS-round-trip counts (via
// `conn.executions.length`) and the merged scripts' fragment ORDER, using a
// deterministic "empty selection" fixture so every gate fails the SAME way
// (confidence 0, `reasons: ['empty selection']`) regardless of the per-kind
// scoring formula — that keeps the trip-count assertions independent of the
// region-scorer's tuning. A couple of dedicated PASS-path fixtures (with
// hand-verified, non-boundary confidence margins) confirm the merge still
// delivers a working selection end-to-end, not just a faster failure.

const EMPTY_INFO = { has_selection: false };

/** Every derive script's own measurement reports an empty selection — every
 *  recipe's gate fails via `scoreRegion`'s shared "empty selection" early-out,
 *  independent of the kind-specific formula. */
function failEverythingRouter(script: string): unknown {
  if (script.includes('return getSelectionInfo()')) return EMPTY_INFO;
  if (
    script.includes('"__snippet":"selectLuminanceRange"') ||
    script.includes('"__snippet":"selectColorPreset"') ||
    script.includes('"__snippet":"selectRectangle"') ||
    script.includes('"__snippet":"selectEllipse"')
  ) {
    return { selection_info: EMPTY_INFO };
  }
  return { ok: true };
}

function baseModel(overrides: Partial<SceneModel> = {}): SceneModel {
  return {
    doc: { width: 1000, height: 800 },
    subjects: [],
    faces: [],
    regions: [{ kind: 'sky', coverage: 0.2, recipe: { kind: 'threshold_white', level: 128 } }],
    horizon: { detected: true, y: 80, placement: 0.1, confidence: 1 },
    tonal_zones: {
      shadows: { lower: 0, upper: 80, coverage: 0.3 },
      midtones: { lower: 81, upper: 180, coverage: 0.4 },
      highlights: { lower: 181, upper: 255, coverage: 0.3 },
    },
    composition: {
      main_subject_cell: null,
      balance: 'balanced',
      headroom: null,
      horizon_placement: 0.1,
    },
    provenance: {
      backends: { regions: 'heuristic' },
      edition: 'dev',
      cache_key: 'k1',
      cached: false,
    },
    ...overrides,
  };
}

describe('select-recipes trip-count merge', () => {
  // ---------- simple (single-derive) recipes: 2 PS trips on a failing gate,
  // down from 3 (derive + measure + deselect) ----------

  it('foliage fails cleanly in 2 PS trips (was 3: derive + measure + deselect)', async () => {
    const conn = makeConnection({ resultFor: failEverythingRouter });
    const sc = makeSnippetClient();
    const res = await resolveSelection(conn.asConnection(), sc, baseModel(), 'foliage');
    expect(res.passed).toBe(false);
    expect(res.method).toBe('posterize_region');
    expect(conn.executions.length).toBe(2);
  });

  it('shadows / highlights fail cleanly in 2 PS trips (was 3)', async () => {
    const conn = makeConnection({ resultFor: failEverythingRouter });
    const sc = makeSnippetClient();
    const res = await resolveSelection(conn.asConnection(), sc, baseModel(), 'shadows');
    expect(res.passed).toBe(false);
    expect(res.method).toBe('luminance_range');
    expect(conn.executions.length).toBe(2);
  });

  it('above_horizon fails cleanly in 2 PS trips (was 3)', async () => {
    const conn = makeConnection({ resultFor: failEverythingRouter });
    const sc = makeSnippetClient();
    const res = await resolveSelection(conn.asConnection(), sc, baseModel(), 'above_horizon');
    expect(res.passed).toBe(false);
    expect(res.method).toBe('rectangle_to_horizon');
    expect(conn.executions.length).toBe(2);
  });

  it('subject (CE, no proRefine) fails cleanly in 2 PS trips (was 3)', async () => {
    const conn = makeConnection({ resultFor: failEverythingRouter });
    const sc = makeSnippetClient();
    const model = baseModel({
      subjects: [
        { id: 's1', label: 'dog', bbox: [100, 100, 300, 300], confidence: 0.9, is_main: true },
      ],
    });
    const res = await resolveSelection(conn.asConnection(), sc, model, 'subject');
    expect(res.passed).toBe(false);
    expect(res.method).toBe('box_posterize_wand');
    expect(conn.executions.length).toBe(2);
  });

  it('face (CE, no proRefine) fails cleanly in 2 PS trips (was 3)', async () => {
    const conn = makeConnection({ resultFor: failEverythingRouter });
    const sc = makeSnippetClient();
    const model = baseModel({
      faces: [{ bbox: [40, 40, 120, 140], confidence: 0.9, is_primary: true }],
    });
    const res = await resolveSelection(conn.asConnection(), sc, model, 'face');
    expect(res.passed).toBe(false);
    expect(res.method).toBe('face_box_ellipse');
    expect(conn.executions.length).toBe(2);
  });

  it('subject / face with nothing detected stay honest-absence with ZERO PS trips (merge adds no overhead)', async () => {
    const conn = makeConnection({ resultFor: failEverythingRouter });
    const sc = makeSnippetClient();
    const model = baseModel();
    const subj = await resolveSelection(conn.asConnection(), sc, model, 'subject');
    const face = await resolveSelection(conn.asConnection(), sc, model, 'face');
    expect(subj.passed).toBe(false);
    expect(face.passed).toBe(false);
    expect(conn.executions.length).toBe(0);
  });

  // ---------- skin: multi-step derive, still merges (no separate final measure) ----------

  it('skin with NO person or face is honest absence — short-circuits before any colour-range trip', async () => {
    const conn = makeConnection({ resultFor: failEverythingRouter });
    const sc = makeSnippetClient();
    const res = await resolveSelection(conn.asConnection(), sc, baseModel(), 'skin');
    expect(res.passed).toBe(false);
    expect(res.confidence).toBe(0);
    expect(res.detail.intersected_with_box).toBe(false);
    expect(res.detail.no_person_or_face).toBe(true);
    expect(res.reasons.join(' ')).toContain('no person or face detected');
    // 1 trip (the deselect), not 2: the colour-range no longer runs at all.
    // Skin-tone colour without a person box selects anything warm — live
    // 2026-07-30 a night cityscape's amber bridge lighting scored 0.67 and was
    // offered as a confident `scene:skin`. The box is what made this method
    // meaningful, so with no person the honest answer is absence.
    expect(conn.executions.length).toBe(1);
  });

  it('skin (with a person box) fails cleanly in 3 PS trips (was 4: colorPreset + intersect + measure + deselect)', async () => {
    const conn = makeConnection({ resultFor: failEverythingRouter });
    const sc = makeSnippetClient();
    const model = baseModel({
      subjects: [
        { id: 's1', label: 'person', bbox: [20, 20, 120, 400], confidence: 0.9, is_main: true },
      ],
    });
    const res = await resolveSelection(conn.asConnection(), sc, model, 'skin');
    expect(res.passed).toBe(false);
    expect(res.detail.intersected_with_box).toBe(true);
    expect(conn.executions.length).toBe(3);
    // The hoist (Promise.all) doesn't change WHAT gets built, just when — both
    // snippets are still built with the same params (then 'deselect' on the
    // failing gate, unchanged from before the merge).
    const names = sc.allBuilds().map((b) => b.name);
    expect(names).toEqual(['selectColorPreset', 'selectRectangle', 'deselect']);
  });

  // ---------- ground: two merge points either side of the sky-passed branch ----------

  it('ground fails cleanly in 2 PS trips when the sky pre-check fails (was 3)', async () => {
    const conn = makeConnection({ resultFor: failEverythingRouter });
    const sc = makeSnippetClient();
    const model = baseModel({
      subjects: [
        { id: 's1', label: 'dog', bbox: [200, 200, 600, 600], confidence: 0.9, is_main: true },
      ],
    });
    const res = await resolveSelection(conn.asConnection(), sc, model, 'ground');
    expect(res.passed).toBe(false);
    expect(res.method).toBe('invert_sky_minus_subjects');
    expect(conn.executions.length).toBe(2);
    // Never inverted a sky it didn't trust.
    expect(sc.allBuilds().some((b) => b.name === 'invertSelection')).toBe(false);
  });

  it('ground reaches invert+subtract with NO separate final measure when the sky pre-check passes (2 subjects: 4 trips, was 6)', async () => {
    const conn = makeConnection({
      resultFor: (script: string) => {
        if (script.includes('return getSelectionInfo()')) {
          // The merged threshold-sky derive+measure: a clean, generously
          // top-anchored region (centroidY 0.05, exactly horizon-aligned,
          // well under the sky coverage gate) — confidence computes to 1.0,
          // not a boundary value.
          return {
            has_selection: true,
            bounds: { left: 0, top: 0, right: 1000, bottom: 80 },
            area_percent: 10,
            bounds_fill_ratio: 0.9,
            edge_complexity: 0.02,
          };
        }
        if (script.includes('"__snippet":"selectRectangle"')) {
          // Each subtract's own embedded selection_info (post-op measurement).
          return { selection_info: { has_selection: true, area_percent: 20 } };
        }
        return { ok: true };
      },
    });
    const sc = makeSnippetClient();
    const model = baseModel({
      subjects: [
        { id: 's1', label: 'dog', bbox: [200, 200, 600, 600], confidence: 0.9, is_main: true },
        { id: 's2', label: 'person', bbox: [20, 20, 120, 400], confidence: 0.9, is_main: false },
      ],
    });
    const res = await resolveSelection(conn.asConnection(), sc, model, 'ground');
    expect(res.method).toBe('invert_sky_minus_subjects');
    expect(res.passed).toBe(true);
    expect(res.detail.subjects_subtracted).toBe(2);
    // 1 merged sky pre-check + 1 invert + 2 subtracts = 4 (was thr(1)+measure(1)+
    // invert(1)+subtract(2)+final-measure(1) = 6).
    expect(conn.executions.length).toBe(4);
    const names = sc.allBuilds().map((b) => b.name);
    expect(names).toEqual(['invertSelection', 'selectRectangle', 'selectRectangle']);
  });

  // ---------- above_horizon: a clean PASS in a single trip ----------

  it('above_horizon PASSES in a single PS trip when the derive reports a real selection', async () => {
    const conn = makeConnection({
      resultFor: (script: string) => {
        if (script.includes('"__snippet":"selectRectangle"')) {
          return { selection_info: { has_selection: true, area_percent: 5 } };
        }
        return { ok: true };
      },
    });
    const sc = makeSnippetClient();
    const res = await resolveSelection(conn.asConnection(), sc, baseModel(), 'above_horizon');
    expect(res.passed).toBe(true);
    expect(res.method).toBe('rectangle_to_horizon');
    expect(conn.executions.length).toBe(1);
  });

  // ---------- sky: bestOf's per-candidate trip reduction ----------

  it('sky bestOf issues 5 PS trips when both candidates fail the gate (was 7)', async () => {
    const conn = makeConnection({ resultFor: failEverythingRouter });
    const sc = makeSnippetClient();
    const res = await resolveSelection(conn.asConnection(), sc, baseModel(), 'sky');
    expect(res.passed).toBe(false);
    // Tie at confidence 0 — the first-tried candidate (threshold) keeps the win
    // (bestOf's `>` comparison, unchanged).
    expect(res.method).toBe('threshold_white');
    expect(sc.allBuilds().some((b) => b.name === 'selectSky')).toBe(true);
    // threshold-try(1, merged) + sensei-try(2: derive + separate measure) +
    // rerun-winner(1, merged) + deselect(1) = 5 (was 2+2+2+1 = 7).
    expect(conn.executions.length).toBe(5);
  });

  // ---------- merged-script shape: derive fragment BEFORE the measure/return ----------

  it('the merged threshold-sky script contains the derive glue BEFORE `return getSelectionInfo()`', async () => {
    const conn = makeConnection({ resultFor: failEverythingRouter });
    const sc = makeSnippetClient();
    await resolveSelection(conn.asConnection(), sc, baseModel(), 'sky');
    const thr = conn.allScripts().find((s) => s.includes('__mcp_scene_thr__'));
    expect(thr, 'merged threshold script dispatched').toBeTruthy();
    expect(thr).toContain('return getSelectionInfo();');
    expect(thr!.indexOf('__mcp_scene_thr__')).toBeLessThan(
      thr!.indexOf('return getSelectionInfo();')
    );
  });

  it('the merged posterize-region script contains the derive glue BEFORE `return getSelectionInfo()`', async () => {
    const conn = makeConnection({ resultFor: failEverythingRouter });
    const sc = makeSnippetClient();
    const model = baseModel({
      subjects: [
        { id: 's1', label: 'dog', bbox: [100, 100, 300, 300], confidence: 0.9, is_main: true },
      ],
    });
    await resolveSelection(conn.asConnection(), sc, model, 'subject');
    const pst = conn.allScripts().find((s) => s.includes('__mcp_scene_pst__'));
    expect(pst, 'merged posterize script dispatched').toBeTruthy();
    expect(pst).toContain('return getSelectionInfo();');
    expect(pst!.indexOf('__mcp_scene_pst__')).toBeLessThan(
      pst!.indexOf('return getSelectionInfo();')
    );
  });
});

describe('select-recipes — fallback-measure coverage when selection_info is omitted (T4)', () => {
  it('resolveLuminance falls back to a separate measure() when the merged snippet result omits selection_info', async () => {
    const conn = makeConnection({
      resultFor: (script: string) => {
        if (script.includes('"__snippet":"selectLuminanceRange"')) {
          // Simulates a router/snippet variant that does NOT embed
          // selection_info in its own result — the `?? (await
          // measure(connection))` fallback must fire instead of silently
          // scoring `undefined`.
          return { ok: true };
        }
        if (script.includes('return getSelectionInfo()')) {
          return { has_selection: true, area_percent: 30, bounds_fill_ratio: 0.5 };
        }
        return { ok: true };
      },
    });
    const sc = makeSnippetClient();
    const res = await resolveSelection(conn.asConnection(), sc, baseModel(), 'shadows');
    // 2 trips: the derive (no embedded info) + the fallback measure — proving
    // the `??` fallback actually fired, not that the merged shape was
    // silently assumed.
    expect(conn.executions.length).toBe(2);
    // The score was still computed from the fallback measurement, not skipped.
    expect(typeof res.confidence).toBe('number');
    expect(res.reasons.length).toBeGreaterThan(0);
  });

  // The other three `?? (await measure(connection))` fallback sites
  // (resolveSkin, resolveFace, resolveAboveHorizon) share the exact same
  // shape as resolveLuminance's, pinned above — a snippet result whose own
  // `selection_info` is absent falls back to a separate getSelectionInfo()
  // measure call. Not independently re-tested here.
});

describe('select-recipes — resolveGround measureAndScore fallback (T5)', () => {
  it('sky pre-check PASSES with ZERO subjects -> falls back to an explicit measureAndScore (the invertSelection merge is deferred, not a real shape gap)', async () => {
    const conn = makeConnection({
      resultFor: (script: string) => {
        if (script.includes('return getSelectionInfo()')) {
          // A clean, generously top-anchored region — the same hand-verified
          // shape the "ground reaches invert+subtract" pass-path test above
          // uses for its sky pre-check.
          return {
            has_selection: true,
            bounds: { left: 0, top: 0, right: 1000, bottom: 80 },
            area_percent: 10,
            bounds_fill_ratio: 0.9,
            edge_complexity: 0.02,
          };
        }
        return { ok: true };
      },
    });
    const sc = makeSnippetClient();
    const model = baseModel(); // no subjects — nothing to subtract
    const res = await resolveSelection(conn.asConnection(), sc, model, 'ground');
    expect(res.method).toBe('invert_sky_minus_subjects');
    expect(res.detail.subjects_subtracted).toBe(0);
    // Only invertSelection was built — no subtract snippets fire with no subjects.
    expect(sc.allBuilds().map((b) => b.name)).toEqual(['invertSelection']);
    // 1 merged sky pre-check + 1 invert + 1 explicit fallback measure = 3. The
    // test router doesn't simulate invertSelection's own embedded
    // selection_info (see the comment on this branch in select-recipes.ts), so
    // the merge is deferred to measureAndScore here — this trip count is the proof.
    expect(conn.executions.length).toBe(3);
    expect(typeof res.confidence).toBe('number');
  });
});
