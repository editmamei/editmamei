import { describe, it, expect, beforeEach } from 'vitest';
import {
  createSceneTools,
  annotateScene,
  SELECTABLE_STATES,
} from '@editmamei/tools/scene-tools.ts';
import { __clearSceneCache } from '@editmamei/perception/scene-model.ts';
import { __resetPrecompute } from '@editmamei/perception/region-precompute.ts';
import { isToolAllowedInEdition } from '@editmamei/core/tool-tiers.ts';
import { makeConnection, FakePhotoshopConnection } from '../fixtures/fake-connection.ts';
import { makeSnippetClient, FakeSnippetClient } from '../fixtures/fake-snippet-client.ts';
import { assertToolShape, callTool } from '../fixtures/tool-helpers.ts';
import type {
  DetectionClient,
  DetectOptions,
  DetectionResult,
} from '@editmamei/detection/detection-client.ts';
import type { DecodedImage } from '@editmamei/detection/runtime.ts';
import type { DetectActiveDocDeps } from '@editmamei/detection/detect-active-doc.ts';

// ps_read_scene + ps_select_by_reference orchestrate the perception
// builder (detection + histogram + pure facets) and the CE recipes. The ONNX
// detect can't run in-harness, so an injected fake client supplies boxes; the
// assertions pin the dispatched scripts (cache key / detect export / histogram /
// the inline region-select glue / the proven selection snippets).

// Export 500×400 → doc 1000×800 (mapDetectionToDoc scales boxes ×2). context
// carries a document.name so docKeyFrom (scene-model.ts) can compute a real
// (non-null) docKey — without it every pixel-identity build in this file
// would degrade to "no verifiable identity" and never HIT (1c: a null docKey
// is intentionally always-miss, even against itself).
const EXPORT_RESULT = {
  ok: true,
  doc_width: 1000,
  doc_height: 800,
  context: { hasDocument: true, document: { name: 'test.psd' } },
};

const OBJECTS: DetectionResult = {
  image: { width: 500, height: 400 },
  backends: { objects: 'dfine-s', faces: 'ultraface' },
  objects: [
    { label: 'dog', class_id: 16, bbox: [100, 100, 300, 300], confidence: 0.95 }, // doc [200,200,600,600]
    { label: 'person', class_id: 0, bbox: [10, 10, 60, 200], confidence: 0.9 }, // doc [20,20,120,400]
  ],
  faces: [{ bbox: [20, 20, 60, 70], confidence: 0.99 }], // doc [40,40,120,140]
};

class FakeDetectionClient implements DetectionClient {
  /** Counts calls — used by the pixel-identity warm-cache tests below to prove a
   *  HIT skips the ONNX call entirely. */
  calls = 0;
  async detect(_imagePath: string, opts: DetectOptions): Promise<DetectionResult> {
    this.calls++;
    const r: DetectionResult = { image: OBJECTS.image, backends: {} };
    if (opts.objects) {
      r.objects = OBJECTS.objects;
      r.backends.objects = 'dfine-s';
    }
    if (opts.faces) {
      r.faces = OBJECTS.faces;
      r.backends.faces = 'ultraface';
    }
    return r;
  }
}

// Fake readFile/decode for detectActiveDoc, injected as ps_read_scene /
// ps_select_by_reference's test-only `detectDeps` seam — WITHOUT this, `decoded`
// stays undefined under the fake connection (no real PS export ever lands on
// disk), so the pixel-identity cache can never verify sameness and honestly
// always misses. Every OTHER test in this file relies on that honest-miss
// default; only the warm-cache tests below inject real (fake) pixels.
const FAKE_DECODED: DecodedImage = {
  width: 8,
  height: 8,
  data: new Uint8Array(8 * 8 * 4).fill(60),
};
function fakeDetectDeps(decoded: DecodedImage = FAKE_DECODED): DetectActiveDocDeps {
  return { readFile: async () => Buffer.from('fake-export-bytes'), decode: () => decoded };
}

// A bimodal histogram so the Otsu pick lands between the modes and the row
// profile (absent here) falls back gracefully.
const HISTOGRAM = {
  channel: 'luminosity',
  bins: (() => {
    const b = new Array(256).fill(0);
    b[40] = 5000; // ground
    b[210] = 5000; // sky
    return b;
  })(),
  bin_count: 256,
  total_pixels: 10000,
  mean: 125,
  stdev: 80,
  median: 125,
};

function routeScripts(script: string): unknown {
  // detectActiveDoc export — ALWAYS runs now (it doubles as the pixel-identity
  // freshness probe; see scene-model.ts's module doc comment).
  if (script.includes('__mcp_detect__')) return EXPORT_RESULT;
  // getHistogram via FakeSnippetClient (embeds the snippet name).
  if (script.includes('"__snippet":"getHistogram"')) return HISTOGRAM;
  // region-precompute's menu-reuse existence check — default to "still there" so
  // a repeat ps_read_scene with a non-empty menu doesn't spuriously force a full
  // rebuild in tests that don't care about this gate specifically.
  if (script.includes('__mcp_scene_chk__')) return { all_present: true };
  // The uniform measure step (getSelectionInfo) — v2 reads the candidate's
  // selection_info after each method and scores it. Return a clean upper-band
  // region so `sky` clears the gate (and ground's sky pre-check passes).
  if (script.includes('return getSelectionInfo()')) {
    return {
      has_selection: true,
      bounds: { left: 0, top: 0, right: 1000, bottom: 200 },
      area_percent: 25,
      bounds_fill_ratio: 0.8,
      edge_complexity: 0.05,
    };
  }
  // Inline region-select glue (threshold/posterize → wand → delete) — its own
  // return is ignored by v2 (the measure step reads the real selection).
  if (script.includes('__mcp_scene_thr__') || script.includes('__mcp_scene_pst__')) {
    return { ok: true };
  }
  // v2.1 precompute: loading a saved scene:* channel by name. Default = no such
  // channel (so an on-demand select derives); the fast-load tests override this.
  if (script.includes('doc.selection.load(ch')) return { loaded: false };
  // Proven selection snippets return a selection_info bundle.
  if (
    script.includes('"__snippet":"selectLuminanceRange"') ||
    script.includes('"__snippet":"selectColorPreset"') ||
    script.includes('"__snippet":"selectRectangle"') ||
    script.includes('"__snippet":"selectEllipse"')
  ) {
    return { selection_info: { has_selection: true, area_percent: 12 } };
  }
  return { ok: true };
}

const snippetNames = (sc: FakeSnippetClient) => sc.allBuilds().map((b) => b.name);

/** A snippet client whose build() throws for the named snippets (simulates a
 * Sensei / colour-range op unavailable in this PS edition). */
