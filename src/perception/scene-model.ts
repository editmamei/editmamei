/**
 * Scene Model v1 — the perception layer (Layer 1 of the three-layer spatial
 * stack).
 *
 * One local perception pass over the active document that reuses the detection
 * export+decode path and assembles a structured, DOCUMENT-pixel scene model:
 *
 *   - subjects + faces   — existing ONNX detection (detectActiveDoc).
 *   - regions (sky/ground) — coarse, from the histogram-picked sky threshold +
 *     horizon split (coverage estimates; the precise pixel masks are produced
 *     on demand by the select-by-reference resolver, NOT stored here).
 *   - horizon            — sky/ground luminance split over the decoded export.
 *   - tonal zones        — luminance-threshold bands over the composite histogram.
 *   - composition        — geometry over the subjects + horizon.
 *
 * The model is content-free beyond the downscaled annotated preview the tool
 * renders separately — it carries coordinates and coverage numbers, never raw
 * pixels or paths.
 *
 * Caching (redesigned 2026-07-30 — warm-cache audit): freshness is keyed to the
 * DECODED PIXELS of the perception export — a sparse FNV-1a hash (first/last 4KB
 * + a ~1024-point stride), mirroring `OnnxSamSegmenter`'s embedding memo in
 * src/detection/sam-segmenter.ts — plus the document identity (name + dims) from
 * the export context, NOT a (doc id + history-state count) key. The export+decode
 * round trip is ALWAYS paid: it doubles as the freshness probe (there is no way to
 * know the pixels are unchanged without re-exporting and re-decoding). On a HIT,
 * `detectActiveDoc` skips the ONNX call entirely and this module skips the
 * histogram read and every facet computation, reusing the prior subjects / faces /
 * regions / horizon / tonal_zones / composition. Doc-state (the getContextInfo()
 * context, doc width/height) is read FRESH on every call regardless of hit/miss —
 * only pixel-derived facets ever come from the cache.
 *
 * The OLD history-state key was silently self-poisoning: region-precompute.ts's
 * own channel add/remove side effects (`doc.channels.add()`/`.remove()`) are
 * Undo-History-visible mutations, so `doc.historyStates.length` was HIGHER on a
 * repeat `ps_read_scene` call than at the START of the read that produced it —
 * meaning a same-document, same-pixels repeat read NEVER actually hit in practice
 * (confirmed: ~29s repeat cost, nearly the cold-start cost). Pixel identity is
 * invariant to that side effect (channel ops never touch the RGB composite), which
 * is what makes the warm path real. region-precompute.ts's existence-check closes
 * the matching staleness gap for the saved `scene:*` channels themselves (they can
 * go missing — reopened doc, manual deletion — independent of pixel identity).
 *
 * Per the 2026-06-23 decision, `mask_ref` is RE-DERIVE-ON-DEMAND: each region /
 * tonal-zone facet carries a lightweight recipe descriptor (`recipe`) that the
 * select-by-reference resolver re-runs to produce the actual selection. No saved
 * alpha channels live in the model.
 */

import type { PhotoshopConnection } from '../platform/connection.js';
import type { SnippetClient } from '../api/snippet-client.js';
import { runScript } from '../utils/run-script.js';
import { getContextInfo } from '../api/extendscript/_helpers.js';
import { detectActiveDoc, type DetectActiveDocDeps } from '../detection/detect-active-doc.js';
import type { DecodedImage } from '../detection/runtime.js';
import {
  computePixelIdentity,
  docKeyFrom,
  identityKeyString,
  samePixelIdentity,
  type PixelIdentity,
} from './pixel-identity.js';
import type { BBox, DetectionClient } from '../detection/detection-client.js';
import { Logger } from '../utils/logger.js';
import {
  computeComposition,
  computeTonalZones,
  estimateHorizon,
  pickThresholdLevel,
  boxArea,
  toLumaHistogram,
  type CompositionFacet,
  type HorizonFacet,
  type TonalZones,
} from './facets.js';
import type { RecipeDescriptor } from './select-recipes.js';

export interface SubjectFacet {
  id: string;
  label: string;
  bbox: BBox;
  confidence: number;
  /** Largest-area subject is the main one (cheap salience proxy in CE v1). */
  is_main: boolean;
}

export interface FaceFacet {
  bbox: BBox;
  confidence: number;
  is_primary: boolean;
}

export interface RegionFacet {
  kind: 'sky' | 'ground';
  /** 0..1 fraction of the frame this region covers (coarse estimate). */
  coverage: number;
  /** The recipe the resolver re-runs to select this region (mask_ref = re-derive). */
  recipe: RecipeDescriptor;
}

