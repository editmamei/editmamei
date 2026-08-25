/**
 * Scene Model v1 tools (Layer 1 perception).
 *
 *   ps_read_scene               — the "look before you select" read: returns
 *                                   the structured scene model + an annotated
 *                                   preview (subject boxes, horizon line, region
 *                                   tints, tonal-zone hint). Content-free beyond
 *                                   the downscaled preview.
 *   ps_select_by_reference — the headline: resolve a SEMANTIC target
 *                                   (sky / ground / subject / shadows / … ) to a
 *                                   real pixel selection on the ORIGINAL in
 *                                   document px. The kill for the rectangle reflex.
 *
 * Both reuse the perception builder (one cached pass per doc state) and assemble
 * proven CE recipes. Both start at tier 'dev'; promotion to 'community' is a
 * separate live-verified commit. Steering (overview/skill) is deliberately NOT
 * touched here — the leak guard forbids dev-tier tool names in those surfaces.
 */

import { encode } from 'jpeg-js';
import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import type { SnippetClient } from '../api/snippet-client.js';
import { validateArgs, type JsonSchemaObject } from '../utils/validate.js';
import { OnnxDetectionClient, type DetectionClient } from '../detection/detection-client.js';
import type { DecodedImage } from '../detection/runtime.js';
import type { DetectActiveDocDeps } from '../detection/detect-active-doc.js';
import { ANNOTATED_PREVIEW_JPEG_QUALITY } from '../utils/jpeg-quality.js';
import { buildSceneModel, type SceneModel } from '../perception/scene-model.js';
import {
  resolveSelection,
  SELECT_REFERENCE_TARGETS,
  type SelectReferenceTarget,
  type ProRefine,
  type SkyContext,
} from '../perception/select-recipes.js';
import type { SceneBuildResult } from '../perception/scene-model.js';
import type { CompositionContext } from '../perception/region-scorer.js';
import {
  precomputeRegions,
  candidateMenu,
  invalidateSceneChannelsIfStale,
  loadPrecomputedRegion,
  saveSelectionAsSceneChannel,
  CHANNEL_PREFIX,
  type RegionMenuItem,
} from '../perception/region-precompute.js';
import { toolErrorResult } from '../utils/tool-helpers.js';
import { Logger } from '../utils/logger.js';
import { isProEntitled } from '../license/entitlement.js';
import { EDITION } from '../edition.js';
import { isToolAllowedInEdition } from '../core/tool-tiers.js';
import {
  ANNOTATION_RGB,
  annotationThickness,
  drawBoxOutline,
  drawHLine,
} from '../perception/overlay.js';

const logger = new Logger('scene-tools');

// ---------- Pro refine broker (subject → Sensei instance mask) ----------

/** The cross-module broker — the host's `invokeTool` (HostApi §7). */
type InvokeTool = (name: string, args: Record<string, unknown>) => Promise<ToolResult>;

/**
 * The Pro refine broker for select-by-reference's subject seam: aim Sensei's
 * Select Subject at the ONE detected instance via ps_select_subject_instance
 * (local detection crops a copy to the instance, Sensei runs on the crop, the mask
 * transfers back to the original as a selection), then let the resolver measure +
 * score that precise selection. This is what fixes CE's empty-grab on animals.
 *
 * Returns false — so the resolver degrades to the CE box-posterize-wand — for
 * anything it can't refine: `face` (no Pro face tool yet), an un-entitled CE host
 * (the Pro tool isn't loaded, so invokeTool throws), or a Sensei failure. The Pro
 * tool re-detects by label, so `instance` (0-based, left-to-right) maps onto its
 * `which`, and the default (largest/main) subject maps onto `which:'largest'`.
 */
function makeProRefine(invokeTool: InvokeTool): ProRefine {
  return async (req) => {
    try {
      if (req.kind === 'subject') {
        const which = typeof req.instance === 'number' ? String(req.instance) : 'largest';
        const res = await invokeTool('ps_select_subject_instance', {
          label: req.label,
          which,
          save_as: 'selection',
        });
        return res.isError !== true;
      }
      // face / face_feature → the Pro mesh tool. 'face' selects the oval; a
      // face_feature selects that named feature (eyes/teeth/skin/…).
      const feature = req.kind === 'face' ? 'face' : req.feature;
      const res = await invokeTool('ps_select_face_feature', {
        feature,
        which: 'best',
        save_as: 'selection',
      });
      return res.isError !== true;
    } catch {
      return false; // not entitled / not registered / Sensei|mesh unavailable → CE fallback
    }
  };
}