function makeThrowingSnippetClient(throwNames: string[]): FakeSnippetClient {
  const base = makeSnippetClient();
  const orig = base.build.bind(base);
  base.build = async (name: string, params?: Record<string, unknown>) => {
    if (throwNames.includes(name)) throw new Error(`${name} unavailable`);
    return orig(name, params);
  };
  return base;
}

describe('createSceneTools', () => {
  let conn: FakePhotoshopConnection;
  let sc: FakeSnippetClient;
  beforeEach(() => {
    __clearSceneCache();
    __resetPrecompute();
    conn = makeConnection({ resultFor: routeScripts });
    sc = makeSnippetClient();
  });
  const tools = () =>
    createSceneTools(conn.asConnection(), sc, { client: new FakeDetectionClient() });

  it('returns two well-formed tools with the expected names', () => {
    const t = tools();
    assertToolShape(t);
    expect(t.map((x) => x.tool.name)).toEqual(['ps_read_scene', 'ps_select_by_reference']);
  });

  it('ps_select_by_reference requires target', () => {
    const t = tools();
    const schema = t[1].tool.inputSchema as unknown as { required: string[] };
    expect(schema.required).toContain('target');
  });

  // ---------- ps_read_scene ----------

  it('scene builds a structured model with subjects, faces, horizon, tonal zones, composition', async () => {
    const res = await callTool(tools(), 'ps_read_scene', { annotate: false });
    expect(res.isError).toBeUndefined();
    const m = res.structuredContent as Record<string, unknown>;
    expect((m.doc as { width: number }).width).toBe(1000);
    expect((m.subjects as unknown[]).length).toBe(2);
    expect((m.faces as unknown[]).length).toBe(1);
    expect(m.horizon).toBeDefined();
    expect(m.tonal_zones).toBeDefined();
    expect(m.composition).toBeDefined();
    // The largest object (dog, area 400×400) is the main subject.
    const subjects = m.subjects as Array<{ label: string; is_main: boolean }>;
    expect(subjects.find((s) => s.is_main)?.label).toBe('dog');
    // The single face is primary.
    const faces = m.faces as Array<{ is_primary: boolean }>;
    expect(faces[0].is_primary).toBe(true);
  });

  it('scene reads the histogram on the luminosity channel', async () => {
    await callTool(tools(), 'ps_read_scene', { annotate: false });
    const hist = sc.allBuilds().find((b) => b.name === 'getHistogram');
    expect(hist?.params).toMatchObject({ channel: 'luminosity' });
  });

  it('without decodable export pixels, the pixel-identity cache honestly never hits — every read re-exports AND re-detects', async () => {
    // This fixture (like every other test in this file bar the two below) never
    // injects detectDeps, so `decoded` stays undefined (no real PS export lands
    // on disk under the fake connection) — the cache can't verify pixel sameness
    // and fails open to a miss every time. The export+decode round trip itself
    // ALWAYS runs regardless (it's the freshness probe), so __mcp_detect__ scales
    // with call count now — it no longer stands in for "detection re-ran".
    const t = tools();
    await callTool(t, 'ps_read_scene', { annotate: false });
    const detectScripts1 = conn.allScripts().filter((s) => s.includes('__mcp_detect__')).length;
    const res = await callTool(t, 'ps_read_scene', { annotate: false });
    const detectScripts2 = conn.allScripts().filter((s) => s.includes('__mcp_detect__')).length;
    expect(detectScripts1).toBe(1);
    expect(detectScripts2).toBe(2);
    expect((res.structuredContent as { provenance: { cached: boolean } }).provenance.cached).toBe(
      false
    );
  });

  it('with decodable export pixels unchanged, a repeat ps_read_scene HITS the pixel-identity cache — detection not re-run', async () => {
    const detectionClient = new FakeDetectionClient();
    const t = createSceneTools(conn.asConnection(), sc, {
      client: detectionClient,
      detectDeps: fakeDetectDeps(),
    });
    await callTool(t, 'ps_read_scene', { annotate: false });
    expect(detectionClient.calls).toBe(1);

    const res = await callTool(t, 'ps_read_scene', { annotate: false });
    expect(detectionClient.calls).toBe(1); // the second read reused detection — no second ONNX call
    expect((res.structuredContent as { provenance: { cached: boolean } }).provenance.cached).toBe(
      true
    );
    // The export+decode freshness probe itself still ran on both calls.
    const detectScripts = conn.allScripts().filter((s) => s.includes('__mcp_detect__')).length;
    expect(detectScripts).toBe(2);
  });

  it('scene refresh:true forces a fresh detection pass', async () => {
    const t = tools();
    await callTool(t, 'ps_read_scene', { annotate: false });
    await callTool(t, 'ps_read_scene', { annotate: false, refresh: true });
    const detectScripts = conn.allScripts().filter((s) => s.includes('__mcp_detect__')).length;
    expect(detectScripts).toBe(2);
  });

  // ---------- v2.1 oversight loop: precompute + saved channels + fast load ----------

  it('save_regions:true precomputes the confident region MENU (saved as scene:* channels)', async () => {
    const res = await callTool(tools(), 'ps_read_scene', {
      annotate: false,
      save_regions: true,
    });
    const menu = (
      res.structuredContent as {
        region_menu: Array<{ target: string; confidence: number; key: string }>;
      }
    ).region_menu;
    expect(Array.isArray(menu)).toBe(true);
    const targets = menu.map((m) => m.target);
    // sky/skin/subject clear the gate on the fixed measure fixture; ground does not.
    expect(targets).toEqual(expect.arrayContaining(['sky', 'skin', 'subject']));
    expect(menu.find((m) => m.target === 'sky')?.key).toBe('scene:sky');
    expect(menu.every((m) => m.confidence > 0)).toBe(true);
    // The stale-cleanup + a save channel ran.
    expect(conn.allScripts().some((s) => s.includes('doc.channels.add()'))).toBe(true);
    // Regression guard (2026-06-23, live PS 27.2): every channel script that adds
    // a channel MUST also *call* restoreCompositeChannel(doc), not merely
    // interpolate its definition — otherwise the doc is left on a non-composite
    // channel and the next doc.histogram read throws "histogram for visible
    // channels", breaking buildSceneModel on the following select_by_reference.
    for (const s of conn.allScripts()) {
      if (s.includes('doc.channels.add()')) {
        expect(s).toContain('restoreCompositeChannel(doc);');
      }
    }
  });

  // The DEFAULT since 2026-08-24. The eager pass cost ~21s of derive against a
  // 30s script timeout, so a plain scene read now advertises the menu and
  // derives nothing — ps_select_by_reference resolves whichever region is
  // actually asked for. Pinning "no channel work at all" is the load-bearing
  // half: that is what makes the read fast.
  it('by DEFAULT the read advertises an on_demand menu and derives nothing', async () => {
    const res = await callTool(tools(), 'ps_read_scene', { annotate: false });
    const menu = (
      res.structuredContent as {
        region_menu: Array<{ target: string; on_demand?: boolean; confidence?: number }>;
      }
    ).region_menu;
    expect(menu.length).toBeGreaterThan(0);
    expect(menu.every((m) => m.on_demand === true)).toBe(true);
    // No confidence: nothing was derived, so there is no score to report and a
    // fabricated one would assert a verdict we never earned.
    expect(menu.every((m) => m.confidence === undefined)).toBe(true);
    // The whole point — zero channel round trips.
    expect(conn.allScripts().some((s) => s.includes('doc.channels.add()'))).toBe(false);
  });

  it('the advertised menu gates face/subject/skin on DETECTED presence, not the coarse histogram', async () => {
    const res = await callTool(tools(), 'ps_read_scene', { annotate: false });
    const targets = (
      res.structuredContent as { region_menu: Array<{ target: string }> }
    ).region_menu.map((m) => m.target);
    // Luminance/geometry targets are always candidates — the coarse coverage
    // estimate is unreliable in BOTH directions, so gating on it would hide
    // regions that are genuinely selectable.
    expect(targets).toEqual(expect.arrayContaining(['sky', 'ground', 'shadows', 'highlights']));
    // The fixture detects a person, so skin and subject are honestly advertised.
    expect(targets).toEqual(expect.arrayContaining(['skin', 'subject']));
  });

  it('save_regions:false also derives nothing (explicit form of the default)', async () => {
    const res = await callTool(tools(), 'ps_read_scene', {
      annotate: false,
      save_regions: false,
    });
    const menu = (res.structuredContent as { region_menu: unknown[] }).region_menu;
    expect(menu.length).toBeGreaterThan(0);
    expect(conn.allScripts().some((s) => s.includes('doc.channels.add()'))).toBe(false);
  });

  it('sky resolve tries Sensei select_sky as a gated candidate (best-of)', async () => {
    await callTool(tools(), 'ps_select_by_reference', { target: 'sky' });
    expect(snippetNames(sc)).toContain('selectSky');
  });

  it('select_by_reference loads the saved channel BY NAME — no perception rebuild', async () => {
    // A scene:sky channel exists (load returns loaded:true). The select must load
    // it by name WITHOUT building the scene model (no export/detection round trip).
    const connFast = makeConnection({
      resultFor: (s: string) =>
        s.includes('doc.selection.load(ch')
          ? { loaded: true, width: 1000, height: 1000 }
          : routeScripts(s),
    });
    const t = createSceneTools(connFast.asConnection(), makeSnippetClient(), {
      client: new FakeDetectionClient(),
    });
    const res = await callTool(t, 'ps_select_by_reference', { target: 'sky' });
    const out = res.structuredContent as { method: string; passed: boolean };
    expect(out.method).toBe('precomputed_channel');
    expect(out.passed).toBe(true);
    // Truly fast: it skipped the perception build entirely (no detection export).
    expect(connFast.allScripts().some((s) => s.includes('__mcp_detect__'))).toBe(false);
  });

  it('fast-load is history-INDEPENDENT — loads by name regardless of doc-state (no stale guard)', async () => {
    // Even at a wildly-different history-state, an existing scene:* channel loads.
    const conn2 = makeConnection({
      resultFor: (s: string) => {
        if (s.includes('doc.selection.load(ch')) return { loaded: true, width: 1000, height: 1000 };
        if (s.includes('doc.historyStates.length')) return { doc_id: 7, history_states: 99 };
        return routeScripts(s);
      },
    });
    const t2 = createSceneTools(conn2.asConnection(), makeSnippetClient(), {
      client: new FakeDetectionClient(),
    });
    const res = await callTool(t2, 'ps_select_by_reference', { target: 'sky' });
    expect((res.structuredContent as { method: string }).method).toBe('precomputed_channel');
  });

  it('sky degrades to CE threshold when Sensei select_sky is unavailable (throws)', async () => {
    const t = createSceneTools(conn.asConnection(), makeThrowingSnippetClient(['selectSky']), {
      client: new FakeDetectionClient(),
    });
    const res = await callTool(t, 'ps_select_by_reference', { target: 'sky' });
    const out = res.structuredContent as { method: string; passed: boolean };
    expect(out.method).toBe('threshold_white'); // Sensei skipped → CE wins
    expect(out.passed).toBe(true);
  });

  it('precompute isolates a failing method — one target throwing does not empty the menu', async () => {
    // skin uses selectColorPreset; make it unavailable → skin is skipped, rest builds.
    const t = createSceneTools(
      conn.asConnection(),
      makeThrowingSnippetClient(['selectColorPreset']),
      {
        client: new FakeDetectionClient(),
      }
    );
    const res = await callTool(t, 'ps_read_scene', { annotate: false, save_regions: true });
    const menu = (res.structuredContent as { region_menu: Array<{ target: string }> }).region_menu;
    const targets = menu.map((m) => m.target);
    expect(targets).toEqual(expect.arrayContaining(['sky', 'subject'])); // still built
    expect(targets).not.toContain('skin'); // the failing target skipped, menu not emptied
  });

  // ---------- ps_select_by_reference: recipe routing ----------

  // The other half of the lazy default. If an on-demand derive did not persist
  // its channel, every select of that region would re-derive (1-9s live) and the
  // one-time precompute cost would become a permanent per-call one. Before
  // 2026-08-24 this persist was gated to `face_*` only.
  // `ch.name = "scene:<target>"` is unique to the SAVE script — the derive
  // recipes also add scratch channels and mention the target, so a looser match
  // passes against the wrong script.
  const savedChannel = (scripts: string[], target: string): string | undefined =>
    scripts.find((s) => s.includes(`ch.name = "scene:${target}"`));

  it('an on-demand CE derive PERSISTS its scene:* channel so repeats load by name', async () => {
    await callTool(tools(), 'ps_select_by_reference', { target: 'sky' });
    const saved = savedChannel(conn.allScripts(), 'sky');
    expect(saved).toBeDefined();
    expect(saved).toContain('doc.selection.store(ch, SelectionType.REPLACE);');
    // Same live regression guard as the precompute path — adding a channel hides
    // the RGB composite, and leaving it hidden breaks the next histogram read.
    expect(saved).toContain('restoreCompositeChannel(doc);');
  });

  it('a REJECTED derive persists nothing — an unconfident region must not be cached as a channel', async () => {
    // No giraffe in this scene, so subject is honest absence rather than an
    // error. Caching that as a channel would make the next select load an empty
    // selection by name and never re-derive.
    const res = await callTool(tools(), 'ps_select_by_reference', {
      target: 'subject',
      label: 'giraffe',
    });
    expect((res.structuredContent as { passed: boolean }).passed).toBe(false);
    expect(savedChannel(conn.allScripts(), 'subject')).toBeUndefined();
  });

  // A `scene:<target>` channel is keyed by target ALONE, so it cannot express
  // "which subject". Persisting a labelled derive under the shared key poisons
  // the next un-narrowed call: it would load the dog by name and report it as
  // the main subject with confidence 1. Both directions are silent, which is
  // what makes it dangerous.
  it('a LABELLED derive persists nothing — the shared channel cannot express which subject', async () => {
    const res = await callTool(tools(), 'ps_select_by_reference', {
      target: 'subject',
      label: 'dog',
    });
    expect((res.structuredContent as { passed: boolean }).passed).toBe(true);
    expect(savedChannel(conn.allScripts(), 'subject')).toBeUndefined();
  });

  // The `passed` assertion is the anti-vacuity guard, not decoration: a REJECTED
  // derive has never persisted (pinned by the giraffe test above), so without it
  // these would pass for the pre-existing reason and say nothing about the
  // discriminated rule.
  it('an INSTANCE-narrowed derive persists nothing either', async () => {
    const res = await callTool(tools(), 'ps_select_by_reference', {
      target: 'subject',
      instance: 0,
    });
    expect((res.structuredContent as { passed: boolean }).passed).toBe(true);
    expect(savedChannel(conn.allScripts(), 'subject')).toBeUndefined();
  });

  it('a composition_context derive persists nothing — it passed under different priors', async () => {
    const res = await callTool(tools(), 'ps_select_by_reference', {
      target: 'sky',
      composition_context: { profile: 'big_sky' },
    });
    expect((res.structuredContent as { passed: boolean }).passed).toBe(true);
    expect(savedChannel(conn.allScripts(), 'sky')).toBeUndefined();
  });

  it('a narrowed call does not READ the shared channel either', async () => {
    // The mirror of the above: an un-narrowed select saved scene:subject (the
    // MAIN subject). A later label:'dog' call must not be handed that mask.
    const connLoaded = makeConnection({
      resultFor: (s: string) =>
        s.includes('doc.selection.load(ch')
          ? { loaded: true, width: 1000, height: 800 }
          : routeScripts(s),
    });
    const t = createSceneTools(connLoaded.asConnection(), sc, {
      client: new FakeDetectionClient(),
      detectDeps: fakeDetectDeps(),
    });
    const res = await callTool(t, 'ps_select_by_reference', { target: 'subject', label: 'dog' });
    const method = (res.structuredContent as { method: string }).method;
    expect(method).not.toBe('precomputed_channel');
  });

  it('sky → threshold glue, gate PASSES for a clean upper-band region', async () => {
    const res = await callTool(tools(), 'ps_select_by_reference', { target: 'sky' });
    expect(res.isError).toBeUndefined();
    const thr = conn.allScripts().find((s) => s.includes('__mcp_scene_thr__'));
    expect(thr, 'threshold glue script dispatched').toBeTruthy();
    expect(thr).toContain("cTID('Thrs')"); // a Threshold adjustment, not Posterize
    expect(thr).toContain("putUnitDouble(cTID('Hrzn')"); // seeded at a point
    const sc2 = res.structuredContent as { method: string; passed: boolean; confidence: number };
    expect(sc2.method).toBe('threshold_white');
    expect(sc2.passed).toBe(true); // upper, doesn't touch bottom, coverage under prior
  });

  it('ground → invert(confident sky) − subject boxes (content-following, not posterize)', async () => {
    const res = await callTool(tools(), 'ps_select_by_reference', { target: 'ground' });
    // The confident sky is produced (threshold), inverted, then each subject carved out.
    expect(conn.allScripts().some((s) => s.includes('__mcp_scene_thr__'))).toBe(true);
    expect(snippetNames(sc)).toContain('invertSelection');
    const subtracts = sc
      .allBuilds()
      .filter((b) => b.name === 'selectRectangle' && b.params.selectionType === 'subtract');
    expect(subtracts.length).toBe(2); // two detected subjects carved out
    expect((res.structuredContent as { method: string }).method).toBe('invert_sky_minus_subjects');
  });

  it('ground is honestly absent when there is no confident sky to invert', async () => {
    // Route the measure to a bottom-touching blob so the sky pre-check fails.
    conn = makeConnection({
      resultFor: (s: string) => {
        if (s.includes('return getSelectionInfo()')) {
          return {
            has_selection: true,
            bounds: { left: 0, top: 0, right: 1000, bottom: 800 },
            area_percent: 70,
            bounds_fill_ratio: 0.6,
            edge_complexity: 0.2,
          };
        }
        return routeScripts(s);
      },
    });
    const t = createSceneTools(conn.asConnection(), sc, { client: new FakeDetectionClient() });
    const res = await callTool(t, 'ps_select_by_reference', { target: 'ground' });
    const out = res.structuredContent as { passed: boolean; method: string };
    expect(out.passed).toBe(false);
    expect(out.method).toBe('invert_sky_minus_subjects');
    expect(snippetNames(sc)).not.toContain('invertSelection'); // never inverted a bad sky
  });

  it('shadows / highlights → luminance_range snippet', async () => {
    await callTool(tools(), 'ps_select_by_reference', { target: 'shadows' });
    expect(snippetNames(sc)).toContain('selectLuminanceRange');
    const lum = sc.allBuilds().find((b) => b.name === 'selectLuminanceRange');
    expect(lum?.params).toMatchObject({ mode: 'shadows' });
  });

  it('skin → color_range skin_tones ∩ the person box (kills background bleed)', async () => {
    const res = await callTool(tools(), 'ps_select_by_reference', { target: 'skin' });
    const preset = sc.allBuilds().find((b) => b.name === 'selectColorPreset');
    expect(preset?.params).toMatchObject({ preset: 'skin_tones', selectionType: 'replace' });
    // The person doc box [20,20,120,400] is intersected to drop the background.
    const inter = sc
      .allBuilds()
      .find((b) => b.name === 'selectRectangle' && b.params.selectionType === 'intersect');
    expect(inter?.params).toMatchObject({ left: 20, top: 20, right: 120, bottom: 400 });
    expect(
      (res.structuredContent as { detail: { intersected_with_box: boolean } }).detail
        .intersected_with_box
    ).toBe(true);
  });

  it('skin → no box to intersect when no person/face is detected (fallthrough)', async () => {
    class DogOnly implements DetectionClient {
      async detect(_p: string, opts: DetectOptions): Promise<DetectionResult> {
        const r: DetectionResult = { image: OBJECTS.image, backends: {} };
        if (opts.objects) {
          r.objects = [
            { label: 'dog', class_id: 16, bbox: [100, 100, 300, 300], confidence: 0.95 },
          ];
          r.backends.objects = 'dfine-s';
        }
        return r; // no person, no faces
      }
    }
    const t = createSceneTools(conn.asConnection(), sc, { client: new DogOnly() });
    const res = await callTool(t, 'ps_select_by_reference', { target: 'skin' });
    expect(
      sc
        .allBuilds()
        .some((b) => b.name === 'selectRectangle' && b.params.selectionType === 'intersect')
    ).toBe(false);
    expect(
      (res.structuredContent as { detail: { intersected_with_box: boolean } }).detail
        .intersected_with_box
    ).toBe(false);
  });

  it('composition_context relaxes the gate at the TOOL layer: big sky fails by default, passes with profile:big_sky', async () => {
    // Route the measure to a large (75%) but clean upper-band region.
    const bigSky = (s: string) => {
      if (s.includes('return getSelectionInfo()')) {
        return {
          has_selection: true,
          bounds: { left: 0, top: 0, right: 1000, bottom: 500 },
          area_percent: 75,
          bounds_fill_ratio: 0.9,
          edge_complexity: 0.03,
        };
      }
      return routeScripts(s);
    };
    const c = makeConnection({ resultFor: bigSky });
    const t = createSceneTools(c.asConnection(), sc, { client: new FakeDetectionClient() });
    const def = await callTool(t, 'ps_select_by_reference', { target: 'sky' });
    expect((def.structuredContent as { passed: boolean }).passed).toBe(false); // default rejects 75%
    const relaxed = await callTool(t, 'ps_select_by_reference', {
      target: 'sky',
      composition_context: { profile: 'big_sky' },
    });
    expect((relaxed.structuredContent as { passed: boolean }).passed).toBe(true); // model relaxes ⇒ confident
  });

  it('above_horizon → rectangle to the horizon y', async () => {
    const res = await callTool(tools(), 'ps_select_by_reference', {
      target: 'above_horizon',
    });
    const rect = sc.allBuilds().find((b) => b.name === 'selectRectangle');
    expect(rect).toBeTruthy();
    // The rectangle spans the full width and stops at the horizon (top=0).
    expect(rect?.params).toMatchObject({ left: 0, top: 0, right: 1000 });
    expect((res.structuredContent as { method: string }).method).toBe('rectangle_to_horizon');
  });

  it('face → the primary face box as a feathered ellipse', async () => {
    const res = await callTool(tools(), 'ps_select_by_reference', { target: 'face' });
    const ell = sc.allBuilds().find((b) => b.name === 'selectEllipse');
    expect(ell).toBeTruthy();
    // Face doc box [40,40,120,140].
    expect(ell?.params).toMatchObject({ left: 40, top: 40, right: 120, bottom: 140 });
    expect((res.structuredContent as { method: string }).method).toBe('face_box_ellipse');
  });

  it('subject (default, no Pro broker) → the main (dog) box posterize-wand at its centre', async () => {
    // The 3-arg factory has no invokeTool, so proRefine is undefined — this pins
    // the CE-only path (a regression that defaulted proRefine truthy would flip the
    // method to pro_refine and slip past the detail-only assertions below).
    const res = await callTool(tools(), 'ps_select_by_reference', { target: 'subject' });
    expect(conn.allScripts().some((s) => s.includes('__mcp_scene_pst__'))).toBe(true);
    const out = res.structuredContent as {
      method: string;
      detail: { label: string; seed: { x: number } };
    };
    expect(out.method).toBe('box_posterize_wand'); // no broker ⇒ CE fallback, not pro_refine
    expect(out.detail.label).toBe('dog');
    // dog doc box [200,200,600,600] → centre (400,400).
    expect(out.detail.seed.x).toBe(400);
  });

  it('subject with label picks that class', async () => {
    const res = await callTool(tools(), 'ps_select_by_reference', {
      target: 'subject',
      label: 'person',
    });
    const detail = (res.structuredContent as { detail: { label: string } }).detail;
    expect(detail.label).toBe('person');
  });

  it('subject with instance index picks left-to-right', async () => {
    // instance 0 = leftmost. person doc-left=20 < dog doc-left=200 → person.
    const res = await callTool(tools(), 'ps_select_by_reference', {
      target: 'subject',
      instance: 0,
    });
    const detail = (res.structuredContent as { detail: { label: string } }).detail;
    expect(detail.label).toBe('person');
  });

  it('subject with an unknown label is honestly absent (not an error)', async () => {
    const res = await callTool(tools(), 'ps_select_by_reference', {
      target: 'subject',
      label: 'giraffe',
    });
    // Honest absence, not an error — like detection not inventing a giraffe.
    expect(res.isError).toBeUndefined();
    const out = res.structuredContent as { passed: boolean; reasons: string[] };
    expect(out.passed).toBe(false);
    expect((res.content[0] as { text: string }).text).toContain('No confident');
  });

  it('an invalid target is rejected by schema validation', async () => {
    const res = await callTool(tools(), 'ps_select_by_reference', { target: 'banana' });
    expect(res.isError).toBe(true);
  });

  it('select-by-reference reuses the cached scene model — detection runs once across both tools even though each still re-exports', async () => {
    // routeScripts defaults doc.selection.load(ch → loaded:false, so
    // select-by-reference's channel fast-path misses and it falls through to its
    // own buildSceneModel call — the scenario that actually exercises the
    // pixel-identity cache across two DIFFERENT tool invocations.
    const detectionClient = new FakeDetectionClient();
    const t = createSceneTools(conn.asConnection(), sc, {
      client: detectionClient,
      detectDeps: fakeDetectDeps(),
    });
    await callTool(t, 'ps_read_scene', { annotate: false });
    await callTool(t, 'ps_select_by_reference', { target: 'sky' });
    expect(detectionClient.calls).toBe(1); // scene built it; select-by-reference's build HIT
    // The export+decode freshness probe still ran for both calls.
    const detectScripts = conn.allScripts().filter((s) => s.includes('__mcp_detect__')).length;
    expect(detectScripts).toBe(2);
  });

  it('channel-missing: precompute rebuilds even on a pixel-identity HIT — detection is still reused', async () => {
    const detectionClient = new FakeDetectionClient();
    const missingChannelConn = makeConnection({
      resultFor: (s: string) => {
        if (s.includes('__mcp_scene_chk__')) return { all_present: false }; // channels gone
        return routeScripts(s);
      },
    });
    const t = createSceneTools(missingChannelConn.asConnection(), sc, {
      client: detectionClient,
      detectDeps: fakeDetectDeps(),
    });
    await callTool(t, 'ps_read_scene', { annotate: false, save_regions: true });
    expect(detectionClient.calls).toBe(1);

    const res2 = await callTool(t, 'ps_read_scene', { annotate: false, save_regions: true });
    expect(detectionClient.calls).toBe(1); // still reused — pixel identity HIT
    expect((res2.structuredContent as { provenance: { cached: boolean } }).provenance.cached).toBe(
      true
    );
    // But the precompute pass itself fully reran: channel add/remove scripts
    // appear again on the second pass (the existence check said they were gone).
    const addCount = missingChannelConn
      .allScripts()
      .filter((s) => s.includes('doc.channels.add()')).length;
    expect(addCount).toBeGreaterThan(0);
  });

  // ---------- Pro refine seam: subject → select_subject_instance (Sensei) ----------

  /** A fake host.invokeTool that records calls; SSI-success leaves a selection,
   *  which the routeScripts measure fixture reports as a clean (passing) region. */
  function makeInvokeTool(opts: { fail?: boolean } = {}) {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const invokeTool = async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (opts.fail) throw new Error('not entitled / Sensei unavailable');
      return { content: [{ type: 'text' as const, text: 'ok' }] };
    };
    return { invokeTool, calls };
  }

  it('subject → Pro refine: routes through select_subject_instance, which="largest" for the main subject', async () => {
    const { invokeTool, calls } = makeInvokeTool();
    const t = createSceneTools(conn.asConnection(), sc, {
      client: new FakeDetectionClient(),
      invokeTool,
    });
    const res = await callTool(t, 'ps_select_by_reference', { target: 'subject' });
    const out = res.structuredContent as { method: string; passed: boolean };
    expect(out.method).toBe('pro_refine'); // Sensei mask, not the CE box-posterize-wand
    expect(out.passed).toBe(true);
    // The broker invoked the Pro tool with the main (dog) subject, which="largest".
    const ssi = calls.find((c) => c.name === 'ps_select_subject_instance');
    expect(ssi?.args).toMatchObject({ label: 'dog', which: 'largest', save_as: 'selection' });
    // The CE fallback glue must NOT have run when Pro refine succeeded.
    expect(conn.allScripts().some((s) => s.includes('__mcp_scene_pst__'))).toBe(false);
  });

  it('subject with instance index → which maps to the 0-based left-to-right index', async () => {
    const { invokeTool, calls } = makeInvokeTool();
    const t = createSceneTools(conn.asConnection(), sc, {
      client: new FakeDetectionClient(),
      invokeTool,
    });
    // instance 0 = leftmost = person (doc-left 20 < dog 200).
    await callTool(t, 'ps_select_by_reference', { target: 'subject', instance: 0 });
    const ssi = calls.find((c) => c.name === 'ps_select_subject_instance');
    expect(ssi?.args).toMatchObject({ label: 'person', which: '0' });
  });

  it('subject instance over a MIXED-label pool maps which to the LABEL-relative index', async () => {
    // The scene model indexes `instance` over the FULL pool; select_subject_instance
    // filters to `label` FIRST then re-indexes. So the chosen box's full-pool index
    // must be translated to its same-label index, or the Pro tool targets the wrong
    // instance / falls out of range.
    class ThreeSubjects implements DetectionClient {
      async detect(_p: string, opts: DetectOptions): Promise<DetectionResult> {
        const r: DetectionResult = { image: OBJECTS.image, backends: {} };
        if (opts.objects) {
          r.objects = [
            { label: 'person', class_id: 0, bbox: [10, 50, 60, 200], confidence: 0.9 }, // doc-left 20
            { label: 'dog', class_id: 16, bbox: [100, 100, 200, 300], confidence: 0.95 }, // doc-left 200
            { label: 'person', class_id: 0, bbox: [300, 50, 360, 200], confidence: 0.85 }, // doc-left 600
          ];
          r.backends.objects = 'dfine-s';
        }
        if (opts.faces) {
          r.faces = OBJECTS.faces;
          r.backends.faces = 'ultraface';
        }
        return r;
      }
    }
    const { invokeTool, calls } = makeInvokeTool();
    const t = createSceneTools(conn.asConnection(), sc, {
      client: new ThreeSubjects(),
      invokeTool,
    });
    // Full pool L→R: person(0), dog(1), person(2). instance:2 = the RIGHT person =
    // person-relative index 1 (the Pro tool only sees the two persons).
    await callTool(t, 'ps_select_by_reference', { target: 'subject', instance: 2 });
    const ssi = calls.find((c) => c.name === 'ps_select_subject_instance');
    expect(ssi?.args).toMatchObject({ label: 'person', which: '1' });
  });

  it('subject degrades to the CE box-posterize-wand when the Pro refine is unavailable (throws)', async () => {
    const { invokeTool, calls } = makeInvokeTool({ fail: true });
    const t = createSceneTools(conn.asConnection(), sc, {
      client: new FakeDetectionClient(),
      invokeTool,
    });
    const res = await callTool(t, 'ps_select_by_reference', { target: 'subject' });
    const out = res.structuredContent as { method: string };
    expect(out.method).toBe('box_posterize_wand'); // broker returned false → CE fallback
    expect(calls.some((c) => c.name === 'ps_select_subject_instance')).toBe(true); // it tried
    expect(conn.allScripts().some((s) => s.includes('__mcp_scene_pst__'))).toBe(true); // CE glue ran
  });

  it('face routes through the Pro mesh tool (select_face_feature feature=face), not subject refine', async () => {
    const { invokeTool, calls } = makeInvokeTool();
    const t = createSceneTools(conn.asConnection(), sc, {
      client: new FakeDetectionClient(),
      invokeTool,
    });
    const res = await callTool(t, 'ps_select_by_reference', { target: 'face' });
    expect((res.structuredContent as { method: string }).method).toBe('pro_refine');
    const ff = calls.find((c) => c.name === 'ps_select_face_feature');
    expect(ff?.args).toMatchObject({ feature: 'face' });
    expect(calls.some((c) => c.name === 'ps_select_subject_instance')).toBe(false);
  });

  it('a face-feature target (face_teeth) routes to the mesh tool with the stripped feature', async () => {
    const { invokeTool, calls } = makeInvokeTool();
    const t = createSceneTools(conn.asConnection(), sc, {
      client: new FakeDetectionClient(),
      invokeTool,
    });
    const res = await callTool(t, 'ps_select_by_reference', { target: 'face_teeth' });
    const out = res.structuredContent as { method: string; target: string };
    expect(out.target).toBe('face_teeth');
    expect(out.method).toBe('face_mesh');
    const ff = calls.find((c) => c.name === 'ps_select_face_feature');
    expect(ff?.args).toMatchObject({ feature: 'teeth' });
  });

  it('a face-feature target is honest absence in CE (no broker → not available)', async () => {
    // No invokeTool → no proRefine; resolveFaceFeature reports honest absence.
    const t = createSceneTools(conn.asConnection(), sc, { client: new FakeDetectionClient() });
    const res = await callTool(t, 'ps_select_by_reference', { target: 'face_eyes' });
    const out = res.structuredContent as { passed: boolean; method: string };
    expect(out.passed).toBe(false);
    expect(out.method).toBe('none');
  });

  it('precompute (ps_read_scene) saves the subject region via Pro refine when invokeTool is supplied', async () => {
    const { invokeTool, calls } = makeInvokeTool();
    const t = createSceneTools(conn.asConnection(), sc, {
      client: new FakeDetectionClient(),
      invokeTool,
    });
    const res = await callTool(t, 'ps_read_scene', { annotate: false, save_regions: true });
    const menu = (
      res.structuredContent as { region_menu: Array<{ target: string; method: string }> }
    ).region_menu;
    const subject = menu.find((m) => m.target === 'subject');
    expect(subject?.method).toBe('pro_refine');
    expect(calls.some((c) => c.name === 'ps_select_subject_instance')).toBe(true);
  });

  it('the DEFAULT read does not invoke the Pro refine at all', async () => {
    // The eager pass called Sensei once per scene read whether or not the
    // session ever selected the subject. Lazily, it is the select that pays.
    const { invokeTool, calls } = makeInvokeTool();
    const t = createSceneTools(conn.asConnection(), sc, {
      client: new FakeDetectionClient(),
      invokeTool,
    });
    await callTool(t, 'ps_read_scene', { annotate: false });
    expect(calls).toEqual([]);
  });
});