export interface SceneModel {
  doc: { width: number; height: number };
  subjects: SubjectFacet[];
  faces: FaceFacet[];
  regions: RegionFacet[];
  horizon: HorizonFacet;
  tonal_zones: TonalZones;
  composition: CompositionFacet;
  provenance: {
    backends: { faces?: string; objects?: string; regions: string };
    edition: string;
    /** Opaque pixel-identity + doc-identity key this model was built for — see
     *  the module doc comment. NOT a doc id / history-state key. */
    cache_key: string;
    /** True when this model was served from the pixel-identity cache (ONNX
     *  detection, histogram, and facet computation skipped) rather than freshly
     *  built. The export+decode round trip itself always ran either way. */
    cached: boolean;
  };
}

export interface BuildSceneOptions {
  /** Serve a cached model when the pixel identity (+ doc identity) is unchanged. */
  useCache?: boolean;
  /** Long-edge px of the detection/perception export. Default 1024. */
  maxDimension?: number;
  /** Object detection confidence gate (0..1). Default 0.4. */
  objectThreshold?: number;
  /** Face detection confidence gate (0..1). Default 0.7. */
  faceThreshold?: number;
  /** Test-only seam: injected readFile/decode passed straight through to
   *  detectActiveDoc (see DetectActiveDocDeps), so a unit test can prove the
   *  pixel-identity cache with controlled fake pixels instead of a real PS
   *  export on disk. Never set in production. */
  detectDeps?: DetectActiveDocDeps;
}

/** Internal: what the per-build returns alongside the model (preview bytes). */
export interface SceneBuildResult {
  model: SceneModel;
  /** The bounded export JPEG bytes (export-pixel space) for the annotated preview. */
  exportBytes: Buffer;
  /** The export decoded ONCE by detectActiveDoc — reused for the row-brightness
   *  profile and any annotated-preview drawing instead of re-decoding exportBytes
   *  (perf-audit H4). Undefined when the export was unreadable/undecodable. */
  decoded: DecodedImage | undefined;
  /** Detection boxes in EXPORT-pixel space (for drawing on exportBytes). */
  rawFaces: BBox[];
  rawObjects: Array<{ label: string; bbox: BBox }>;
  /** Export image dims (matches exportBytes / the raw boxes). */
  exportImage: { width: number; height: number };
  context: Record<string, unknown> | undefined;
}

const logger = new Logger('scene-model');

// ---------- pixel identity (warm-cache freshness probe) ----------
//
// Extracted to ./pixel-identity.ts (2026-08-01) so ps_detect reuses the exact
// same freshness probe rather than growing a second, subtly-different one.

// ---------- cache ----------

/** Everything pixel-derived from a build, keyed by pixel+doc identity. Doc-state
 *  (context, doc width/height) is deliberately NOT cached here — see the module
 *  doc comment; it's read fresh on every call regardless of hit/miss. */
interface CacheEntry {
  identity: PixelIdentity;
  cacheKey: string;
  subjects: SubjectFacet[];
  faces: FaceFacet[];
  regions: RegionFacet[];
  horizon: HorizonFacet;
  tonalZones: TonalZones;
  composition: CompositionFacet;
  backends: { faces?: string; objects?: string; regions: string };
  rawFaces: BBox[];
  rawObjects: Array<{ label: string; bbox: BBox }>;
  exportImage: { width: number; height: number };
}

// Module-level single-entry cache. The scene model is per active document state;
// a one-slot cache is enough because the consumer is one MCP session editing one
// document at a time, and any state change rotates the identity. (If two docs are
// alternated the cache thrashes but always stays correct — never stale.)
let cache: CacheEntry | null = null;

// Counter for the (rare) case pixel identity can't be computed at all — export
// undecodable. Each such build gets a unique cache_key so it can never falsely
// match a later build (fail-safe: no verifiable identity means always miss).
// Wraps well below Number.MAX_SAFE_INTEGER (cosmetic — a real process would
// need billions of undecodable exports to reach it) so the counter itself
// can't grow unbounded over a very long-lived server process.
const NO_PIXEL_IDENTITY_COUNTER_WRAP = 1_000_000_000;
let noPixelIdentityCounter = 0;

/** Advance + return the wrapping no-pixel-identity counter (see above). */
function nextNoPixelIdentityId(): number {
  noPixelIdentityCounter = (noPixelIdentityCounter + 1) % NO_PIXEL_IDENTITY_COUNTER_WRAP;
  return noPixelIdentityCounter;
}

/** Test-only: clear the perception cache between cases. */
export function __clearSceneCache(): void {
  cache = null;
}

