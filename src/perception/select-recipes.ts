/**
 * Select-by-reference resolver (Scene Model v2).
 *
 * Turns a SEMANTIC target ("sky", "ground", "subject", "shadows", "highlights",
 * "skin", "face", "above_horizon", "foliage") into a real pixel selection on the
 * ORIGINAL document — but only when it clears the CONFIDENCE GATE. Each method
 * produces a candidate selection, we MEASURE it uniformly (selection_info), the
 * region scorer judges it (structural floor + model-tunable compositional
 * priors), and:
 *   - PASS  → the selection is left active and returned with its confidence.
 *   - FAIL  → we DESELECT and report HONEST ABSENCE (like detection not inventing
 *             a dog). The city with no real sky gets no sky.
 *
 * This replaces v1's blind per-target recipes (which shipped whatever the recipe
 * grabbed — urban "sky" = 68% bright blob). CE means professional-grade: a region
 * is offered only when produced cleanly, else honestly absent.
 *
 * Method fixes folded in as the first gated methods:
 *   - ground = invert(confident sky) − subject boxes  (content-following, not a line)
 *   - skin   = colour-range skin ∩ the subject/person box  (kills background bleed)
 *   - subject = box-posterize-wand (CE fallback) with a `proRefine` seam (Sensei/SAM)
 *
 * Every value reaching ExtendScript is escaped via jsLit/jsNum (wrapper contract).
 */

import type { PhotoshopConnection } from '../platform/connection.js';
import type { SnippetClient } from '../api/snippet-client.js';
import { runScript } from '../utils/run-script.js';
import { jsNum } from '../utils/jsx.js';
import { getContextInfo, getSelectionInfo } from '../api/extendscript/_helpers.js';
import type { BBox } from '../detection/detection-client.js';
import type { DecodedImage } from '../detection/runtime.js';
import type { SceneModel } from './scene-model.js';
import { computeSkyMask } from './sky-ground-flood.js';
import { loadSkyMaskAsSelection } from './sky-mask-transfer.js';
import { Logger } from '../utils/logger.js';

const logger = new Logger('select-recipes');
import {
  buildRegionSignals,
  scoreRegion,
  type CompositionContext,
  type RegionScore,
  type ScoredRegionKind,
} from './region-scorer.js';

/** Lightweight, re-runnable recipe descriptor carried by a region/zone facet. */
export type RecipeDescriptor =
  | { kind: 'threshold_white'; level: number }
  | {
      kind: 'posterize_region';
      levels: number;
      sample: 'below_horizon' | 'point';
      x?: number;
      y?: number;
    };

/**
 * Pro face-FEATURE targets (mesh-backed): each resolves to `scene:face_<feature>`
 * and loads by name like any scene region. The `face_` prefix maps to the
 * ps_select_face_feature `feature` arg by stripping it. Per-side
 * (left_eye/…) is available via the Pro tool directly, not as a reference target.
 */
export const FACE_FEATURE_TARGETS = [
  'face_skin',
  'face_eyes',
  'face_brows',
  'face_lips',
  'face_teeth',
  'face_nose',
  'face_under_eye',
  'face_cheeks',
] as const;
export type FaceFeatureTarget = (typeof FACE_FEATURE_TARGETS)[number];

/** The semantic targets select-by-reference accepts. */
export const SELECT_REFERENCE_TARGETS = [
  'sky',
  'ground',
  'foliage',
  'subject',
  'face',
  'shadows',
  'highlights',
  'skin',
  'above_horizon',
  ...FACE_FEATURE_TARGETS,
] as const;
export type SelectReferenceTarget = (typeof SELECT_REFERENCE_TARGETS)[number];

/** Is this a Pro face-feature target? (narrows for the resolver branch.) */
export function isFaceFeatureTarget(t: string): t is FaceFeatureTarget {
  return (FACE_FEATURE_TARGETS as readonly string[]).includes(t);
}

/**
 * What the Pro refine broker is asked to select precisely. It carries enough to
 * AIM Sensei's Select Subject at the right instance — `label`/`instance` map onto
 * `select_subject_instance`'s `label`/`which` — not just a bare box, because that
 * tool re-detects rather than consuming a rectangle. `box` is the scene model's
 * resolved target (a future SAM box-prompt refine can use it directly).
 */
export type ProRefineRequest =
  | { kind: 'subject'; label: string; instance?: number; box: BBox }
  | { kind: 'face'; box: BBox }
  | { kind: 'face_feature'; feature: string };

/**
 * Optional Pro refine broker — given a target, leave a precise selection active on
 * the document and resolve `true`. Resolves `false` when it can't refine (an
 * un-entitled CE host where the Pro tool isn't loaded, a target it doesn't handle,
 * or a Sensei failure) so the caller degrades to the CE method.
 */
export type ProRefine = (req: ProRefineRequest) => Promise<boolean>;