// ---------- annotateScene — clone invariant (3-gap-1) ----------
//
// annotateScene must never mutate the caller's DecodedImage in place — it may
// be shared with other same-call consumers (rowBrightnessProfile). Two calls
// with the same inputs must produce byte-identical output AND leave the input
// `data` array byte-identical before/after each call.
describe('annotateScene — clone invariant', () => {
  it('called twice on the same DecodedImage: byte-identical output, input untouched', () => {
    const w = 12;
    const h = 12;
    const data = new Uint8Array(w * h * 4);
    for (let i = 0; i < data.length; i++) data[i] = (i * 11) % 256; // deterministic, non-trivial fill
    const img: DecodedImage = { width: w, height: h, data };
    const before = Uint8Array.from(data);

    const faces: Array<[number, number, number, number]> = [[1, 1, 4, 4]];
    const objects: Array<[number, number, number, number]> = [[5, 5, 9, 9]];
    const horizonY = 6;

    const out1 = annotateScene(img, faces, objects, horizonY);
    expect(img.data).toEqual(before); // untouched after the first call

    const out2 = annotateScene(img, faces, objects, horizonY);
    expect(img.data).toEqual(before); // still untouched after the second call

    expect(Buffer.compare(out1, out2)).toBe(0); // deterministic, byte-identical output
  });
});