// ---------- row-brightness profile (for the horizon facet) ----------

/**
 * Reduce the already-decoded export to R top→bottom row-strip mean luminances.
 * Pure JS over the pixels detectActiveDoc already decoded — no extra PS round
 * trip, no extra decode. Returns undefined (caller falls back to the thirds
 * prior) if the export was undecodable/absent.
 */
export function rowBrightnessProfile(
  decoded: DecodedImage | undefined,
  strips = 64
): number[] | undefined {
  if (!decoded) return undefined;
  const { width: w, height: h, data } = decoded;
  if (w <= 0 || h <= 0) return undefined;
  const R = Math.max(1, Math.min(strips, h));
  const sums = new Array(R).fill(0);
  const counts = new Array(R).fill(0);
  for (let y = 0; y < h; y++) {
    const strip = Math.min(R - 1, Math.floor((y / h) * R));
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // Rec. 601 luma — matches PS's perceptual luminance closely enough for a
      // sky/ground split.
      rowSum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    sums[strip] += rowSum;
    counts[strip] += w;
  }
  return sums.map((s, i) => (counts[i] > 0 ? s / counts[i] : 0));
}

// ---------- builder ----------

/**
 * Build (or return a pixel-identity cache hit for) a scene model for the active
 * document.
 *
 * The export+decode round trip ALWAYS runs — it's both the perception pipeline's
 * input and the freshness probe (see the module doc comment). `shouldDetect`
 * fires right after decode, inside the SAME detectActiveDoc call (its temp file
 * would be gone by the time a second call could react), and decides there whether
 * the pixels match the cached identity; a match skips the ONNX call, the histogram
 * read, and every facet computation below, reusing the cached facets instead.
 */