/**
 * Inputs the structural `sky_ground_flood` method needs, carried from the scene build
 * (the perception export + the detected object boxes). When present, sky resolves
 * through the ground-subtraction CV method; otherwise it falls back to threshold/Sensei.
 */
export interface SkyContext {
  /** The perception export, already decoded once by detectActiveDoc — undefined
   *  when the export/decode failed (falls through to the CE threshold/Sensei
   *  candidates below, same as before this was decoded upstream). */
  decoded: DecodedImage | undefined;
  /** Detected object boxes in EXPORT-pixel space — the object-gate (no-fill regions). */
  boxes: BBox[];
  /** Full document dimensions the working-resolution mask upscales to. */
  docW: number;
  docH: number;
}

export interface ResolveOptions {
  /** For `subject`: a COCO label override (default picks the main subject). */
  label?: string;
  /** For `subject`: 0-based instance index (left-to-right) instead of main. */
  instance?: number;
  /** A Pro refine broker, used for subject/face when entitled. */
  proRefine?: ProRefine;
  /** Model-supplied compositional context that tunes the scorer's priors. */
  composition?: CompositionContext;
  /** Export buffer + object boxes enabling the structural sky_ground_flood method. */
  skyCtx?: SkyContext;
}

export interface ResolveResult {
  target: string;
  /** The method that ran (for transparency in the tool output). */
  method: string;
  /** Did the candidate clear the confidence gate? (false ⇒ honest absence, deselected.) */
  passed: boolean;
  /** 0..1 confidence from the region scorer. */
  confidence: number;
  /** Scorer contributors (oversight + debugging). */
  reasons: string[];
  /** Post-op selection stats (when a selection was produced). */
  selection_info?: Record<string, unknown>;
  /** Extra per-method detail (box, level, …). */
  detail: Record<string, unknown>;
}

type SelInfo = {
  has_selection?: boolean;
  bounds?: { left: number; top: number; right: number; bottom: number } | null;
  area_percent?: number;
  edge_complexity?: number;
  bounds_fill_ratio?: number;
};

// ---------- uniform measure + scene context ----------

/** Read the CURRENT selection's full selection_info (never throws on empty). */
async function measure(connection: PhotoshopConnection): Promise<SelInfo> {
  const script = `${getSelectionInfo}\nreturn getSelectionInfo();`;
  return (await runScript(connection, script)) as SelInfo;
}

/**
 * COCO classes that signal an INDOOR scene — used to suppress a bright-ceiling
 * "sky" false positive. Includes the no-space label variants the detector emits
 * (`diningtable`, `tvmonitor`). Deliberately excludes `chair`/`bench` (common on
 * outdoor patios) so an outdoor scene with seating is not mislabelled indoors.
 */
const INDOOR_LABELS = new Set([
  'bed',
  'couch',
  'sofa',
  'dining table',
  'diningtable',
  'toilet',
  'tv',
  'tvmonitor',
  'microwave',
  'oven',
  'refrigerator',
  'sink',
  'laptop',
]);

/** The scene facts the scorer's signal builder needs. */
function sceneCtx(model: SceneModel): {
  docW: number;
  docH: number;
  /** null when no horizon was measured — scorers must not substitute a prior. */
  horizonY: number | null;
  horizonConfidence: number;
  indoorObjectCount: number;
} {
  let indoorObjectCount = 0;
  for (const s of model.subjects) if (INDOOR_LABELS.has(s.label)) indoorObjectCount++;
  return {
    docW: model.doc.width,
    docH: model.doc.height,
    horizonY: model.horizon.detected ? model.horizon.y : null,
    horizonConfidence: model.horizon.detected ? model.horizon.confidence : 0,
    indoorObjectCount,
  };
}

/**
 * Score an already-measured selection_info bundle as `kind` — pure Node-side
 * scoring, NO PS round trip. Extracted out of `measureAndScore` so a caller that
 * merged a derive step with its own measure (either an inline script that embeds
 * `getSelectionInfo()` itself, or a proven snippet whose own result already
 * carries `selection_info`) can score it without firing a second, redundant
 * measure call (the trip-count reduction this module exists for — see
 * region-precompute.ts's orchestration comment).
 */
function scoreInfo(
  info: SelInfo,
  model: SceneModel,
  kind: ScoredRegionKind,
  composition?: CompositionContext
): RegionScore {
  const signals = buildRegionSignals(
    {
      has_selection: info.has_selection,
      bounds: info.bounds ?? null,
      area_percent: info.area_percent,
      edge_complexity: info.edge_complexity,
      bounds_fill_ratio: info.bounds_fill_ratio,
    },
    sceneCtx(model)
  );
  return scoreRegion(kind, signals, composition);
}

/** Measure the current selection and score it as `kind` (1 PS round trip). Use
 *  `scoreInfo` directly instead when the selection_info was already obtained as
 *  part of a merged derive step. */