// ---------- 2026-08-01 batch: lazy face menu + regions cross-linking ----------

describe('lazy face-feature menu (on_demand)', () => {
  // Before this change ps_read_scene ran the face mesh EAGERLY and wrote nine
  // full-resolution scene:face_* channels (~51MB each on a 51MP doc, ~463MB of
  // the ~771MB total). The set is now advertised and materialized on first use.
  let conn: FakePhotoshopConnection;
  let sc: FakeSnippetClient;

  beforeEach(() => {
    __clearSceneCache();
    __resetPrecompute();
    conn = makeConnection({ resultFor: routeScripts });
    sc = makeSnippetClient();
  });

  const invoked: Array<{ name: string; args: Record<string, unknown> }> = [];
  const spyInvokeTool = async (name: string, args: Record<string, unknown>) => {
    invoked.push({ name, args });
    return { content: [], structuredContent: {} };
  };

  it('does NOT run the nine-feature mesh BATCH during ps_read_scene', async () => {
    invoked.length = 0;
    const t = createSceneTools(conn.asConnection(), sc, {
      client: new FakeDetectionClient(),
      invokeTool: spyInvokeTool,
      detectDeps: fakeDetectDeps(),
    });
    await callTool(t, 'ps_read_scene', { annotate: false });

    // The batch — ps_select_face_feature(precompute_all:true), which used to
    // save NINE full-resolution channels — must not run.
    expect(invoked.some((c) => c.args?.precompute_all === true)).toBe(false);

    // NOTE: the mesh is still invoked ONCE here, for the core `face` target
    // (the whole-face oval, a member of PRECOMPUTE_TARGETS). That is
    // pre-existing and deliberate; only the per-FEATURE set is deferred. So
    // assert on the feature channels, not on the tool never being called.
    const wroteFeatureChannel = conn
      .allScripts()
      .some((x) => /scene:face_[a-z_]+/.test(x) && x.includes('doc.channels.add()'));
    expect(wroteFeatureChannel).toBe(false);
  });

  it('advertises the face set as on_demand when the Pro mesh is reachable', async () => {
    // The harness runs EDITION='dev' (the committed default), where pro-tier
    // tools ARE reachable — so the menu should carry the set, flagged on_demand
    // because no channel has been written yet.
    const t = createSceneTools(conn.asConnection(), sc, {
      client: new FakeDetectionClient(),
      invokeTool: spyInvokeTool,
      detectDeps: fakeDetectDeps(),
    });
    const res = await callTool(t, 'ps_read_scene', { annotate: false });
    const menu = (
      res.structuredContent as {
        region_menu: Array<{ target: string; on_demand?: boolean; bounds: unknown }>;
      }
    ).region_menu;
    const faces = menu.filter((m) => m.target.startsWith('face_'));
    expect(faces.length).toBe(8);
    for (const f of faces) {
      expect(f.on_demand).toBe(true);
      expect(f.bounds).toBeNull(); // nothing measured — the mesh has not run
    }
  });

  it('gate basis: the Pro mesh tool is NOT reachable on a community build', () => {
    // This is what stops a CE user being shown 8 face regions they cannot
    // select. Asserted on the pure tier function rather than the ambient
    // EDITION, so it holds regardless of which edition the harness runs as.
    expect(isToolAllowedInEdition('ps_select_face_feature', 'community')).toBe(false);
    expect(isToolAllowedInEdition('ps_select_face_feature', 'pro')).toBe(true);
    expect(isToolAllowedInEdition('ps_select_face_feature', 'dev')).toBe(true);
  });
});