export async function buildSceneModel(
  connection: PhotoshopConnection,
  snippet: SnippetClient,
  client: DetectionClient,
  opts: BuildSceneOptions = {}
): Promise<SceneBuildResult> {
  const useCache = opts.useCache ?? true;
  let hit: CacheEntry | null = null;
  let freshIdentity: PixelIdentity | null = null;

  const det = await detectActiveDoc(
    connection,
    client,
    {
      faces: true,
      objects: true,
      maxDimension: opts.maxDimension,
      objectThreshold: opts.objectThreshold,
      faceThreshold: opts.faceThreshold,
      shouldDetect: ({ decoded, context, docWidth, docHeight }) => {
        if (!decoded) return true; // can't identify pixels — always detect
        const identity = computePixelIdentity(decoded, docKeyFrom(context, docWidth, docHeight));
        // Remember the identity regardless of useCache, so a forced refresh
        // (useCache:false) still repopulates the cache for the NEXT normal call —
        // matching the old cache's unconditional-store-at-the-end behavior.
        freshIdentity = identity;
        if (useCache && cache && samePixelIdentity(cache.identity, identity)) {
          hit = cache;
          return false; // pixel-identical to the cached build — skip ONNX
        }
        return true;
      },
    },
    opts.detectDeps
  );

  if (hit) {
    const cached: CacheEntry = hit;
    logger.debug(
      `scene-model: pixel-identity cache HIT (${cached.cacheKey}) — reusing detection + ` +
        `facets, skipping ONNX + histogram + facet rebuild`
    );
    const model: SceneModel = {
      doc: { width: det.docWidth, height: det.docHeight },
      subjects: cached.subjects,
      faces: cached.faces,
      regions: cached.regions,
      horizon: cached.horizon,
      tonal_zones: cached.tonalZones,
      composition: cached.composition,
      provenance: {
        backends: cached.backends,
        edition: 'ce',
        cache_key: cached.cacheKey,
        cached: true,
      },
    };
    return {
      model,
      // Doc-state-derived: fresh from THIS call's export, never from the cache.
      exportBytes: det.exportBytes,
      decoded: det.decoded,
      context: det.context,
      // Pixel-derived: reused from the cache (export-pixel-space boxes/dims are
      // valid unchanged since the pixels themselves are identical).
      rawFaces: cached.rawFaces,
      rawObjects: cached.rawObjects,
      exportImage: cached.exportImage,
    };
  }

  // MISS (pixels changed, doc switched, caching disabled, or export undecodable)
  // — the full pipeline, unchanged from before this redesign.
  const docW = det.docWidth;
  const docH = det.docHeight;

  // Subjects: every detected object, main = largest area.
  const objects = det.result.objects ?? [];
  let mainIdx = -1;
  let mainArea = -1;
  objects.forEach((o, i) => {
    const a = boxArea(o.bbox);
    if (a > mainArea) {
      mainArea = a;
      mainIdx = i;
    }
  });
  const subjects: SubjectFacet[] = objects.map((o, i) => ({
    id: `s${i + 1}`,
    label: o.label,
    bbox: o.bbox,
    confidence: o.confidence,
    is_main: i === mainIdx,
  }));

  // Faces: primary = highest confidence.
  const detFaces = det.result.faces ?? [];
  let primaryFaceIdx = -1;
  let bestFaceConf = -1;
  detFaces.forEach((f, i) => {
    if (f.confidence > bestFaceConf) {
      bestFaceConf = f.confidence;
      primaryFaceIdx = i;
    }
  });
  const faces: FaceFacet[] = detFaces.map((f, i) => ({
    bbox: f.bbox,
    confidence: f.confidence,
    is_primary: i === primaryFaceIdx,
  }));

  // Histogram (composite luminance) → threshold pick + tonal zones.
  const histRaw = (await runScript(
    connection,
    await snippet.build('getHistogram', { channel: 'luminosity' })
  )) as { bins?: number[]; total_pixels?: number; mean?: number; median?: number };
  const hist = toLumaHistogram(histRaw);
  const pick = pickThresholdLevel(hist);
  const tonalZones = computeTonalZones(hist);

  // Horizon from the row-brightness profile of the decoded export. mainBox is
  // hoisted above this (it is also used for composition below) so the estimator
  // can suppress a false horizon that is really a dominant subject's edge.
  // The primary FACE goes in too: a tight head-and-shoulders crop often isn't
  // classified `person` by COCO, so mainBox is null on exactly the portraits
  // most prone to a false horizon while the face detector fires cleanly.
  const allBoxes = objects.map((o) => o.bbox);
  const mainBox = mainIdx >= 0 ? objects[mainIdx].bbox : null;
  const primaryFaceBox = faces.find((f) => f.is_primary)?.bbox ?? faces[0]?.bbox ?? null;
  const rowMeans = rowBrightnessProfile(det.decoded);
  const horizon = estimateHorizon(rowMeans, docH, pick, mainBox, primaryFaceBox);

  // Coarse regions: sky = bright mass above the threshold; ground = the rest.
  // coverage is the histogram bright/dark split; the actual selection is
  // re-derived on demand by the resolver via the carried recipe.
  const skyCoverage = pick.bright_fraction;
  const regions: RegionFacet[] = [
    {
      kind: 'sky',
      coverage: skyCoverage,
      recipe: { kind: 'threshold_white', level: pick.level },
    },
    {
      kind: 'ground',
      coverage: Math.max(0, 1 - skyCoverage),
      recipe: { kind: 'posterize_region', levels: 3, sample: 'below_horizon' },
    },
  ];

  // Composition geometry over the subjects + horizon (allBoxes/mainBox hoisted
  // above for the horizon estimator).
  const composition = computeComposition(mainBox, allBoxes, docW, docH, horizon.placement);

  const backends = {
    faces: det.result.backends.faces,
    objects: det.result.backends.objects,
    regions: 'heuristic',
  };
  const rawFaces = (det.raw.faces ?? []).map((f) => f.bbox);
  const rawObjects = (det.raw.objects ?? []).map((o) => ({ label: o.label, bbox: o.bbox }));
  const exportImage = det.raw.image;
  const cacheKey = freshIdentity
    ? identityKeyString(freshIdentity)
    : `nopixel-${nextNoPixelIdentityId()}`;

  const model: SceneModel = {
    doc: { width: docW, height: docH },
    subjects,
    faces,
    regions,
    horizon,
    tonal_zones: tonalZones,
    composition,
    provenance: {
      backends,
      edition: 'ce',
      cache_key: cacheKey,
      cached: false,
    },
  };

  const result: SceneBuildResult = {
    model,
    exportBytes: det.exportBytes,
    decoded: det.decoded,
    rawFaces,
    rawObjects,
    exportImage,
    context: det.context,
  };

  // Repopulate the cache whenever pixel identity was computable — even on a
  // forced refresh (useCache:false), so the NEXT normal call can hit against it
  // (mirrors the old cache's unconditional store-at-the-end behavior).
  if (freshIdentity) {
    cache = {
      identity: freshIdentity,
      cacheKey,
      subjects,
      faces,
      regions,
      horizon,
      tonalZones,
      composition,
      backends,
      rawFaces,
      rawObjects,
      exportImage,
    };
  }

  return result;
}

// Re-export so the tool layer can reference the context helper without a second
// import path (parity with detection-driven tools that pull it from _helpers).
export { getContextInfo };
