import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  precomputeRegions,
  loadPrecomputedRegion,
  __resetPrecompute,
  CHANNEL_PREFIX,
} from '@editmamei/perception/region-precompute.ts';
import type { SceneModel } from '@editmamei/perception/scene-model.ts';
import { Logger } from '@editmamei/utils/logger.ts';
import { makeConnection, FakePhotoshopConnection } from '../fixtures/fake-connection.ts';
import { makeSnippetClient, FakeSnippetClient } from '../fixtures/fake-snippet-client.ts';

// precomputeRegions orchestrates 7 targets through select-recipes.ts's
// resolveSelection, one script-count-reducing merge each (see
// select-recipes.test.ts) — these tests cover the ORCHESTRATION-level
// behavior the merge must preserve exactly: per-target error isolation, the
// `scene:<target>` channel-naming convention, deselect-on-exit, and the new
// debug-level trip-count log line (task item 5) — plus the pass-level total
// script count, which is the headline number this change is FOR.
//
// Trip-count derivation (all-fail path, matches the debug log line in
// region-precompute.ts): 7 CE targets ≈ 21 scripts before the 2026-07-29
// derive+measure merge (roughly 3/target: derive + measure + deselect) → 15
// after. Production pass-paths differ (a passing gate skips the deselect a
// failing one incurs, `ground`/`sky` have their own multi-step shapes, etc.)
// — 21→15 is specifically the deterministic all-gates-fail case these tests
// pin.

const EMPTY_INFO = { has_selection: false };

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

/** Every derive script's own measurement reports an empty selection — every
 *  target fails its gate the same way (region-scorer's shared "empty
 *  selection" early-out), independent of the per-kind formula. Deterministic
 *  and boundary-free — see select-recipes.test.ts for why this is the safe
 *  way to pin trip counts without coupling to the scorer's tuning. */
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