describe('regions[] cross-linking with the resolved menu', () => {
  let conn: FakePhotoshopConnection;
  let sc: FakeSnippetClient;

  beforeEach(() => {
    __clearSceneCache();
    __resetPrecompute();
    conn = makeConnection({ resultFor: routeScripts });
    sc = makeSnippetClient();
  });

  const readScene = async (args: Record<string, unknown>) => {
    const t = createSceneTools(conn.asConnection(), sc, {
      client: new FakeDetectionClient(),
      detectDeps: fakeDetectDeps(),
    });
    const res = await callTool(t, 'ps_read_scene', { annotate: false, ...args });
    return (res.structuredContent as { regions: Array<Record<string, unknown>> }).regions;
  };

  it('marks the coarse coverage as an estimate and links what actually resolved', async () => {
    // regions[] is a whole-frame HISTOGRAM split; region_menu is the real gated
    // selection. Live 2026-07-30 they disagreed hard on a night cityscape —
    // regions[].sky.coverage 0.08 vs a Sensei sky at 0.83 — and an agent reading
    // only regions[] concluded there was no sky worth selecting.
    const regions = await readScene({ save_regions: true });
    expect(regions.length).toBeGreaterThan(0);
    for (const r of regions) {
      expect(r.coverage_is_estimate).toBe(true);
      expect(['selectable', 'not_selectable']).toContain(r.selectable_state);
    }
    const sky = regions.find((r) => r.kind === 'sky');
    expect(sky?.selectable).toBe(true);
    expect(sky?.selectable_via).toBeTypeOf('string');
    expect(sky?.selectable_confidence).toBeTypeOf('number');
  });

  it('reports candidate (never a truthy string) when regions were only advertised', async () => {
    const regions = await readScene({ save_regions: false });
    for (const r of regions) {
      expect(r.selectable_state).toBe('candidate');
      // MUST be falsy for the same reason 'not_resolved' must be: a consumer
      // writing `if (r.selectable)` would read a truthy string as a promise that
      // the region resolves. Advertised is not verified.
      expect(r.selectable).toBeNull();
      expect(r.selectable).toBeFalsy();
      // No score — the gate has not run.
      expect(r.selectable_confidence).toBeUndefined();
    }
  });

  it('does not report absence when the precompute FAILED', async () => {
    // A transient PS error must not be reported as an authoritative
    // "not selectable" — that is exactly the misreading this linking prevents.
    // precomputeRegions isolates PER-TARGET failures internally (one bad method
    // must not empty the menu), so a channel-add throw is absorbed and that
    // target is legitimately reported not_selectable. To exercise the
    // precompute-FAILED path the whole pass has to fail — the stale-channel
    // wipe runs before any target and is outside that per-target guard.
    const boomConn = makeConnection({
      resultFor: (script: string) => {
        if (script.includes('__mcp_scene_chk__')) return { all_present: true };
        if (script.includes('var removed = 0;')) throw new Error('PS blew up');
        return routeScripts(script);
      },
    });
    const t = createSceneTools(boomConn.asConnection(), makeSnippetClient(), {
      client: new FakeDetectionClient(),
      detectDeps: fakeDetectDeps(),
    });
    const res = await callTool(t, 'ps_read_scene', { annotate: false, save_regions: true });
    const regions = (res.structuredContent as { regions: Array<Record<string, unknown>> }).regions;
    for (const r of regions) {
      // Distinct from 'candidate': the caller ASKED for a scored menu and the
      // pass failed, so we know nothing — not even that the region is a plausible
      // candidate worth offering.
      expect(r.selectable_state).toBe('not_resolved');
      expect(r.selectable).toBeNull();
    }
  });
});