/**
 * The Pro face-feature targets `ps_select_by_reference` can materialize from the
 * mesh. Mirrors FACE_FEATURE_TARGETS in select-recipes.ts (the resolver's own
 * list) — pinned by tests/perception/face-menu-mirror.test.ts so the advertised
 * menu can never promise a target the resolver won't accept.
 *
 * Deliberately excludes the whole-face oval: the core PRECOMPUTE_TARGETS pass
 * already saves `scene:face`, so advertising a mesh `face_face` duplicated it
 * (a redundant channel observed live 2026-07-30).
 */
export const FACE_MENU_TARGETS = [
  'face_skin',
  'face_eyes',
  'face_brows',
  'face_lips',
  'face_teeth',
  'face_nose',
  'face_under_eye',
  'face_cheeks',
] as const;

/**
 * Advertise the Pro face-feature set WITHOUT running the mesh. Returns menu
 * entries flagged `on_demand` so `ps_read_scene` still reports what is
 * selectable while the expensive mesh pass and its full-resolution channels are
 * deferred to the first actual request. Empty when un-entitled or no face was
 * detected — honest absence, same as before.
 */
function faceMenuFor(model: SceneModel, hasPro: boolean): RegionMenuItem[] {
  if (!hasPro || model.faces.length === 0) return [];
  return FACE_MENU_TARGETS.map((target) => ({
    key: `${CHANNEL_PREFIX}${target}`,
    target,
    method: 'face_mesh',
    // No confidence: the mesh has not run, so there is no score. It used to
    // claim 1, which asserted a verdict for eight features nothing had measured
    // — the same over-claim the CE candidate menu is careful not to make.
    bounds: null,
    on_demand: true,
  }));
}

/** Assemble the SkyContext the structural sky_ground_flood method consumes. The
 *  detected object boxes (export-pixel space, matching the decoded export) are the
 *  object-gate: the fill bridges thin intrusions everywhere EXCEPT over a real
 *  detected object. */
function skyCtxFrom(built: SceneBuildResult): SkyContext {
  return {
    decoded: built.decoded,
    boxes: built.rawObjects.map((o) => o.bbox),
    docW: built.model.doc.width,
    docH: built.model.doc.height,
  };
}

// ---------- ps_read_scene ----------

const sceneSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    annotate: {
      type: 'boolean',
      default: true,
      description:
        'Return an annotated preview with subject boxes (magenta), faces (cyan), and the horizon line (yellow) drawn so you can visually confirm the scene model.',
    },
    refresh: {
      type: 'boolean',
      default: false,
      description:
        'Force a fresh perception pass even if a cached model for the current document state exists. Perception is normally cached per (document, history-state) so it runs once per state.',
    },
    save_regions: {
      type: 'boolean',
      default: false,
      description:
        'EAGERLY derive every region (sky/ground/shadows/highlights/skin/subject/face) up front and SAVE each confident one as a managed `scene:*` alpha channel, so the returned menu carries a verified method + confidence for each. Costs one derive per target — measured at ~21s on a 4898x3265 layered document, against a 30s script timeout — so it is OFF by default. Leave it off unless you specifically need every region scored in one call: the default advertises the same menu as `on_demand` entries and ps_select_by_reference derives whichever region you actually ask for (then saves its channel, so repeats of THAT region are instant). The `scene:` channel-name prefix is RESERVED: channels matching it are treated as derived and are deleted on the next scene read and on ps_save_psd, so do not give a channel you want to keep a `scene:`-prefixed name.',
    },
    composition_context: {
      type: 'object',
      description:
        'Optional: tune the confidence gate for an artistic/non-standard composition (e.g. profile:big_sky) so a legitimately large region is not rejected. Same shape as ps_select_by_reference.',
      properties: {
        profile: {
          type: 'string',
          enum: ['balanced', 'big_sky', 'big_foreground', 'minimal', 'tight_subject'],
        },
        sky_coverage_max: { type: 'number', minimum: 0, maximum: 1 },
        ground_coverage_max: { type: 'number', minimum: 0, maximum: 1 },
        pass_threshold: { type: 'number', minimum: 0, maximum: 1 },
      },
    },
    max_dimension: {
      type: 'number',
      default: 1024,
      minimum: 256,
      maximum: 4096,
      description:
        'Long-edge px of the perception export. Returned coordinates are always in full document pixels.',
    },
  },
};

/** Draw axis-aligned boxes + a horizon line onto a COPY of the decoded export's
 *  pixels — never mutate the caller's DecodedImage in place. (The scene-model
 *  pixel-identity cache does NOT store `decoded` — every build gets a fresh
 *  decode, cache hit or miss — so the actual reason to never mutate in place is
 *  IN-CALL sharing: the same `built.decoded` reference is also handed to
 *  rowBrightnessProfile and any other same-call consumer, and a mutating draw
 *  would corrupt what those see.) Exported so a unit test can pin the clone
 *  invariant directly (3-gap-1). */