describe('precomputeRegions — orchestration + trip-count accounting', () => {
  let conn: FakePhotoshopConnection;
  let sc: FakeSnippetClient;

  beforeEach(() => {
    __resetPrecompute();
    conn = makeConnection({ resultFor: failEverythingRouter });
    sc = makeSnippetClient();
  });

  it('a full 7-target pass (nothing detected, everything fails its gate) issues 14 scripts — down from the historical ~3/target (~21)', async () => {
    // 14, not 15: with no person and no face in the model, `skin` now short-circuits
    // to honest absence WITHOUT running its colour-range script (2026-08-01) —
    // skin-tone colour alone can't tell skin from any warm subject.
    const menu = await precomputeRegions(conn.asConnection(), sc, baseModel());
    expect(menu).toEqual([]);
    // delete(1) + sky(5) + ground(2) + shadows(2) + highlights(2) + skin(1, short-circuits with no person/face) +
    // subject(0, honest absence — no subjects to try) + face(0, same) +
    // final deselect(1) = 15. See select-recipes.test.ts for the per-target
    // derivation of each of these numbers.
    expect(conn.executions.length).toBe(14);
  });

  it('per-target isolation survives the merge — one throwing method does not empty the menu', async () => {
    const throwingSc = makeSnippetClient();
    const originalBuild = throwingSc.build.bind(throwingSc);
    throwingSc.build = async (name: string, params?: Record<string, unknown>) => {
      if (name === 'selectColorPreset') throw new Error('unavailable in this PS');
      return originalBuild(name, params);
    };
    // Make shadows/highlights pass so the menu isn't just empty for unrelated
    // reasons; skin is the one target wired to throw (at snippet.build(), before
    // any script even reaches the connection — same as the pre-merge behavior).
    const passingConn = makeConnection({
      resultFor: (script: string) => {
        if (
          script.includes('"__snippet":"selectLuminanceRange"') ||
          script.includes('"__snippet":"selectRectangle"') ||
          script.includes('"__snippet":"selectEllipse"')
        ) {
          return {
            selection_info: { has_selection: true, area_percent: 30, bounds_fill_ratio: 0.5 },
          };
        }
        return failEverythingRouter(script);
      },
    });
    const model = baseModel({
      subjects: [
        { id: 's1', label: 'dog', bbox: [100, 100, 300, 300], confidence: 0.9, is_main: true },
      ],
      faces: [{ bbox: [40, 40, 120, 140], confidence: 0.9, is_primary: true }],
    });
    const menu = await precomputeRegions(passingConn.asConnection(), throwingSc, model);
    const targets = menu.map((m) => m.target);
    expect(targets).toEqual(expect.arrayContaining(['shadows', 'highlights']));
    expect(targets).not.toContain('skin'); // the throwing target is skipped, not fatal
  });

  it('channel naming is unchanged: a passing target saves scene:<target> (CHANNEL_PREFIX + target)', async () => {
    const passingConn = makeConnection({
      resultFor: (script: string) => {
        if (script.includes('"__snippet":"selectLuminanceRange"')) {
          return { selection_info: { has_selection: true, area_percent: 30 } };
        }
        return failEverythingRouter(script);
      },
    });
    const menu = await precomputeRegions(passingConn.asConnection(), sc, baseModel());
    const shadows = menu.find((m) => m.target === 'shadows');
    expect(shadows?.key).toBe(`${CHANNEL_PREFIX}shadows`);
    expect(shadows?.key).toBe('scene:shadows');
    expect(
      passingConn
        .allScripts()
        .some((s) => s.includes('scene:shadows') && s.includes('doc.channels.add()'))
    ).toBe(true);
  });

  it('the working selection is deselected on exit — the LAST script of the pass is the deselect build', async () => {
    await precomputeRegions(conn.asConnection(), sc, baseModel());
    const scripts = conn.allScripts();
    expect(scripts[scripts.length - 1]).toContain('"__snippet":"deselect"');
  });

  it('logs a debug-level trip-count summary line after the pass', async () => {
    const debugSpy = vi.spyOn(Logger.prototype, 'debug');
    await precomputeRegions(conn.asConnection(), sc, baseModel());
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining('precompute: 7 targets, 14 scripts')
    );
    debugSpy.mockRestore();
  });

  it('a cache-hit repeat read reuses the menu — zero additional scripts, no additional debug log', async () => {
    const model = baseModel();
    await precomputeRegions(conn.asConnection(), sc, model);
    const firstCount = conn.executions.length;
    const debugSpy = vi.spyOn(Logger.prototype, 'debug');
    const menu2 = await precomputeRegions(conn.asConnection(), sc, model);
    expect(conn.executions.length).toBe(firstCount); // no new PS trips
    expect(debugSpy).not.toHaveBeenCalled(); // cache-hit returns before the tally/log
    expect(menu2).toEqual([]);
    debugSpy.mockRestore();
  });

  it('loadPrecomputedRegion still loads a saved channel purely by name (fast path unaffected by the merge)', async () => {
    const loadConn = makeConnection({
      resultFor: (s: string) =>
        s.includes('doc.selection.load(ch')
          ? { loaded: true, width: 1000, height: 800 }
          : { ok: true },
    });
    const loaded = await loadPrecomputedRegion(loadConn.asConnection(), 'sky');
    // selection_info rides along from the SAME round trip; null here because
    // this fake returns no measurement (a real PS run supplies one).
    expect(loaded).toEqual({ width: 1000, height: 800, selection_info: null });
    expect(loadConn.allScripts().some((s) => s.includes(`${CHANNEL_PREFIX}sky`))).toBe(true);
  });

  it('loadPrecomputedRegion measures the selection in the same round trip', async () => {
    const info = { has_selection: true, bounds: { left: 1, top: 2, right: 3, bottom: 4 } };
    const loadConn = makeConnection({
      resultFor: (s: string) =>
        s.includes('doc.selection.load(ch')
          ? { loaded: true, width: 1000, height: 800, selection_info: info }
          : { ok: true },
    });
    const loaded = await loadPrecomputedRegion(loadConn.asConnection(), 'sky');
    expect(loaded?.selection_info).toEqual(info);
    // The whole point of the fast path: ONE script, not a load plus a measure.
    expect(loadConn.executions.length).toBe(1);
    expect(loadConn.lastScript()).toContain('getSelectionInfo()');
  });

  it('emits the restoreCompositeChannel definition exactly once', async () => {
    // getSelectionInfo's source already opens with the restoreCompositeChannel
    // definition, so interpolating that constant separately shipped a second
    // byte-identical copy of the function body in every load script — legal but
    // pure waste across the COM/AppleScript boundary on every select_by_reference.
    const loadConn = makeConnection({
      resultFor: (s: string) =>
        s.includes('doc.selection.load(ch') ? { loaded: true } : { ok: true },
    });
    await loadPrecomputedRegion(loadConn.asConnection(), 'sky');
    const script = loadConn.lastScript();
    const defs = script.match(/function restoreCompositeChannel\s*\(/g) ?? [];
    expect(defs).toHaveLength(1);

    // The CALL must survive — dropping it leaves the document on a
    // non-composite channel and the next doc.histogram read throws
    // "You can only get a histogram for visible channels".
    //
    // Scope this to the window BETWEEN the channel load and the return. A bare
    // toContain would pass vacuously: getSelectionInfo's own finally block
    // contains the literal `restoreCompositeChannel(doc);`, and it is now
    // interpolated at the top, so the string is present even if the standalone
    // call after the load is deleted. Verified by deleting that call — the
    // sliced assertion fails, a bare toContain does not.
    const loadAt = script.indexOf('doc.selection.load(ch');
    const returnAt = script.indexOf('return {\n      loaded: true');
    expect(loadAt).toBeGreaterThan(-1);
    expect(returnAt).toBeGreaterThan(loadAt);
    expect(script.slice(loadAt, returnAt)).toContain('restoreCompositeChannel(doc);');

    // The definition must precede the call textually, so correctness never
    // rests on hoisting across an interpolation boundary.
    expect(script.indexOf('function restoreCompositeChannel')).toBeLessThan(loadAt);
  });
});