/**
 * outputSchema ↔ producer sync. `regions[]` is a user-facing MCP contract: the
 * client validates the structured payload against outputSchema, so a drift here
 * rejects the WHOLE ps_read_scene response, not one field. The producer
 * (reconcileRegions) and the declared schema are maintained by hand in two
 * places, which is exactly the mirror the repo's derived-list invariant says to
 * pin.
 */
describe('ps_read_scene outputSchema describes what reconcileRegions emits', () => {
  const regionItemProps = () => {
    const tools = createSceneTools(makeConnection().asConnection(), makeSnippetClient(), {
      client: new FakeDetectionClient(),
      detectDeps: fakeDetectDeps(),
    });
    const def = tools.find((t) => t.tool.name === 'ps_read_scene');
    // The SDK types outputSchema's properties as a passthrough index signature,
    // so the shape has to come back through `unknown`.
    const schema = def?.tool.outputSchema as unknown as {
      properties: {
        regions: { items: { properties: Record<string, { type?: unknown; enum?: string[] }> } };
      };
    };
    return schema.properties.regions.items.properties;
  };

  it('declares every field the producer sets', () => {
    const props = regionItemProps();
    for (const field of [
      'kind',
      'coverage',
      'coverage_is_estimate',
      'selectable',
      'selectable_state',
      'selectable_via',
      'selectable_confidence',
    ]) {
      expect(props[field], `outputSchema is missing regions[].${field}`).toBeDefined();
    }
  });

  it('selectable is nullable — a consumer must not read it as a plain boolean', () => {
    expect(regionItemProps().selectable.type).toEqual(['boolean', 'null']);
  });

  it('selectable_state enum is DERIVED from the producer, not restated here', () => {
    // This assertion used to compare the schema against a copy of the list typed
    // out in this file. Both sides were hand-maintained, so a value added to
    // reconcileRegions alone left the schema under-declaring and this test
    // agreed with itself and passed — which is what happened when 'candidate'
    // was added (2026-08-24; caught by reading, not by this guard).
    //
    // Now both the schema and the producer's type come from SELECTABLE_STATES,
    // so the real guard is the compiler. This only pins that the schema still
    // spreads that constant rather than drifting back to a literal.
    expect(regionItemProps().selectable_state.enum).toEqual([...SELECTABLE_STATES]);
  });

  // NOTE: there is deliberately no test asserting "every SELECTABLE_STATES value
  // appears in the schema enum". The schema enum IS `[...SELECTABLE_STATES]`, so
  // such a test compares the constant to itself and can never fail — the same
  // self-agreeing shape that let the missing `candidate` slip through in the
  // first place. The real guard is the compiler: `reconcileRegions` declares a
  // `ReconciledRegion[]` return whose `selectable_state` is the literal union,
  // so emitting an undeclared state fails `tsc`, not vitest.
});