export function annotateScene(
  img: DecodedImage,
  faces: Array<[number, number, number, number]>,
  objects: Array<[number, number, number, number]>,
  horizonY: number | null
): Buffer {
  const { width: w, height: h } = img;
  const data = Uint8Array.from(img.data);
  const out = { data, width: w, height: h };
  const thickness = annotationThickness(out);
  for (const o of objects) drawBoxOutline(out, o, ANNOTATION_RGB.object, thickness);
  for (const f of faces) drawBoxOutline(out, f, ANNOTATION_RGB.face, thickness);
  if (horizonY !== null && horizonY >= 0 && horizonY < h) {
    drawHLine(out, horizonY, ANNOTATION_RGB.horizon, thickness);
  }
  return encode({ data, width: w, height: h }, ANNOTATED_PREVIEW_JPEG_QUALITY).data;
}

/** One-line scene summary for the human text block. */
function summarizeScene(model: SceneModel): string {
  const subjLabels = new Map<string, number>();
  for (const s of model.subjects) subjLabels.set(s.label, (subjLabels.get(s.label) ?? 0) + 1);
  const subjStr = [...subjLabels.entries()].map(([l, n]) => (n > 1 ? `${l}×${n}` : l)).join(', ');
  const main = model.subjects.find((s) => s.is_main);
  const cell = model.composition.main_subject_cell;
  const parts = [
    `${model.subjects.length} subject(s)${subjStr ? ` (${subjStr})` : ''}`,
    `${model.faces.length} face(s)`,
    `horizon at y=${model.horizon.y} (${Math.round(model.horizon.placement * 100)}% down, conf ${model.horizon.confidence.toFixed(2)})`,
    `sky ~${Math.round((model.regions.find((r) => r.kind === 'sky')?.coverage ?? 0) * 100)}%`,
  ];
  if (main && cell) parts.push(`main subject in the ${cell.row}-${cell.col} third`);
  return `Scene (${model.doc.width}×${model.doc.height}): ${parts.join('; ')}. Select named regions with ps_select_by_reference.`;
}

async function scene(
  connection: PhotoshopConnection,
  snippet: SnippetClient,
  client: DetectionClient,
  rawArgs: Record<string, unknown>,
  proRefine?: ProRefine,
  hasPro = false,
  detectDeps?: DetectActiveDocDeps
): Promise<ToolResult> {
  try {
    const args = validateArgs(sceneSchema, rawArgs);
    const annotate = (args.annotate as boolean) ?? true;
    const refresh = (args.refresh as boolean) ?? false;
    // Must match the schema default. Asserting the opposite here is harmless
    // only while validateArgs fills defaults in; deleting `default: false` from
    // the schema as a "that's just the absent case" cleanup would silently
    // reinstate the eager pass, and no test would catch it because every test
    // that exercises the eager path now passes save_regions explicitly.
    const saveRegions = (args.save_regions as boolean) ?? false;

    const built = await buildSceneModel(connection, snippet, client, {
      useCache: !refresh,
      maxDimension: args.max_dimension as number | undefined,
      detectDeps,
    });
    const model = built.model;

    // Oversight loop. By DEFAULT this advertises the menu and derives nothing —
    // the eager pass cost ~21s of the ~30s call and three of its seven targets
    // resolved to nothing (see PRECOMPUTE_TARGETS). `save_regions:true` opts
    // back into deriving and scoring every region up front.
    let regions: RegionMenuItem[] = [];
    // Distinguish "precompute ran and found nothing" from "precompute FAILED".
    // Without this a transient PS error left regions=[] and every entry was
    // reported `selectable: false` — an authoritative-sounding verdict of
    // absence, which is exactly the misreading this cross-linking exists to
    // prevent.
    let precomputeOk = true;
    if (saveRegions) {
      try {
        regions = await precomputeRegions(
          connection,
          snippet,
          model,
          toCompositionContext(args.composition_context),
          {
            force: refresh,
            proRefine,
            skyCtx: skyCtxFrom(built),
            faceMenu: faceMenuFor(model, hasPro),
          }
        );
      } catch {
        // Non-fatal — return the model without the precomputed menu, but say so
        // rather than letting the empty menu read as "nothing is selectable".
        precomputeOk = false;
      }
    } else {
      // The eager pass used to purge derived channels at the start of every
      // read, which is what stopped a mask outliving the pixels it described.
      // With that pass off by default the purge has to happen here, or a
      // sky replaced between two reads leaves `scene:sky` loadable by name.
      // Costs one round trip only when the document actually changed.
      try {
        await invalidateSceneChannelsIfStale(connection, model.provenance.cache_key);
      } catch {
        // Best-effort. Note the recovery is `ps_select_by_reference {refresh:true}`,
        // NOT refresh:true here: with the pixels unchanged this call returns at its
        // own guard and purges nothing, which is correct (identical pixels mean the
        // channels are not semantically stale).
      }
      regions = [...candidateMenu(model), ...faceMenuFor(model, hasPro)];
    }

    const content: ToolResult['content'] = [];
    if (annotate && built.decoded) {
      try {
        // Lift the horizon y into export-pixel space for the overlay.
        const exportH = built.exportImage.height || 0;
        const sy = model.doc.height > 0 ? exportH / model.doc.height : 1;
        const horizonExportY = Math.round(model.horizon.y * sy);
        const annotated = annotateScene(
          built.decoded,
          built.rawFaces,
          built.rawObjects.map((o) => o.bbox),
          horizonExportY
        );
        content.push({
          type: 'image' as const,
          data: annotated.toString('base64'),
          mimeType: 'image/jpeg',
        });
      } catch {
        // Non-fatal — return the structured model without the preview.
      }
    }
    const named = (r: RegionMenuItem): string => `${r.target}${r.label ? `:${r.label}` : ''}`;
    const menuText = !regions.length
      ? saveRegions
        ? ' No confident named regions detected here.'
        : ''
      : saveRegions
        ? ` Confident regions (select by name): ${regions
            .map(
              (r) => `${named(r)}${r.confidence === undefined ? '' : ` ${r.confidence.toFixed(2)}`}`
            )
            .join(', ')}.`
        : // Candidates, not verdicts — say so, or the model reads the list as a
          // guarantee each one will resolve and stops checking `passed`.
          ` Selectable by name (each resolved when you ask for it, not yet scored): ${regions
            .map(named)
            .join(', ')}.`;
    content.push({ type: 'text' as const, text: summarizeScene(model) + menuText });

    return {
      content,
      structuredContent: {
        ...(model as unknown as Record<string, unknown>),
        regions: reconcileRegions(
          model,
          regions,
          saveRegions ? (precomputeOk ? 'resolved' : 'unresolved') : 'candidate'
        ),
        region_menu: regions,
      },
    };
  } catch (error) {
    return toolErrorResult('Error reading scene', error);
  }
}