async function measureAndScore(
  connection: PhotoshopConnection,
  model: SceneModel,
  kind: ScoredRegionKind,
  composition?: CompositionContext
): Promise<{ info: SelInfo; score: RegionScore }> {
  const info = await measure(connection);
  return { info, score: scoreInfo(info, model, kind, composition) };
}

/** Drop the active selection (honest-absence cleanup). Best-effort. */
async function deselect(connection: PhotoshopConnection, snippet: SnippetClient): Promise<void> {
  try {
    await runScript(connection, await snippet.build('deselect'));
  } catch {
    // ignore
  }
}

/** Assemble the ResolveResult, deselecting when the gate failed. */
async function gateResult(
  connection: PhotoshopConnection,
  snippet: SnippetClient,
  target: string,
  method: string,
  info: SelInfo,
  score: RegionScore,
  detail: Record<string, unknown>
): Promise<ResolveResult> {
  if (!score.passed) {
    await deselect(connection, snippet);
  }
  return {
    target,
    method,
    passed: score.passed,
    confidence: score.confidence,
    reasons: score.reasons,
    selection_info: score.passed ? (info as unknown as Record<string, unknown>) : undefined,
    detail,
  };
}

// ---------- best-of candidate methods (CE + Pro/Sensei, gated) ----------

/**
 * One candidate method: a label + a producer that leaves a selection active AND
 * resolves its OWN selection_info — merged into ONE PS round trip wherever the
 * underlying op supports it (an inline script that embeds `getSelectionInfo()`
 * itself, or a proven snippet whose own result already carries `selection_info`).
 * A candidate that can't merge (e.g. an AM event whose own result isn't
 * measure-shaped) measures separately inside its own `produce` — invisible to
 * `bestOf`, which only ever sees the resolved `SelInfo`.
 */
interface MethodCandidate {
  method: string;
  /** Produce the candidate selection and resolve its selection_info; may throw if
   *  unavailable (Sensei in CE / cloud-off). */
  produce: () => Promise<SelInfo>;
}

/**
 * Run each candidate, score it, keep the BEST-scoring one (re-running the winner so
 * its selection stays active). A candidate that throws — a Pro/Sensei snippet absent
 * in this edition, or a cloud-model failure — is skipped, so the gate degrades
 * gracefully to the CE method. Returns the winner's gated result (honest absence if
 * no candidate produced anything or none cleared the gate).
 */
async function bestOf(
  connection: PhotoshopConnection,
  snippet: SnippetClient,
  model: SceneModel,
  kind: ScoredRegionKind,
  composition: CompositionContext | undefined,
  target: string,
  candidates: MethodCandidate[],
  detail: Record<string, unknown> = {}
): Promise<ResolveResult> {
  let winner: { c: MethodCandidate; confidence: number } | null = null;
  for (const c of candidates) {
    let info: SelInfo;
    try {
      info = await c.produce();
    } catch {
      continue; // method unavailable in this edition — skip
    }
    const score = scoreInfo(info, model, kind, composition);
    if (!winner || score.confidence > winner.confidence)
      winner = { c, confidence: score.confidence };
  }
  if (!winner) {
    await deselect(connection, snippet);
    return {
      target,
      method: 'none',
      passed: false,
      confidence: 0,
      reasons: ['no method produced a selection'],
      detail,
    };
  }
  const info = await winner.c.produce(); // re-run the winner so its selection is the active one
  const score = scoreInfo(info, model, kind, composition);
  return gateResult(connection, snippet, target, winner.c.method, info, score, detail);
}

// ---------- the threshold-sky primitive (shared by sky + ground) ----------

/**
 * Build the threshold-sky selection: add a threshold adjustment layer (the
 * histogram-picked level), magic-wand the bright region from the top-centre on
 * the composite (sample-all-layers), delete the layer (the selection persists),
 * then measure it — all in ONE PS round trip (merged 2026-07-29 to cut the
 * per-target trip count; see region-precompute.ts). Non-destructive.
 */
