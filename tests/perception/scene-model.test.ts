import { describe, it, expect, beforeEach } from 'vitest';
import {
  rowBrightnessProfile,
  buildSceneModel,
  __clearSceneCache,
} from '@editmamei/perception/scene-model.ts';
import type { DecodedImage } from '@editmamei/detection/runtime.ts';
import type { DetectActiveDocDeps } from '@editmamei/detection/detect-active-doc.ts';
import type {
  DetectionClient,
  DetectOptions,
  DetectionResult,
} from '@editmamei/detection/detection-client.ts';
import { makeConnection } from '../fixtures/fake-connection.ts';
import { makeSnippetClient } from '../fixtures/fake-snippet-client.ts';

/**
 * rowBrightnessProfile — reduces an ALREADY-DECODED export to top→bottom row-strip
 * mean luminances for the horizon facet. Perf-audit H4 changed its signature from
 * "raw export JPEG bytes (decode it yourself)" to "the DecodedImage detectActiveDoc
 * already decoded once" — no decode happens in this module anymore. These pin the
 * new signature's behavior directly (no jpeg-js round trip needed).
 */

function makeImage(w: number, h: number, fill: (x: number, y: number) => number): DecodedImage {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = fill(x, y);
      const i = (y * w + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  return { width: w, height: h, data };
}

describe('rowBrightnessProfile', () => {
  it('returns undefined when no decoded image is supplied (export unreadable/undecodable)', () => {
    expect(rowBrightnessProfile(undefined)).toBeUndefined();
  });

  it('returns undefined for a degenerate (zero-dimension) image', () => {
    expect(rowBrightnessProfile({ width: 0, height: 10, data: new Uint8Array(0) })).toBeUndefined();
    expect(rowBrightnessProfile({ width: 10, height: 0, data: new Uint8Array(0) })).toBeUndefined();
  });

  it('splits a bright-top / dark-bottom image into a rising then falling profile', () => {
    // Top half luma 200, bottom half luma 20 — pin the split lands where expected.
    const img = makeImage(4, 10, (_x, y) => (y < 5 ? 200 : 20));
    const profile = rowBrightnessProfile(img, 10);
    expect(profile).toHaveLength(10);
    expect(profile![0]).toBeCloseTo(200, 0);
    expect(profile![9]).toBeCloseTo(20, 0);
  });

  it('caps the strip count to the image height when strips > height', () => {
    const img = makeImage(2, 3, () => 100);
    const profile = rowBrightnessProfile(img, 64);
    expect(profile).toHaveLength(3); // min(64, height=3)
  });

  it('averages per-strip when multiple rows share a strip', () => {
    // 4 rows into 2 strips: strip0 = rows[0,1], strip1 = rows[2,3].
    const img = makeImage(1, 4, (_x, y) => [10, 30, 50, 70][y]);
    const profile = rowBrightnessProfile(img, 2);
    expect(profile).toHaveLength(2);
    expect(profile![0]).toBeCloseTo(20, 0); // mean(10,30)
    expect(profile![1]).toBeCloseTo(60, 0); // mean(50,70)
  });
});

/**
 * buildSceneModel — pixel-identity warm cache (2026-07-30 redesign). A repeat
 * ps_read_scene on an unchanged document used to cost ~29s — nearly the full
 * cold cost — because the OLD (doc id + history-state count) cache key was
 * silently poisoned by region-precompute's own channel add/remove side effects
 * (Undo-History-visible mutations). Freshness is now keyed to the DECODED
 * PIXELS of the export (+ doc identity), which those side effects never touch.
 *
 * These tests inject `detectDeps` (fake readFile/decode) so `decoded` is
 * populated — without it (the shape every OTHER test file in this repo uses,
 * since no real PS export ever lands on disk under the fake connection) the
 * cache can never verify pixel sameness and honestly always misses; see
 * tests/tools/scene-tools.test.ts for that fixture-shape pin too.
 */
describe('buildSceneModel — pixel-identity warm cache', () => {
  beforeEach(() => {
    __clearSceneCache();
  });

  class CountingDetectionClient implements DetectionClient {
    calls = 0;
    async detect(_path: string, opts: DetectOptions): Promise<DetectionResult> {
      this.calls++;
      const r: DetectionResult = { image: { width: 4, height: 4 }, backends: {} };
      if (opts.objects) {
        r.objects = [];
        r.backends.objects = 'dfine-s';
      }
      if (opts.faces) {
        r.faces = [];
        r.backends.faces = 'ultraface';
      }
      return r;
    }
  }

  function makeDecoded(fill: number, w = 8, h = 8): DecodedImage {
    return { width: w, height: h, data: new Uint8Array(w * h * 4).fill(fill) };
  }

  function deps(decoded: DecodedImage): DetectActiveDocDeps {
    return { readFile: async () => Buffer.from('fake-export-bytes'), decode: () => decoded };
  }

  // A bimodal 256-bin histogram so pickThresholdLevel/computeTonalZones/estimateHorizon
  // don't degenerate — mirrors tests/tools/scene-tools.test.ts's HISTOGRAM fixture.
  function histogramBins(): number[] {
    const b = new Array(256).fill(0);
    b[40] = 5000;
    b[210] = 5000;
    return b;
  }

  function routerFor(docName: string, activeLayerName?: string): (script: string) => unknown {
    return (script: string) => {
      if (script.includes('__mcp_detect__')) {
        return {
          ok: true,
          doc_width: 100,
          doc_height: 100,
          context: {
            hasDocument: true,
            document: { name: docName },
            ...(activeLayerName ? { activeLayer: { name: activeLayerName } } : {}),
          },
        };
      }
      if (script.includes('"__snippet":"getHistogram"')) {
        return { bins: histogramBins(), total_pixels: 10000, mean: 125, median: 125 };
      }
      return { ok: true };
    };
  }

  /** A degraded getContextInfo() path — no `document` key at all, so
   *  docKeyFrom cannot read a document.name and returns null. */
  function degradedRouter(): (script: string) => unknown {
    return (script: string) => {
      if (script.includes('__mcp_detect__')) {
        return {
          ok: true,
          doc_width: 100,
          doc_height: 100,
          context: { hasDocument: true }, // no `document` key
        };
      }
      if (script.includes('"__snippet":"getHistogram"')) {
        return { bins: histogramBins(), total_pixels: 10000, mean: 125, median: 125 };
      }
      return { ok: true };
    };
  }

  it('identical decoded pixels + identical doc identity → the second build HITS: zero detector invocations, cached:true', async () => {
    const client = new CountingDetectionClient();
    const conn = makeConnection({ resultFor: routerFor('photo.psd') });
    const sc = makeSnippetClient();
    const d = deps(makeDecoded(50));

    const r1 = await buildSceneModel(conn.asConnection(), sc, client, { detectDeps: d });
    expect(client.calls).toBe(1);
    expect(r1.model.provenance.cached).toBe(false);

    const r2 = await buildSceneModel(conn.asConnection(), sc, client, { detectDeps: d });
    expect(client.calls).toBe(1); // no second ONNX call
    expect(r2.model.provenance.cached).toBe(true);
    expect(r2.model.subjects).toEqual(r1.model.subjects);
    expect(r2.model.horizon).toEqual(r1.model.horizon);
    expect(r2.model.provenance.cache_key).toBe(r1.model.provenance.cache_key);
    // 3-gap-2: a HIT skips the histogram read too, not just the ONNX call —
    // getHistogram was built exactly once across both reads.
    expect(sc.allBuilds().filter((b) => b.name === 'getHistogram').length).toBe(1);
  });

  it('changed pixels → the second build re-detects (full miss), cached:false', async () => {
    const client = new CountingDetectionClient();
    const conn = makeConnection({ resultFor: routerFor('photo.psd') });
    const sc = makeSnippetClient();

    await buildSceneModel(conn.asConnection(), sc, client, { detectDeps: deps(makeDecoded(50)) });
    expect(client.calls).toBe(1);
    const r2 = await buildSceneModel(conn.asConnection(), sc, client, {
      detectDeps: deps(makeDecoded(200)),
    });
    expect(client.calls).toBe(2);
    expect(r2.model.provenance.cached).toBe(false);
  });

  it('same pixels but a DIFFERENT active document (name differs in the export context) → miss, never hits across documents', async () => {
    const client = new CountingDetectionClient();
    const sc = makeSnippetClient();
    const d = deps(makeDecoded(50));

    const connA = makeConnection({ resultFor: routerFor('docA.psd') });
    await buildSceneModel(connA.asConnection(), sc, client, { detectDeps: d });
    expect(client.calls).toBe(1);

    const connB = makeConnection({ resultFor: routerFor('docB.psd') });
    const r2 = await buildSceneModel(connB.asConnection(), sc, client, { detectDeps: d });
    expect(client.calls).toBe(2);
    expect(r2.model.provenance.cached).toBe(false);
  });

  it('same pixels but the selection state FLIPPED → miss (doc.histogram is selection-scoped, so tonal facets must not alias across selection states)', async () => {
    const client = new CountingDetectionClient();
    const sc = makeSnippetClient();
    const d = deps(makeDecoded(50));

    const selRouter = (hasSelection: boolean) => (script: string) => {
      if (script.includes('__mcp_detect__')) {
        return {
          ok: true,
          doc_width: 100,
          doc_height: 100,
          context: { hasDocument: true, document: { name: 'photo.psd', hasSelection } },
        };
      }
      if (script.includes('"__snippet":"getHistogram"')) {
        return { bins: histogramBins(), total_pixels: 10000, mean: 125, median: 125 };
      }
      return { ok: true };
    };

    const connSel = makeConnection({ resultFor: selRouter(true) });
    await buildSceneModel(connSel.asConnection(), sc, client, { detectDeps: d });
    expect(client.calls).toBe(1);

    const connNoSel = makeConnection({ resultFor: selRouter(false) });
    const r2 = await buildSceneModel(connNoSel.asConnection(), sc, client, { detectDeps: d });
    expect(client.calls).toBe(2); // selection flip must re-detect, never serve cached facets
    expect(r2.model.provenance.cached).toBe(false);
  });

  it('doc-state (the export context) is read FRESH every call even when pixel-derived facets are served from cache', async () => {
    const client = new CountingDetectionClient();
    const sc = makeSnippetClient();
    const d = deps(makeDecoded(50));

    const conn = makeConnection({ resultFor: routerFor('photo.psd', 'layer-1') });
    const r1 = await buildSceneModel(conn.asConnection(), sc, client, { detectDeps: d });

    const conn2 = makeConnection({ resultFor: routerFor('photo.psd', 'layer-2') });
    const r2 = await buildSceneModel(conn2.asConnection(), sc, client, { detectDeps: d });

    expect(client.calls).toBe(1); // pixel-identity HIT — detection reused
    expect(r2.model.provenance.cached).toBe(true);
    expect((r1.context as { activeLayer: { name: string } }).activeLayer.name).toBe('layer-1');
    expect((r2.context as { activeLayer: { name: string } }).activeLayer.name).toBe('layer-2');
  });

  it('without decodable pixels (no detectDeps injected), the cache honestly never hits — every build re-detects', async () => {
    const client = new CountingDetectionClient();
    const conn = makeConnection({ resultFor: routerFor('photo.psd') });
    const sc = makeSnippetClient();

    // No detectDeps: readFile(tempPath) hits a real nonexistent temp file and
    // fails non-fatally (same shape as every other test file in this repo under
    // the fake connection) — decoded stays undefined, so pixel identity can never
    // be verified. Honest fail-open: always miss rather than risk a false hit.
    await buildSceneModel(conn.asConnection(), sc, client);
    expect(client.calls).toBe(1);
    const r2 = await buildSceneModel(conn.asConnection(), sc, client);
    expect(client.calls).toBe(2);
    expect(r2.model.provenance.cached).toBe(false);
  });

  it('degraded context (no document.name) on both calls never collides into a false HIT (1c)', async () => {
    // The old behavior fell back to a shared 'unknown' sentinel string for
    // docKey, so two DIFFERENT degraded documents with byte-identical pixel
    // samples would false-positive match. docKeyFrom now returns null on this
    // path, and samePixelIdentity treats a null docKey (on either side, even
    // matched against itself) as always-miss — no verifiable identity, so
    // never a cache hit.
    const client = new CountingDetectionClient();
    const conn = makeConnection({ resultFor: degradedRouter() });
    const sc = makeSnippetClient();
    const d = deps(makeDecoded(50));

    const r1 = await buildSceneModel(conn.asConnection(), sc, client, { detectDeps: d });
    expect(client.calls).toBe(1);
    expect(r1.model.provenance.cached).toBe(false);

    const r2 = await buildSceneModel(conn.asConnection(), sc, client, { detectDeps: d });
    expect(client.calls).toBe(2); // MISS, even with identical pixels + identical (degraded) context
    expect(r2.model.provenance.cached).toBe(false);
  });

  it('a forced refresh (useCache:false) always re-detects, but still repopulates the cache for the NEXT normal call', async () => {
    const client = new CountingDetectionClient();
    const conn = makeConnection({ resultFor: routerFor('photo.psd') });
    const sc = makeSnippetClient();
    const d = deps(makeDecoded(50));

    await buildSceneModel(conn.asConnection(), sc, client, { detectDeps: d, useCache: false });
    expect(client.calls).toBe(1);
    await buildSceneModel(conn.asConnection(), sc, client, { detectDeps: d, useCache: false });
    expect(client.calls).toBe(2); // forced refresh both times — never hits itself

    const r3 = await buildSceneModel(conn.asConnection(), sc, client, { detectDeps: d }); // normal call
    expect(client.calls).toBe(2); // hit the cache the forced refresh repopulated
    expect(r3.model.provenance.cached).toBe(true);
  });
});