/**
 * Cross-link the coarse `regions[]` estimates with what `region_menu` actually
 * resolved, so the two can't be read as contradicting each other.
 *
 * `regions[]` is a cheap whole-frame HISTOGRAM split — sky is "mass above the
 * threshold". `region_menu` is the real gated selection, which on a Pro host
 * runs Sensei. They routinely disagree, and the coarse number is the misleading
 * one: live 2026-07-30 on a night cityscape, `regions[].sky.coverage` was 0.08
 * (a dark sky has almost no bright mass) while Sensei found a genuine sky at
 * 0.83 confidence covering the top 3,849px. An agent reading only `regions[]`
 * concludes there is no sky worth selecting and never tries.
 *
 * Each entry now carries `selectable` / `selectable_via` / `selectable_confidence`
 * pointing at the authoritative menu result, so the coarse coverage is visibly
 * an estimate rather than a verdict.
 *
 * Three menu modes, because "we didn't check" has two distinct causes that must
 * not be collapsed:
 * - `resolved`   — the eager pass ran; the menu is authoritative.
 * - `candidate`  — the default lazy read; the region is ADVERTISED and will be
 *                  scored when `ps_select_by_reference` asks for it.
 * - `unresolved` — the eager pass was requested and FAILED; we know nothing.
 */
type MenuMode = 'resolved' | 'candidate' | 'unresolved';

/**
 * The ONLY legal `regions[].selectable_state` values — the single source of
 * truth for both the producer below and the `outputSchema` that declares them.
 *
 * These were maintained by hand in two places, which the repo's derived-list
 * invariant forbids: a value added to the producer alone left the schema
 * under-declaring, and because the client validates the structured payload
 * against outputSchema, that rejects the WHOLE ps_read_scene response rather
 * than one field. The guard that was supposed to catch it compared the schema
 * against a list restated in the test, so it agreed with itself and passed.
 * Deriving both sides from here makes the producer's type the thing that fails
 * the build instead.
 */
export const SELECTABLE_STATES = [
  'selectable',
  'not_selectable',
  'candidate',
  'not_resolved',
] as const;

type SelectableState = (typeof SELECTABLE_STATES)[number];

/** The emitted shape. Typing `selectable_state` is what makes an undeclared
 *  value a compile error instead of a runtime schema-validation rejection. */
interface ReconciledRegion extends Record<string, unknown> {
  coverage_is_estimate: boolean;
  selectable: boolean | null;
  selectable_state: SelectableState;
}