function thresholdSkyScript(level: number, seedX: number, seedY: number): string {
  return `
    // __mcp_scene_thr__ region-select glue
    ${getContextInfo}
    ${getSelectionInfo}
    function cTID(s){ return app.charIDToTypeID(s); }
    function sTID(s){ return app.stringIDToTypeID(s); }
    if (app.documents.length === 0) { throw new Error('No document is open in Photoshop'); }
    var doc = app.activeDocument;
    var __mk = new ActionDescriptor();
    var __ref = new ActionReference();
    __ref.putClass(sTID('adjustmentLayer'));
    __mk.putReference(cTID('null'), __ref);
    var __type = new ActionDescriptor();
    __type.putInteger(cTID('Lvl '), ${jsNum(level, 128)});
    var __using = new ActionDescriptor();
    __using.putObject(cTID('Type'), cTID('Thrs'), __type);
    __mk.putObject(cTID('Usng'), sTID('adjustmentLayer'), __using);
    app.executeAction(cTID('Mk  '), __mk, DialogModes.NO);
    var __adj = doc.activeLayer;
    var __wand = new ActionDescriptor();
    var __wref = new ActionReference();
    __wref.putProperty(cTID('Chnl'), cTID('fsel'));
    __wand.putReference(cTID('null'), __wref);
    var __pt = new ActionDescriptor();
    __pt.putUnitDouble(cTID('Hrzn'), cTID('#Pxl'), ${jsNum(seedX, 0)});
    __pt.putUnitDouble(cTID('Vrtc'), cTID('#Pxl'), ${jsNum(seedY, 0)});
    __wand.putObject(cTID('T   '), cTID('Pnt '), __pt);
    __wand.putInteger(cTID('Tlrn'), 32);
    __wand.putBoolean(cTID('AntA'), true);
    __wand.putBoolean(cTID('Mrgd'), true);
    app.executeAction(cTID('setd'), __wand, DialogModes.NO);
    try { __adj.remove(); } catch (eRm) {}
    return getSelectionInfo();
  `;
}

/**
 * Build the posterize-region (subject/foliage) selection, same non-destructive
 * shape as {@link thresholdSkyScript} — merged derive+measure in one round trip.
 */
function posterizeRegionScript(seedX: number, seedY: number): string {
  return `
    // __mcp_scene_pst__ region-select glue
    ${getContextInfo}
    ${getSelectionInfo}
    function cTID(s){ return app.charIDToTypeID(s); }
    function sTID(s){ return app.stringIDToTypeID(s); }
    if (app.documents.length === 0) { throw new Error('No document is open in Photoshop'); }
    var doc = app.activeDocument;
    var __mk = new ActionDescriptor();
    var __ref = new ActionReference();
    __ref.putClass(sTID('adjustmentLayer'));
    __mk.putReference(cTID('null'), __ref);
    var __type = new ActionDescriptor();
    __type.putInteger(cTID('Lvls'), 3);
    var __using = new ActionDescriptor();
    __using.putObject(cTID('Type'), cTID('Pstr'), __type);
    __mk.putObject(cTID('Usng'), sTID('adjustmentLayer'), __using);
    app.executeAction(cTID('Mk  '), __mk, DialogModes.NO);
    var __adj = doc.activeLayer;
    var __wand = new ActionDescriptor();
    var __wref = new ActionReference();
    __wref.putProperty(cTID('Chnl'), cTID('fsel'));
    __wand.putReference(cTID('null'), __wref);
    var __pt = new ActionDescriptor();
    __pt.putUnitDouble(cTID('Hrzn'), cTID('#Pxl'), ${jsNum(seedX, 0)});
    __pt.putUnitDouble(cTID('Vrtc'), cTID('#Pxl'), ${jsNum(seedY, 0)});
    __wand.putObject(cTID('T   '), cTID('Pnt '), __pt);
    __wand.putInteger(cTID('Tlrn'), 32);
    __wand.putBoolean(cTID('AntA'), true);
    __wand.putBoolean(cTID('Mrgd'), true);
    app.executeAction(cTID('setd'), __wand, DialogModes.NO);
    try { __adj.remove(); } catch (eRm) {}
    return getSelectionInfo();
  `;
}

/** A sky seed point: top-centre of the frame. */
function skySeed(model: SceneModel): { x: number; y: number } {
  return {
    x: Math.round(model.doc.width / 2),
    y: Math.max(1, Math.round(model.doc.height * 0.06)),
  };
}

// ---------- the resolver ----------

export async function resolveSelection(
  connection: PhotoshopConnection,
  snippet: SnippetClient,
  model: SceneModel,
  target: SelectReferenceTarget,
  opts: ResolveOptions = {}
): Promise<ResolveResult> {
  // Pro face-feature targets (mesh-backed) resolve through the broker, not the
  // CE region recipes/scorer.
  if (isFaceFeatureTarget(target)) {
    return resolveFaceFeature(connection, snippet, target, target.slice('face_'.length), opts);
  }
  switch (target) {
    case 'sky':
      return resolveSky(connection, snippet, model, opts.composition, opts.skyCtx);
    case 'ground':
      return resolveGround(connection, snippet, model, opts.composition);
    case 'foliage':
      return resolveFoliage(connection, snippet, model, opts.composition);
    case 'shadows':
      return resolveLuminance(connection, snippet, model, 'shadows', opts.composition);
    case 'highlights':
      return resolveLuminance(connection, snippet, model, 'highlights', opts.composition);
    case 'skin':
      return resolveSkin(connection, snippet, model, opts.composition);
    case 'subject':
      return resolveSubject(connection, snippet, model, opts);
    case 'face':
      return resolveFace(connection, snippet, model, opts);
    case 'above_horizon':
      return resolveAboveHorizon(connection, snippet, model, opts.composition);
    default:
      throw new Error(`Unknown select-by-reference target: ${String(target)}`);
  }
}