/**
 * Menu-reuse gate — existence check (2026-07-30 pixel-identity redesign). The
 * `lastPrecomputedKey === model.provenance.cache_key` match alone is no longer
 * sufficient to trust `cachedMenu`: the `scene:*` channels it names live IN THE
 * DOCUMENT, which can go stale independently of this process's memory (deleted
 * by hand, or the document reopened onto pixel-identical content with a fresh
 * document object that never had these channels). One cheap existence-check PS
 * round trip (`channelsExist`, matched below via the `__mcp_scene_chk__` marker)
 * confirms before the cached menu is trusted.
 */
describe('precomputeRegions — menu-reuse existence check', () => {
  let conn: FakePhotoshopConnection;
  let sc: FakeSnippetClient;

  beforeEach(() => {
    __resetPrecompute();
    sc = makeSnippetClient();
  });

  /** shadows passes its gate (non-empty cachedMenu), everything else fails. */
  function passingRouter(script: string): unknown {
    if (script.includes('"__snippet":"selectLuminanceRange"')) {
      return { selection_info: { has_selection: true, area_percent: 30 } };
    }
    return failEverythingRouter(script);
  }

  it('a repeat read with a NON-EMPTY cached menu issues exactly one existence-check round trip, then reuses the menu', async () => {
    conn = makeConnection({
      resultFor: (script: string) => {
        if (script.includes('__mcp_scene_chk__')) return { all_present: true };
        return passingRouter(script);
      },
    });
    const model = baseModel();
    const menu1 = await precomputeRegions(conn.asConnection(), sc, model);
    expect(menu1.map((m) => m.target)).toContain('shadows');
    const firstCount = conn.executions.length;

    const menu2 = await precomputeRegions(conn.asConnection(), sc, model);
    expect(menu2).toEqual(menu1);
    expect(conn.executions.length).toBe(firstCount + 1); // one existence-check trip
    const last = conn.allScripts()[conn.allScripts().length - 1];
    expect(last).toContain('__mcp_scene_chk__');
    expect(last).toContain('scene:shadows');
  });

  it('an EMPTY cached menu (nothing passed) reuses with ZERO round trips — nothing to verify', async () => {
    conn = makeConnection({ resultFor: failEverythingRouter });
    const model = baseModel();
    await precomputeRegions(conn.asConnection(), sc, model);
    const firstCount = conn.executions.length;
    const menu2 = await precomputeRegions(conn.asConnection(), sc, model);
    expect(menu2).toEqual([]);
    expect(conn.executions.length).toBe(firstCount); // no existence-check trip issued
  });

  it('a missing channel forces a full precompute rebuild even though cache_key still matches', async () => {
    conn = makeConnection({
      resultFor: (script: string) => {
        if (script.includes('__mcp_scene_chk__')) return { all_present: false }; // channel gone
        return passingRouter(script);
      },
    });
    const model = baseModel();
    const menu1 = await precomputeRegions(conn.asConnection(), sc, model);
    const firstCount = conn.executions.length;

    const debugSpy = vi.spyOn(Logger.prototype, 'debug');
    const menu2 = await precomputeRegions(conn.asConnection(), sc, model);
    expect(menu2).toEqual(menu1); // rebuilt fresh, lands on the same passing target
    // Full rebuild (delete + sky + ground + shadows + highlights + skin + subject +
    // face + final deselect), not the 1-trip existence check.
    expect(conn.executions.length).toBeGreaterThan(firstCount + 1);
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('precompute:'));
    debugSpy.mockRestore();
  });

  it('a channelsExist round trip that THROWS still yields a full precompute rebuild, not an empty menu (2c)', async () => {
    conn = makeConnection({
      resultFor: (script: string) => {
        if (script.includes('__mcp_scene_chk__')) throw new Error('transient PS error');
        return passingRouter(script);
      },
    });
    const model = baseModel();
    const menu1 = await precomputeRegions(conn.asConnection(), sc, model);
    expect(menu1.map((m) => m.target)).toContain('shadows');
    const firstCount = conn.executions.length;

    const menu2 = await precomputeRegions(conn.asConnection(), sc, model);
    expect(menu2).toEqual(menu1); // rebuilt fresh, lands on the same passing target
    // A full rebuild ran (not just the 1-trip existence check) — precomputeRegions
    // itself never rejected out to the caller.
    expect(conn.executions.length).toBeGreaterThan(firstCount + 1);
  });

  it('detection is untouched by the existence check — it is purely a region-precompute concern (no client involved here)', async () => {
    // precomputeRegions never takes a DetectionClient — this test documents that
    // the "channel-missing forces a precompute rebuild but detection still
    // reuses" behavior (see tests/perception/scene-model.test.ts for the
    // detection-reuse half) falls out of the two caches being fully independent:
    // this module never re-derives the SceneModel it's handed, it only decides
    // whether to trust/rebuild the scene:* channel menu.
    conn = makeConnection({
      resultFor: (script: string) => {
        if (script.includes('__mcp_scene_chk__')) return { all_present: false };
        return passingRouter(script);
      },
    });
    const model = baseModel();
    await precomputeRegions(conn.asConnection(), sc, model);
    const menu2 = await precomputeRegions(conn.asConnection(), sc, model);
    // The SAME model object (same cache_key) was reused for both calls — no new
    // model / detection pass was needed for region-precompute to notice the
    // channel went missing and rebuild.
    expect(menu2.map((m) => m.target)).toContain('shadows');
  });
});