function reconcileRegions(
  model: SceneModel,
  menu: RegionMenuItem[],
  mode: MenuMode
): ReconciledRegion[] {
  return model.regions.map((r) => {
    const base = r as unknown as Record<string, unknown>;
    // `selectable` is a TRISTATE and must never be a bare boolean|string: a
    // consumer writing `if (r.selectable)` would read the string 'unknown' as
    // truthy and treat a region we never resolved as confirmed-selectable.
    // null is falsy, so the unknown case degrades to "don't assume", and
    // `selectable_state` carries the distinction explicitly. A `candidate` is
    // null for the same reason — advertised is not verified.
    if (mode !== 'resolved') {
      const advertised = mode === 'candidate' && menu.some((m) => m.target === r.kind);
      return {
        ...base,
        coverage_is_estimate: true,
        selectable: null,
        selectable_state: advertised ? 'candidate' : 'not_resolved',
        ...(advertised ? { selectable_via: 'on_demand' } : {}),
      };
    }
    const hit = menu.find((m) => m.target === r.kind);
    return {
      ...base,
      // The histogram split is an ESTIMATE of extent, not a verdict on presence.
      coverage_is_estimate: true,
      selectable: hit !== undefined,
      selectable_state: hit !== undefined ? 'selectable' : 'not_selectable',
      ...(hit ? { selectable_via: hit.method, selectable_confidence: hit.confidence } : {}),
    };
  });
}

// ---------- ps_select_by_reference ----------

const selectByReferenceSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    target: {
      type: 'string',
      enum: [...SELECT_REFERENCE_TARGETS],
      description:
        "What to select by NAME (no coordinates): 'sky' (threshold white split), 'above_horizon' (everything above the horizon line), 'ground' / 'foliage' (posterize-region blob), 'subject' (the main detected object's region — use `label`/`instance` to target one of several), 'face' (the primary detected face), 'shadows' / 'highlights' (luminance bands), 'skin' (skin-tone colour range). Resolves to a real pixel selection on the original — prefer this over a rectangle for any natural region.",
    },
    label: {
      type: 'string',
      description:
        "For target=subject only: a COCO class ('person', 'dog', 'car', …) to pick instead of the largest subject. Ignored for other targets.",
    },
    instance: {
      type: 'integer',
      minimum: 0,
      description:
        'For target=subject only: 0-based index counting left-to-right among matching subjects (0 = leftmost). Omit to pick the main/largest.',
    },
    refresh: {
      type: 'boolean',
      default: false,
      description:
        'Force a fresh perception pass before resolving (default false uses the cached scene model for the current document state).',
    },
    max_dimension: {
      type: 'number',
      default: 1024,
      minimum: 256,
      maximum: 4096,
      description: 'Long-edge px of the perception export when a fresh pass runs.',
    },
    composition_context: {
      type: 'object',
      description:
        'Optional: tune the confidence gate from what you SEE in the preview, so an artistic shot is not rejected for breaking norms. The structural floor (coherence / horizon alignment) is never tuned; only the compositional priors are. `profile` is the easy knob: big_sky / minimal allow a large sky; big_foreground expects little sky; balanced (default) / tight_subject use defaults. Explicit overrides (`sky_coverage_max`, `pass_threshold`) win.',
      properties: {
        profile: {
          type: 'string',
          enum: ['balanced', 'big_sky', 'big_foreground', 'minimal', 'tight_subject'],
        },
        sky_coverage_max: { type: 'number', minimum: 0, maximum: 1 },
        ground_coverage_max: { type: 'number', minimum: 0, maximum: 1 },
        pass_threshold: { type: 'number', minimum: 0, maximum: 1 },
      },
    },
  },
  required: ['target'],
};

/** Map the snake_case composition_context arg → the scorer's CompositionContext. */
function toCompositionContext(raw: unknown): CompositionContext | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const ctx: CompositionContext = {};
  const PROFILES = ['balanced', 'big_sky', 'big_foreground', 'minimal', 'tight_subject'];
  if (typeof r.profile === 'string' && PROFILES.includes(r.profile)) {
    ctx.profile = r.profile as CompositionContext['profile'];
  }
  if (typeof r.sky_coverage_max === 'number') ctx.skyCoverageMax = r.sky_coverage_max;
  if (typeof r.ground_coverage_max === 'number') ctx.groundCoverageMax = r.ground_coverage_max;
  if (typeof r.pass_threshold === 'number') ctx.passThreshold = r.pass_threshold;
  return Object.keys(ctx).length ? ctx : undefined;
}