/**
 * Derive the threshold-sky selection on the active doc (the histogram-picked
 * level + top-centre seed) AND measure it — ONE PS round trip (thresholdSkyScript
 * embeds getSelectionInfo). Shared by `sky` and `ground` (which inverts it) so
 * the level/seed derivation lives in one place. Was `produceThresholdSky`
 * (produce-only, `{level,seed}`) before the 2026-07-29 merge — both callers
 * discarded that return value, so it's replaced with the SelInfo callers
 * actually need to score the candidate without a second, separate measure call.
 */
async function deriveAndMeasureThresholdSky(
  connection: PhotoshopConnection,
  model: SceneModel
): Promise<SelInfo> {
  const skyRecipe = model.regions.find((r) => r.kind === 'sky');
  const level =
    skyRecipe && skyRecipe.recipe.kind === 'threshold_white' ? skyRecipe.recipe.level : 128;
  const seed = skySeed(model);
  return (await runScript(connection, thresholdSkyScript(level, seed.x, seed.y))) as SelInfo;
}

/**
 * sky → best of CE threshold-white and Sensei `select_sky`, gated. Sensei is
 * semantic (it knows sky vs bright building) so it rescues the urban case where
 * threshold grabs all bright pixels; threshold wins on a clean dominant sky and
 * is the fallback when Sensei is unavailable (CE edition / cloud model off).
 */