async function selectByReference(
  connection: PhotoshopConnection,
  snippet: SnippetClient,
  client: DetectionClient,
  rawArgs: Record<string, unknown>,
  proRefine?: ProRefine,
  detectDeps?: DetectActiveDocDeps
): Promise<ToolResult> {
  try {
    const args = validateArgs(selectByReferenceSchema, rawArgs);
    const target = args.target as SelectReferenceTarget;
    const refresh = (args.refresh as boolean) ?? false;

    // A `scene:<target>` channel is keyed by TARGET ALONE, so it cannot represent
    // "which subject" or "under which priors". When the caller narrows the
    // request, the channel is therefore not an answer to the question asked:
    //
    //   select{target:'subject', label:'dog'}  → derives the dog
    //   select{target:'subject'}               → wants the MAIN subject
    //
    // Sharing one `scene:subject` between those returns the dog for the second
    // call — with `passed:true, confidence:1` and no hint anything is wrong — and
    // the mirror case returns the main subject when the dog was asked for. Both
    // directions are silent, so a discriminated call neither READS nor WRITES the
    // shared channel; it always derives. `composition_context` counts because it
    // moves the gate, so a mask that passed under `profile:big_sky` must not come
    // back later as the default-priors answer.
    //
    // `max_dimension` is deliberately NOT in this set: it changes the derive's
    // FIDELITY, not its meaning — a sky traced at 4096 and one at 512 are both
    // answers to "the sky" — and it is always defined (schema default), so it
    // could not discriminate as written. The residual is that a deliberately
    // coarse derive can be loaded later by a default-resolution call.
    const discriminated =
      args.label !== undefined ||
      args.instance !== undefined ||
      args.composition_context !== undefined;

    // Fast path FIRST: if a prior derive saved a `scene:<target>` channel, load it
    // BY NAME — instant, and with NO perception rebuild (no export/detect).
    //
    // This reads no cache key, deliberately: consulting one would mean building
    // the scene model on every select, which is the entire cost the fast path
    // exists to avoid. The trade is that the channel is geometrically valid but
    // not necessarily semantically current — Photoshop keeps the mask aligned to
    // the canvas and has no idea the sky underneath was replaced. A scene read
    // purges on a pixel change (invalidateSceneChannelsIfStale); a
    // select→edit→select run with no read in between does not, and `refresh:true`
    // is the caller's way out. Said plainly in this tool's description too.
    if (!refresh && !discriminated) {
      const loaded = await loadPrecomputedRegion(connection, target);
      if (loaded) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Selected "${target}" from the saved scene:${target} channel (cached by an earlier derive). If the image changed since, re-run with refresh:true. Verify with ps_get_selection_preview.`,
            },
          ],
          structuredContent: {
            op: 'select_by_reference',
            target,
            method: 'precomputed_channel',
            passed: true,
            confidence: 1,
            reasons: ['loaded the saved scene:* channel by name'],
            selection_info: loaded.selection_info,
            detail: { from: 'precompute' },
            doc: { width: loaded.width, height: loaded.height },
          },
        };
      }
    }

    // No saved channel — derive on demand. Several targets (subject/face/sky/
    // ground/horizon) need the scene model, so build it once (cached) up front.
    const built = await buildSceneModel(connection, snippet, client, {
      useCache: !refresh,
      maxDimension: args.max_dimension as number | undefined,
      detectDeps,
    });

    const res = await resolveSelection(connection, snippet, built.model, target, {
      label: args.label as string | undefined,
      instance: args.instance as number | undefined,
      composition: toCompositionContext(args.composition_context),
      // proRefine (Sensei select_subject_instance) is the Pro injection point for
      // subject — wired via host.invokeTool when the Pro module is loaded/entitled
      // (and in dev for live-smoke); a CE host leaves it unset / the broker returns
      // false, so subject uses the box-posterize-wand fallback (honest absence).
      proRefine,
      // skyCtx enables the structural sky_ground_flood method for target=sky.
      skyCtx: skyCtxFrom(built),
    });

    // Materialize the lazily-advertised region: the derive above is the
    // expensive part (1-9s for a CE region, more for the face mesh), so persist
    // the result as its scene:* channel and every repeat select loads it by name
    // through the fast path instead of re-deriving. Only regions actually asked
    // for get a channel — that is the whole point of deferring them (see
    // `faceMenu` and PRECOMPUTE_TARGETS in region-precompute.ts).
    //
    // This covers EVERY target, not just face_*. It has to: once the eager
    // precompute stopped running by default, a CE region that did not persist
    // here would re-derive on every single select, turning a one-time cost into
    // a permanent per-call one. Demand-driven saving is also what keeps the old
    // memory hazard away — we write the one or two channels a session uses, not
    // all seven at full resolution.
    //
    // Best-effort: a failed save costs a re-derive next time, never the selection
    // the caller just asked for.
    // `!discriminated` for the reason above: persisting a narrowed derive under
    // the shared key is what makes the next un-narrowed call return the wrong
    // region. A discriminated select re-derives every time, which is exactly what
    // it did before this channel was persisted at all.
    if (res.passed && !discriminated) {
      try {
        await saveSelectionAsSceneChannel(connection, target);
      } catch (err) {
        logger.debug(
          `select_by_reference: could not persist ${CHANNEL_PREFIX}${target} — ` +
            `${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // Confidence-gated: a passing region is left selected; a failing one is
    // honestly absent (deselected) — like detection not inventing a dog.
    const conf = res.confidence.toFixed(2);
    const summary = res.passed
      ? `Selected "${target}" via ${res.method} (confidence ${conf}). Verify with ps_get_selection_preview.`
      : `No confident "${target}" in this image (confidence ${conf}, below the gate) — nothing selected. ${res.reasons.join('; ')}. If this is an artistic/non-standard composition, pass composition_context to relax the prior.`;

    return {
      content: [{ type: 'text' as const, text: summary }],
      structuredContent: {
        op: 'select_by_reference',
        target: res.target,
        method: res.method,
        passed: res.passed,
        confidence: res.confidence,
        reasons: res.reasons,
        selection_info: res.selection_info ?? null,
        detail: res.detail,
        doc: built.model.doc,
      },
    };
  } catch (error) {
    return toolErrorResult('Error in ps_select_by_reference', error);
  }
}

// ---------- factory ----------

export interface CreateSceneToolsOptions {
  /** DetectionClient override (tests inject a fake — the real ONNX backend
   *  needs weights and can't run headless in the unit harness). Defaults to a
   *  real OnnxDetectionClient. */
  client?: DetectionClient;
  /** The cross-module broker (HostApi §7). When supplied (Pro module loaded /
   *  entitled, or dev for live-smoke) subject resolves through Sensei's
   *  select_subject_instance and face features through the mesh tool; without
   *  it the resolver uses the CE fallback / honest absence. */
  invokeTool?: InvokeTool;
  /** Test-only seam: passed straight through to buildSceneModel's injected
   *  readFile/decode (see BuildSceneOptions.detectDeps), so a unit test can prove
   *  the pixel-identity warm cache without a real PS export on disk. Never set in
   *  production. */
  detectDeps?: DetectActiveDocDeps;
}

export function createSceneTools(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  opts: CreateSceneToolsOptions = {}
): ToolDefinition[] {
  const { client = new OnnxDetectionClient(), invokeTool, detectDeps } = opts;
  // Pro injection point: when the host supplies invokeTool (Pro module loaded /
  // entitled, or dev for live-smoke) subject resolves through Sensei's
  // select_subject_instance and face features through the mesh tool; without it
  // the resolver uses the CE fallback / honest absence.
  const proRefine = invokeTool ? makeProRefine(invokeTool) : undefined;
  // Gates only the face-feature ADVERTISEMENT in the region menu; the mesh runs
  // later, on demand, through the same proRefine broker.
  //
  // Must reflect whether the Pro mesh tool is REACHABLE, not merely whether the
  // broker exists: the CE module passes host.invokeTool unconditionally
  // (src/modules/ce/index.ts), so keying on the broker advertised 8 face_*
  // regions at confidence 1 to every CE user with a face in frame, none of
  // which they could select — a regression the old eager path never had (it
  // CALLED the Pro tool and returned [] on isError).
  //
  // Two independent ways ps_select_face_feature ('pro' tier) can be reachable,
  // and BOTH must count: the build edition already permits pro tools (dev/pro
  // hosts), OR a CE host has an entitled downloaded Pro module (the documented
  // CE-loads-modules path). Gating on entitlement ALONE silently dropped the
  // menu on a dev host where the mesh demonstrably worked — caught live
  // 2026-08-01 when face_teeth still materialized on demand but was no longer
  // advertised. Both are cached reads; neither costs a PS round trip.
  const proMeshReachable =
    isToolAllowedInEdition('ps_select_face_feature', EDITION) || isProEntitled();
  const hasPro = invokeTool !== undefined && proMeshReachable;
  return [
    {
      tool: {
        name: 'ps_read_scene',
        description:
          'The full scene model — run this before a spatially-targeted edit, not the cheaper ps_detect: detected subjects (with the main one flagged) and faces in document pixels, a coarse sky/ground region map, the horizon line (y + placement + confidence), tonal zones (shadow/midtone/highlight bands + coverage), composition geometry (which thirds cell the subject sits in, balance, headroom), plus an annotated preview and the menu of selectable named regions. Built using LOCAL on-device vision + classical CV; the image never leaves the machine. Select regions by name with ps_select_by_reference instead of guessing a rectangle. Read-only: renders a throwaway duplicate. Perception is cached per document state, so repeated reads are cheap.',
        inputSchema: sceneSchema,
        outputSchema: {
          type: 'object',
          properties: {
            doc: { type: 'object' },
            subjects: { type: 'array', items: { type: 'object' } },
            faces: { type: 'array', items: { type: 'object' } },
            regions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  kind: { type: 'string' },
                  coverage: { type: 'number' },
                  coverage_is_estimate: {
                    type: 'boolean',
                    description:
                      'Always true today: `coverage` is the coarse histogram split, never a measured mask. It and the real selection routinely disagree (a night shot read sky at 0.08 while the gated selection found a real sky at 0.83) — trust `selectable_confidence` and the precomputed channel over this number. Carried as a field rather than left implicit so a future measured-coverage path can report false.',
                  },
                  selectable: {
                    type: ['boolean', 'null'],
                    description:
                      'Tristate as null when the region was never resolved — never read this as a plain boolean; branch on `selectable_state`.',
                  },
                  selectable_state: {
                    type: 'string',
                    enum: [...SELECTABLE_STATES],
                    description:
                      '`selectable`: a precomputed channel is ready to load. `not_selectable`: resolution ran and this region did not pass the confidence gate. `candidate`: the DEFAULT read advertised this region without deriving it — ps_select_by_reference scores it when you ask, and it may still turn out not to pass. `not_resolved`: an eagerly-requested precompute did not run or failed, so absence here is NOT evidence the region is unavailable.',
                  },
                  selectable_via: {
                    type: 'string',
                    description:
                      "The method that resolved it, when one did. Reads 'on_demand' for a `candidate` — nothing has resolved it yet and the method is chosen at derive time.",
                  },
                  selectable_confidence: { type: 'number' },
                },
              },
            },
            region_menu: { type: 'array', items: { type: 'object' } },
            horizon: { type: 'object' },
            tonal_zones: { type: 'object' },
            composition: { type: 'object' },
            provenance: { type: 'object' },
          },
        },
        annotations: {
          title: 'Scene Model (perception)',
          readOnlyHint: true,
          idempotentHint: true,
        },
      },
      handler: async (args) =>
        scene(connection, snippetClient, client, args, proRefine, hasPro, detectDeps),
    },
    {
      tool: {
        name: 'ps_select_by_reference',
        description:
          'Select a region by NAME instead of coordinates — the natural-mask alternative to a rectangle — with a CONFIDENCE GATE. target=sky/ground/foliage/subject/face/shadows/highlights/skin/above_horizon resolves through the right Photoshop-native method (threshold for sky, invert-sky−subjects for ground, luminance for shadows/highlights, skin-tone colour ∩ the subject box, the detected face/subject box) and is SCORED before it is offered: a clean region is left selected; an unconfident one is NOT selected and reported as honest absence (the city with no real sky gets no sky). Pro adds precise FACE-FEATURE targets backed by the face mesh — face_skin (the retouch mask: face minus eyes/brows/lips), face_eyes, face_brows, face_lips, face_teeth (mouth opening), face_nose, face_under_eye, face_cheeks — each a real geometry-following selection, derived on first request and then saved as a scene:face_* channel so repeats load instantly. `passed`/`confidence` are returned. A region derived here is cached as a `scene:*` channel keyed by TARGET ONLY, so a later call for the same target loads it by name; pass `refresh:true` to force a fresh derive after an edit that changes what the region means, and note that narrowing a call with `label`/`instance`/`composition_context` always derives (it neither reads nor writes that shared channel). The structural floor (coherence, horizon alignment) is never tuned; for an artistic/non-standard shot pass `composition_context` (e.g. profile:big_sky) to relax the compositional priors so a legitimately large sky is not rejected. For target=subject with several present, pass `label` and/or `instance`. Build/inspect with ps_read_scene first; verify with ps_get_selection_preview (the red-overlay is the human/agent oversight view). Prefer this over a rectangle for any real-world region.',
        inputSchema: selectByReferenceSchema,
        outputSchema: {
          type: 'object',
          properties: {
            op: { type: 'string' },
            target: { type: 'string' },
            method: { type: 'string' },
            passed: { type: 'boolean' },
            confidence: { type: 'number' },
            reasons: { type: 'array', items: { type: 'string' } },
            selection_info: { type: ['object', 'null'] },
            detail: { type: 'object' },
            doc: { type: 'object' },
          },
        },
        annotations: {
          title: 'Select by Reference',
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      handler: async (args) =>
        selectByReference(connection, snippetClient, client, args, proRefine, detectDeps),
    },
  ];
}