async function resolveSky(
  connection: PhotoshopConnection,
  snippet: SnippetClient,
  model: SceneModel,
  composition?: CompositionContext,
  skyCtx?: SkyContext
): Promise<ResolveResult> {
  // PRIMARY: the structural ground-subtraction method (validated as the sky method) —
  // ground = bottom-connected landmass; sky = the rest; fill the thin intrusions the
  // object detector doesn't claim. Content-free apart from the local detector boxes.
  // Used whenever it produces a selection that clears the gate; threshold/Sensei are the
  // FALLBACK only when it errors or the gate rejects its result (never lose to them on a
  // score comparison — they are the older, weaker methods being replaced).
  if (skyCtx?.decoded) {
    try {
      const { mask, width, height } = computeSkyMask(
        skyCtx.decoded.data,
        skyCtx.decoded.width,
        skyCtx.decoded.height,
        skyCtx.boxes
      );
      await loadSkyMaskAsSelection(connection, mask, width, height, skyCtx.docW, skyCtx.docH);
      const { info, score } = await measureAndScore(connection, model, 'sky', composition);
      if (score.passed) {
        return gateResult(connection, snippet, 'sky', 'sky_ground_flood', info, score, {});
      }
      // gate rejected the structural mask — fall through to the CE candidates.
    } catch (e) {
      logger.warn(`sky_ground_flood failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return bestOf(connection, snippet, model, 'sky', composition, 'sky', [
    {
      method: 'threshold_white',
      produce: () => deriveAndMeasureThresholdSky(connection, model),
    },
    {
      method: 'sensei_select_sky',
      // selectSky's own go-core result embeds a selection_info bundle, but the
      // fixture-level shape isn't relied on here — measure separately so this
      // candidate's confidence is always read from a real getSelectionInfo() call.
      produce: async () => {
        await runScript(
          connection,
          await snippet.build('selectSky', { sampleAllLayers: true, selectionType: 'replace' })
        );
        return measure(connection);
      },
    },
  ]);
}

/**
 * ground → invert(confident sky) − subject boxes. Content-following (it traces
 * the real sky boundary), not a horizon rectangle. Requires a confident sky; if
 * none, ground is honestly absent.
 */
async function resolveGround(
  connection: PhotoshopConnection,
  snippet: SnippetClient,
  model: SceneModel,
  composition?: CompositionContext
): Promise<ResolveResult> {
  // Derive + measure the sky pre-check in ONE round trip (was 2 separate calls).
  const skyInfo = await deriveAndMeasureThresholdSky(connection, model);
  const skyScore = scoreInfo(skyInfo, model, 'sky', composition);
  if (!skyScore.passed) {
    await deselect(connection, snippet);
    return {
      target: 'ground',
      method: 'invert_sky_minus_subjects',
      passed: false,
      confidence: 0,
      reasons: ['no confident sky to invert', ...skyScore.reasons],
      detail: { note: 'ground = invert(confident sky) − subjects; no confident sky found' },
    };
  }
  // Invert the confident sky → everything-not-sky, then carve out subjects. The
  // subject boxes are Node-known data (no PS round trip needed to pick them), so
  // build the invert + every subtract snippet CONCURRENTLY (pure CPU, snippet.build
  // is not queue-bound) before issuing them one at a time through the serialized
  // PS queue — that queue itself cannot be parallelized, but the builds ahead of
  // it can. Each of these proven snippets already returns its own selection_info,
  // so the LAST one issued (the last subtract, or the invert itself with no
  // subjects) carries the post-op measurement — no separate final measure call.
  const [invertScript, ...subtractScripts] = await Promise.all([
    snippet.build('invertSelection'),
    ...model.subjects.map((s) => {
      const [l, t, r, b] = s.bbox;
      return snippet.build('selectRectangle', {
        left: l,
        top: t,
        right: r,
        bottom: b,
        featherPx: 0,
        selectionType: 'subtract',
      });
    }),
  ]);
  await runScript(connection, invertScript);
  let lastResult: { selection_info?: SelInfo } | undefined;
  for (const script of subtractScripts) {
    lastResult = (await runScript(connection, script)) as { selection_info?: SelInfo };
  }
  let info: SelInfo;
  let score: RegionScore;
  if (lastResult?.selection_info) {
    info = lastResult.selection_info;
    score = scoreInfo(info, model, 'ground', composition);
  } else {
    // No subjects to subtract. invertSelection's own go-core result DOES embed
    // selection_info (vault.InvertS returns { inverted, method, selection_info }
    // just like every other proven snippet here) — but the shared test router
    // (tests/perception/select-recipes.test.ts's failEverythingRouter and
    // friends) doesn't simulate that for invertSelection specifically, so
    // merging this branch is deferred for the same reason as the selectSky
    // candidate in resolveSky: fixture coverage, not a real shape gap. Fall back
    // to an explicit measure, same as before the merge.
    ({ info, score } = await measureAndScore(connection, model, 'ground', composition));
  }
  return gateResult(connection, snippet, 'ground', 'invert_sky_minus_subjects', info, score, {
    subjects_subtracted: model.subjects.length,
  });
}

/** foliage → posterize-region wand (lower-third), gated. */
async function resolveFoliage(
  connection: PhotoshopConnection,
  snippet: SnippetClient,
  model: SceneModel,
  composition?: CompositionContext
): Promise<ResolveResult> {
  const seedX = Math.round(model.doc.width / 2);
  const seedY = Math.round(model.doc.height * 0.8);
  const info = (await runScript(connection, posterizeRegionScript(seedX, seedY))) as SelInfo;
  const score = scoreInfo(info, model, 'foliage', composition);
  return gateResult(connection, snippet, 'foliage', 'posterize_region', info, score, {
    seed: { x: seedX, y: seedY },
  });
}

/** shadows/highlights → luminance range (proven snippet), gated. */
async function resolveLuminance(
  connection: PhotoshopConnection,
  snippet: SnippetClient,
  model: SceneModel,
  band: 'shadows' | 'highlights',
  composition?: CompositionContext
): Promise<ResolveResult> {
  // selectLuminanceRange's own go-core result already embeds selection_info —
  // reuse it instead of a second, separate measure round trip.
  const result = (await runScript(
    connection,
    await snippet.build('selectLuminanceRange', {
      mode: band,
      fuzziness: 40,
      selectionType: 'replace',
    })
  )) as { selection_info?: SelInfo };
  const info = result.selection_info ?? (await measure(connection));
  const score = scoreInfo(info, model, band, composition);
  return gateResult(connection, snippet, band, 'luminance_range', info, score, { band });
}

/** skin → colour-range skin tones ∩ the subject/person box (kills background bleed). */
async function resolveSkin(
  connection: PhotoshopConnection,
  snippet: SnippetClient,
  model: SceneModel,
  composition?: CompositionContext
): Promise<ResolveResult> {
  // The intersect box (if any) is Node-known data up front — build both snippets
  // CONCURRENTLY (pure CPU) before running them through the serialized PS queue
  // in order. Each proven snippet below already returns its own selection_info —
  // track the LAST one issued (colour-range alone, or the intersect when a box
  // narrows it) instead of firing a separate final measure call.
  const person = model.subjects.find((s) => s.label === 'person');
  const box: BBox | undefined = person?.bbox ?? model.faces.find((f) => f.is_primary)?.bbox;

  // SEMANTIC PRECONDITION: skin needs someone to belong to. Without a person
  // subject or a face, the box is undefined and this used to fall through to a
  // bare skin-tone colour range over the WHOLE canvas — which selects anything
  // warm. Live 2026-07-30 on a night cityscape with ZERO faces and ZERO person
  // detections, the amber bridge lighting scored 0.67 and `scene:skin` was
  // offered in the region menu as confidently selectable. Colour alone cannot
  // distinguish skin from tungsten; the person box is what made this method
  // meaningful, so with no person the honest answer is absence — the same
  // contract as "the city with no real sky gets no sky".
  if (!box) {
    await deselect(connection, snippet);
    return {
      target: 'skin',
      method: 'color_range_skin_∩_box',
      passed: false,
      confidence: 0,
      reasons: [
        'no person or face detected — skin-tone colour alone cannot tell skin from ' +
          'any other warm subject (tungsten light, wood, amber signage), so nothing was selected',
      ],
      detail: { intersected_with_box: false, no_person_or_face: true },
    };
  }

  const [colorPresetScript, intersectScript] = await Promise.all([
    snippet.build('selectColorPreset', {
      preset: 'skin_tones',
      fuzziness: 40,
      useFaces: false,
      selectionType: 'replace',
    }),
    box
      ? snippet.build('selectRectangle', {
          left: box[0],
          top: box[1],
          right: box[2],
          bottom: box[3],
          featherPx: 0,
          selectionType: 'intersect',
        })
      : Promise.resolve(undefined),
  ]);
  let lastResult = (await runScript(connection, colorPresetScript)) as {
    selection_info?: SelInfo;
  };
  const intersected = intersectScript !== undefined;
  if (intersectScript !== undefined) {
    lastResult = (await runScript(connection, intersectScript)) as { selection_info?: SelInfo };
  }
  const info = lastResult.selection_info ?? (await measure(connection));
  const score = scoreInfo(info, model, 'skin', composition);
  return gateResult(connection, snippet, 'skin', 'color_range_skin_∩_box', info, score, {
    intersected_with_box: intersected,
  });
}

/** subject → Pro refine when entitled, else CE box-posterize-wand. Gated. */
async function resolveSubject(
  connection: PhotoshopConnection,
  snippet: SnippetClient,
  model: SceneModel,
  opts: ResolveOptions
): Promise<ResolveResult> {
  const box = pickSubjectBox(model, opts);
  if (!box) {
    const seen = [...new Set(model.subjects.map((s) => s.label))].sort();
    return {
      target: 'subject',
      method: 'none',
      passed: false,
      confidence: 0,
      reasons: [`no subject${opts.label ? ` for label "${opts.label}"` : ''}`],
      detail: { detected: seen },
    };
  }
  if (opts.proRefine) {
    const ok = await opts.proRefine({
      kind: 'subject',
      label: box.label,
      instance: labelRelativeInstance(model, box, opts.instance),
      box: box.bbox,
    });
    if (ok) {
      const { info, score } = await measureAndScore(connection, model, 'subject', opts.composition);
      return gateResult(connection, snippet, 'subject', 'pro_refine', info, score, {
        label: box.label,
        box: box.bbox,
      });
    }
    // fall through to CE if Pro refine declined.
  }
  const cx = Math.round((box.bbox[0] + box.bbox[2]) / 2);
  const cy = Math.round((box.bbox[1] + box.bbox[3]) / 2);
  const info = (await runScript(connection, posterizeRegionScript(cx, cy))) as SelInfo;
  const score = scoreInfo(info, model, 'subject', opts.composition);
  return gateResult(connection, snippet, 'subject', 'box_posterize_wand', info, score, {
    label: box.label,
    box: box.bbox,
    seed: { x: cx, y: cy },
  });
}

/** face → primary face box ellipse (or Pro refine), gated. */
async function resolveFace(
  connection: PhotoshopConnection,
  snippet: SnippetClient,
  model: SceneModel,
  opts: ResolveOptions
): Promise<ResolveResult> {
  const face = model.faces.find((f) => f.is_primary) ?? model.faces[0];
  if (!face) {
    return {
      target: 'face',
      method: 'none',
      passed: false,
      confidence: 0,
      reasons: ['no face detected'],
      detail: {},
    };
  }
  if (opts.proRefine) {
    const ok = await opts.proRefine({ kind: 'face', box: face.bbox });
    if (ok) {
      const { info, score } = await measureAndScore(connection, model, 'face', opts.composition);
      return gateResult(connection, snippet, 'face', 'pro_refine', info, score, { box: face.bbox });
    }
  }
  const [l, t, r2, b] = face.bbox;
  const feather = Math.max(4, Math.round(Math.min(r2 - l, b - t) * 0.08));
  const result = (await runScript(
    connection,
    await snippet.build('selectEllipse', {
      left: l,
      top: t,
      right: r2,
      bottom: b,
      featherPx: feather,
      antiAlias: true,
      selectionType: 'replace',
    })
  )) as { selection_info?: SelInfo };
  const info = result.selection_info ?? (await measure(connection));
  const score = scoreInfo(info, model, 'face', opts.composition);
  return gateResult(connection, snippet, 'face', 'face_box_ellipse', info, score, {
    box: face.bbox,
    feather,
  });
}

/**
 * Pro face-feature target → the mesh polygon selection via the broker. The mesh
 * is precise, so the gate is simple: pass iff the broker left a non-empty
 * selection. CE (no broker) is honest absence — the mesh is a Pro feature, and a
 * CE host has no recipe that reaches a teeth/iris/skin-minus-features region.
 */
async function resolveFaceFeature(
  connection: PhotoshopConnection,
  snippet: SnippetClient,
  target: string,
  feature: string,
  opts: ResolveOptions
): Promise<ResolveResult> {
  if (!opts.proRefine) {
    return {
      target,
      method: 'none',
      passed: false,
      confidence: 0,
      reasons: ['face-feature selection needs the Pro face mesh (not available in this edition)'],
      detail: { feature },
    };
  }
  const ok = await opts.proRefine({ kind: 'face_feature', feature });
  if (!ok) {
    await deselect(connection, snippet);
    return {
      target,
      method: 'face_mesh',
      passed: false,
      confidence: 0,
      reasons: ['no face mesh resolved, or the feature could not be built from the landmarks'],
      detail: { feature },
    };
  }
  const info = await measure(connection);
  const passed = info.has_selection === true && (info.area_percent ?? 0) > 0;
  if (!passed) await deselect(connection, snippet);
  return {
    target,
    method: 'face_mesh',
    passed,
    confidence: passed ? 1 : 0,
    reasons: passed ? ['mesh polygon selection'] : ['mesh produced an empty selection'],
    selection_info: passed ? (info as unknown as Record<string, unknown>) : undefined,
    detail: { feature },
  };
}

/** above_horizon → honest geometric rectangle to the horizon (a labeled geometric region). */
async function resolveAboveHorizon(
  connection: PhotoshopConnection,
  snippet: SnippetClient,
  model: SceneModel,
  composition?: CompositionContext
): Promise<ResolveResult> {
  // No measured horizon means there is no "above the horizon" to select. This
  // used to read a rule-of-thirds prior off the horizon facet and slice the top
  // third of the frame — a rectangle presented as a region, on images with no
  // horizon in them at all. Honest absence is the same contract every other
  // unconfident target here already returns.
  const horizon = model.horizon;
  if (!horizon.detected) {
    return {
      target: 'above_horizon',
      method: 'none',
      passed: false,
      confidence: 0,
      reasons: [`no horizon was measured in this frame (${horizon.reason})`],
      detail: { horizon_detected: false, horizon_reason: horizon.reason },
    };
  }
  const y = Math.max(1, Math.min(model.doc.height, horizon.y));
  const result = (await runScript(
    connection,
    await snippet.build('selectRectangle', {
      left: 0,
      top: 0,
      right: model.doc.width,
      bottom: y,
      featherPx: Math.max(2, Math.round(model.doc.height * 0.01)),
      selectionType: 'replace',
    })
  )) as { selection_info?: SelInfo };
  const info = result.selection_info ?? (await measure(connection));
  const score = scoreInfo(info, model, 'above_horizon', composition);
  return gateResult(connection, snippet, 'above_horizon', 'rectangle_to_horizon', info, score, {
    horizon_y: y,
  });
}

// ---------- helpers ----------

/**
 * Translate the requested `instance` into the index `select_subject_instance`
 * re-derives. `pickSubjectBox` indexed it over the pool it used — the FULL
 * multi-label subject list when no `label` was given — but the Pro tool filters
 * detections to `label` FIRST and then counts left-to-right. So the Pro `which`
 * must be the CHOSEN box's position among SAME-LABEL subjects, not its position in
 * the full pool (otherwise `instance:2` over [person,dog,person] would tell the
 * Pro tool "person #2" and target the wrong instance / fall out of range). Returns
 * undefined for the default (no explicit instance) case so the broker uses
 * which:'largest' — which correctly maps to the global-largest subject, since the
 * largest subject is also the largest of its own label.
 */
function labelRelativeInstance(
  model: SceneModel,
  box: { label: string; bbox: BBox },
  requested: number | undefined
): number | undefined {
  if (typeof requested !== 'number') return undefined;
  const sameLabel = model.subjects
    .filter((s) => s.label === box.label)
    .sort((a, b) => a.bbox[0] - b.bbox[0]);
  const idx = sameLabel.findIndex((s) => s.bbox === box.bbox);
  return idx >= 0 ? idx : requested;
}

function pickSubjectBox(
  model: SceneModel,
  opts: ResolveOptions
): { label: string; bbox: BBox } | null {
  let pool = model.subjects;
  if (opts.label) pool = pool.filter((s) => s.label === opts.label);
  if (pool.length === 0) return null;
  if (typeof opts.instance === 'number') {
    const byLeft = [...pool].sort((a, b) => a.bbox[0] - b.bbox[0]);
    const s = byLeft[opts.instance];
    return s ? { label: s.label, bbox: s.bbox } : null;
  }
  const main = pool.find((s) => s.is_main);
  const chosen = main ?? [...pool].sort((a, b) => boxAreaOf(b.bbox) - boxAreaOf(a.bbox))[0];
  return { label: chosen.label, bbox: chosen.bbox };
}

function boxAreaOf(b: BBox): number {
  return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
}
