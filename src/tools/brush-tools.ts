import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import type { SnippetClient } from '../api/snippet-client.js';
import { SUPPORTED_BRUSH_TOOLS } from '../api/brush-tool-names.js';
import { runScript } from '../utils/run-script.js';
import { validateArgs, type JsonSchemaObject } from '../utils/validate.js';
import { toolErrorResult, applyToActiveLayerProp } from '../utils/tool-helpers.js';
import { type DetectionClient } from '../detection/detection-client.js';
import { OnnxLandmarkDetectionClient } from '../detection/landmark-detection-client.js';
import { resolveExpectedPlacement, PLACEMENT_SCHEMA } from '../perception/grounding-locate.js';

// Path-driven brush-family stroke. One unified
// tool covers the 16 ToolType constants accepted by PathItem.strokePath
// on PS 27.x — the seven retouch tools (healing brush, clone stamp,
// burn, dodge, blur, sharpen, smudge) plus nine paint/erase/specialty
// tools. Snippet:
// src/api/extendscript/brushes.ts.

const TOOLS_REQUIRING_SOURCE = ['clone_stamp', 'healing_brush'] as const;

const applyBrushStrokeSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    tool: {
      type: 'string',
      enum: SUPPORTED_BRUSH_TOOLS,
      description:
        'Which brush-family tool to dispatch. Headline retouch options: `healing_brush` and `clone_stamp` (both REQUIRE `source_point` — set the sample location, then stroke the path); `burn` darkens; `dodge` lightens; `blur` smooths; `sharpen` enhances local contrast; `smudge` pushes pixels in the stroke direction. Paint family: `brush` (the standard paintbrush — honors `foreground_color`), `pencil` (hard-edge), `eraser`. Specialty: `pattern_stamp`, `art_history_brush`, `history_brush`, `color_replacement`, `background_eraser`, `sponge`.',
    },
    placement: {
      ...PLACEMENT_SCHEMA,
      description:
        'ANCHOR-RELATIONAL stroke path (preferred over supplying pixels): a PATH relation — `along` a traced edge ' +
        'or a Pro face-mesh landmark curve, `offset-curve`, or `segment` between two anchors — so the stroke traces ' +
        'the resolved, gate-verified curve (the FULL polyline, not just endpoints: paint along the jaw / horizon / ' +
        'under-eye). Strokes ONLY if the gate PASSES. When set, `path` is ignored; tool/brush_size/source_point/' +
        'colors/dynamics/jitter still apply. See ps_resolve_placement for the anchors + relation vocabulary.',
    },
    path: {
      type: 'array',
      description:
        "Ordered list of anchor points the stroke traces. **Minimum 2 anchors.** Each anchor is `{x, y}` for a sharp corner OR `{x, y, in: [hx, hy], out: [hx, hy]}` for a smooth bezier point. The `in` and `out` handles MUST be positioned **tangent** to the curve at the anchor — `in` placed in the direction of the PREVIOUS anchor in the array, `out` placed in the direction of the NEXT anchor. Handles placed RADIALLY (toward/away from the shape's center) produce loops + concave curves instead of smooth convex ones. Mix corner + smooth points freely. Coordinates are document pixels; (0, 0) is top-left. Partial handles (only `in` OR only `out`) degrade to a sharp corner. **Recipes for common natural-stroke shapes** (compute these client-side and emit the resulting `[{x, y}, ...]` array): (1) **Hand-drawn straight line A→B with sketchy feel**: sample 8-30 evenly-spaced corner anchors along the line, then perturb each interior anchor by ±2-5px on the perpendicular axis — OR pass clean anchors and use `jitter_px` to apply the perturbation server-side (preferred — cheaper, deterministic). (2) **Sine wave A→B, amplitude a, periods n**: for i in 0..N, x_i = A.x + (i/N)*(B.x - A.x), y_i = A.y + a * sin((i/N) * 2π * n). Use 20-40 anchors for a smooth wave. (3) **Parabolic arc A→B peaking height h above midline**: for i in 0..N, t = i/N, x_i = lerp(A.x, B.x, t), y_i = lerp(A.y, B.y, t) - 4*h*t*(1-t). (4) **Canonical clockwise circle of radius r around (cx, cy)** with k = r * 0.5523: TOP `{x: cx, y: cy-r, in: [cx-k, cy-r], out: [cx+k, cy-r]}`, RIGHT `{x: cx+r, y: cy, in: [cx+r, cy-k], out: [cx+r, cy+k]}`, BOTTOM `{x: cx, y: cy+r, in: [cx+k, cy+r], out: [cx-k, cy+r]}`, LEFT `{x: cx-r, y: cy, in: [cx-r, cy+k], out: [cx-r, cy-k]}` — close with `closed: true`. (5) **Many short overlapping strokes for ink-on-paper texture**: chain multiple `apply_brush_stroke` calls along the same trajectory with small position offsets and varying `brush_size`; reads more natural than one long stroke.",
      items: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'Anchor x in document pixels.' },
          y: { type: 'number', description: 'Anchor y in document pixels.' },
          in: {
            type: 'array',
            description:
              'Control handle [hx, hy] positioned in the direction of the PREVIOUS anchor in the array, **tangent** to the curve at this anchor (NOT radial). Required together with `out` for the anchor to be smooth; otherwise the anchor is a sharp corner.',
            items: { type: 'number' },
          },
          out: {
            type: 'array',
            description:
              'Control handle [hx, hy] positioned in the direction of the NEXT anchor in the array, **tangent** to the curve at this anchor.',
            items: { type: 'number' },
          },
        },
        required: ['x', 'y'],
      },
    },
    brush_size: {
      type: 'integer',
      description:
        'Brush tip diameter in pixels. Typical retouch values: 12-30 for fine work, 50-100 for filling, 150+ for broad strokes. Verified scriptable via `setd Brsh.Trgt masterDiameter` in the 2026-06-09 spike.',
      minimum: 1,
      maximum: 5000,
    },
    brush_preset: {
      type: 'string',
      description:
        'Optional brush-preset name to select before stroking (e.g. "Soft Round", "Hard Round", or any custom preset the user has loaded). The preset\'s saved hardness, opacity, flow, and shape dynamics load with the slct dispatch — set the preset for a coherent character (soft vs hard, calligraphic vs round), then optionally override individual values via `hardness_pct` / `opacity_pct` / `flow_pct`. If the named preset is not installed, the tool falls back to "Soft Round" then "Hard Round" (both ship on every install) and reports which one landed via `preset_applied` in the result.',
    },
    hardness_pct: {
      type: 'number',
      description:
        "Optional brush hardness override (percent, 0-100). When set, mutates the live tool's hardness via the `currentToolOptions.brush.hardness` get-mutate-set pattern AFTER any brush_preset has loaded — so the preset's hardness is what you start from and this overrides it. **Computed brushes only**: Soft Round / Hard Round / Calligraphic / etc. accept the mutation; **sampled brushes** (custom shape-stamp presets loaded from .abr files) silently ignore it because their shape isn't parametric. The user's original tool options are restored in `finally` so this doesn't leak to their next non-LLM brush action.",
      minimum: 0,
      maximum: 100,
    },
    opacity_pct: {
      type: 'number',
      description:
        "Optional brush opacity override (percent, 0-100). Routed through `currentToolOptions.opacity` (a top-level integer key on the tool options descriptor, not nested inside the brush sub-descriptor). Applies to the WHOLE stroke uniformly — varying-opacity strokes require chaining multiple `apply_brush_stroke` calls. Restored to the user's original value in `finally`.",
      minimum: 1,
      maximum: 100,
    },
    flow_pct: {
      type: 'number',
      description:
        "Optional brush flow override (percent, 0-100). Routed through `currentToolOptions.flow` (top-level integer key). Flow controls how much paint each stroke step deposits — for paint-family tools (`brush`, `pencil`, `pattern_stamp`), low flow means the stroke needs multiple overlapping passes to reach full opacity; high flow saturates immediately. Restored to the user's original value in `finally`.",
      minimum: 1,
      maximum: 100,
    },
    source_point: {
      type: 'object',
      description:
        'Sample point for `clone_stamp` / `healing_brush` — the pixel location PS samples from while the stroke progresses. REQUIRED for those two tools (unless `source_placement` names it instead). Ignored for all others. `layer_name` defaults to the active layer at call time when omitted.',
      properties: {
        x: { type: 'number', description: 'Source x in document pixels.' },
        y: { type: 'number', description: 'Source y in document pixels.' },
        layer_name: {
          type: 'string',
          description: 'Name of the layer PS should sample from. Defaults to the active layer.',
        },
      },
      required: ['x', 'y'],
    },
    source_placement: {
      ...PLACEMENT_SCHEMA,
      description:
        'Grounded alternative to `source_point` for `clone_stamp` / `healing_brush`: NAME the sample location (resolves to a POINT via the grounding resolver + objective gate — e.g. an `extremum` for the cleanest/smoothest nearby skin, a `grid` intersection, or a landmark point) instead of guessing pixels. Resolves to a POINT relation (centroid / midpoint / offset / extremum / grid / landmark point); the resolved point supplies `source_point` and WINS over an explicit `source_point`. Strokes only if the source gate PASSES.',
    },
    foreground_color: {
      type: 'object',
      description:
        "RGB foreground color for paint-family tools (`brush`, `pencil`). The retouch family (`burn`/`dodge`/`blur`/`sharpen`/`smudge`/`clone_stamp`/`healing_brush`) ignores foreground color — setting it on those tools is harmless but pointless. The user's previous foreground color is restored after the stroke completes.",
      properties: {
        red: { type: 'integer', minimum: 0, maximum: 255 },
        green: { type: 'integer', minimum: 0, maximum: 255 },
        blue: { type: 'integer', minimum: 0, maximum: 255 },
      },
      required: ['red', 'green', 'blue'],
    },
    closed: {
      type: 'boolean',
      description:
        'When true, the path is closed (last anchor connects back to first) so the stroke forms a loop. Default false.',
      default: false,
    },
    jitter_px: {
      type: 'number',
      description:
        'Server-side hand-drawn perturbation. When > 0, the handler shifts every INTERIOR anchor (not the first, not the last — those stay exactly where you placed them) by a deterministic pseudo-random offset in `[-jitter_px, +jitter_px]` on each axis BEFORE stroking. Bezier handles ride along with their anchor so curve tangents are preserved. Same inputs produce the same emitted shape every call. **Reach for this when** you want a clean intent (mathematically perfect line, sine wave, arc) to read as hand-drawn ink without writing the jitter math yourself. Typical values: 2-5 for subtle ink texture, 5-10 for visibly sketchy, 10-20 for cartoonish/scratchy. Default 0 (no jitter).',
      minimum: 0,
      maximum: 50,
      default: 0,
    },
    apply_to_active_layer: applyToActiveLayerProp('the stroke'),
  },
  // `path` is required UNLESS `placement` is supplied — enforced in the handler
  // (a JSON schema can't express the exclusive-or, and required-path would reject placement).
  required: ['tool', 'brush_size'],
};

export function createBrushTools(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  // Backs anchor-relational `placement`; only used when a placement is supplied
  // (a raw `path` stroke never touches it).
  client: DetectionClient = new OnnxLandmarkDetectionClient()
): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'ps_apply_brush_stroke',
        description:
          'Paint along a path with one of PS\'s 16 brush-family tools — supply the path EITHER as an anchor-relational `placement` (preferred: a path relation → the stroke traces a resolved, gate-verified curve along a traced edge / landmark / between two anchors, no pixel-guessing) OR as an explicit `path` list of anchor points — the retouch tools (`healing_brush`, `clone_stamp`, `burn`, `dodge`, `blur`, `sharpen`, `smudge`), the paint family (`brush`, `pencil`, `eraser`), and the specialty tools (`pattern_stamp`, `art_history_brush`, `history_brush`, `color_replacement`, `background_eraser`, `sponge`). The `path` parameter takes a list of anchor points with optional bezier handles, so the same tool handles straight-line strokes, freeform curves, and closed shapes — all by varying the path geometry. **Reach for this when**: (a) cloning out a distraction along a specific shape (clone_stamp with a source_point + a path tracing the unwanted edge); (b) healing a scratch or seam (healing_brush with source_point); (c) dodging / burning to redirect tonal balance along a contour; (d) painting a freehand line into the canvas (brush + foreground_color). Active layer must be a normal pixel layer (background auto-promotes); rasterize adjustment/shape/text/smart-object layers first. Auto-duplicates — the original is preserved and a "Brush Stroke (<name>)" copy receives the paint. **Brush dynamics**: hardness, opacity, and flow are independently settable via `hardness_pct` / `opacity_pct` / `flow_pct` (the live tool options are mutated before stroking and restored to the user\'s prior state in `finally`). Sampled brushes (custom shape-stamp presets) silently ignore hardness/diameter mutations — vary their character via `brush_preset` instead.',
        inputSchema: applyBrushStrokeSchema,
        outputSchema: {
          type: 'object',
          properties: {
            stroked: { type: 'boolean' },
            tool: { type: 'string' },
            tool_type: { type: 'string' },
            brush_size: { type: 'number' },
            preset_applied: {
              description:
                'Name of the brush preset that actually landed — equal to `brush_preset` if installed, "Soft Round" / "Hard Round" if a fallback fired, null when no preset was requested.',
            },
            size_applied: { type: 'boolean' },
            hardness_applied: { type: 'boolean' },
            opacity_applied: { type: 'boolean' },
            flow_applied: { type: 'boolean' },
            clone_source_set: { type: 'boolean' },
            anchors: { type: 'number' },
            closed: { type: 'boolean' },
            path_removed: { type: 'boolean' },
            background_promoted: { type: 'boolean' },
            target_was_copy: { type: 'boolean' },
            target_layer_name: { type: 'string' },
            original_layer_name: { type: 'string' },
            stroke_envelope: {
              type: 'object',
              description:
                'The doc-pixel bbox the stroke should occupy (path bbox + brush radius) — the objective target to verify stroke occupancy against.',
            },
            placement: {
              type: 'object',
              description:
                'Present when the stroke path came from anchor-relational placement: the resolved curve + gate verdict.',
              properties: {
                target: { type: 'string' },
                gate: { type: 'object' },
                anchors: { type: 'object' },
                points: { type: 'number' },
              },
            },
            source_placement: {
              type: 'object',
              description:
                'Present when the clone/heal sample point came from a source_placement: the resolved point + gate verdict.',
            },
            context: { type: 'object' },
          },
        },
        annotations: {
          title: 'Apply Brush Stroke',
          destructiveHint: true,
          idempotentHint: false,
        },
      },
      handler: async (args) => applyBrushStroke(connection, snippetClient, client, args),
    },
  ];
}

interface BrushAnchor {
  x: number;
  y: number;
  in?: [number, number];
  out?: [number, number];
}

async function applyBrushStroke(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  client: DetectionClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(applyBrushStrokeSchema, rawArgs);
    const tool = args.tool as string;

    // Schema-side guard for the source-required tools, checked BEFORE resolving a
    // placement so clone_stamp/healing_brush fail fast without a wasted CV round-trip.
    // The snippet also enforces this (defense in depth); surfacing it here gives a
    // cleaner LLM-facing message on the MCP `isError` path.
    if (
      (TOOLS_REQUIRING_SOURCE as readonly string[]).includes(tool) &&
      !args.source_point &&
      !args.source_placement
    ) {
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `${tool} requires a sample location — set source_point ({x, y, layer_name?}) or name it ` +
              `via source_placement (resolved + gated) before stroking. (Healing brush and clone stamp ` +
              `both need to know what to copy from.)`,
          },
        ],
        isError: true,
      };
    }

    // Stroke path from anchor-relational placement (resolved + gated) OR the raw
    // `path`. A resolved curve is a corner-anchor polyline (no bezier handles).
    let path: BrushAnchor[];
    let placementInfo:
      | {
          target: string;
          anchors: Record<string, { kind: string; center: { x: number; y: number } }>;
          points: number;
        }
      | undefined;
    if (args.placement) {
      const rp = await resolveExpectedPlacement(
        connection,
        client,
        args.placement,
        'path',
        `${tool} stroke`
      );
      path = rp.curve.map((p) => ({ x: p.x, y: p.y }));
      placementInfo = { target: rp.target, anchors: rp.anchors, points: rp.curve.length };
    } else {
      path = args.path as BrushAnchor[];
      if (!Array.isArray(path) || path.length < 2) {
        throw new Error(
          'path needs at least 2 anchors, or a placement (anchors + a path relation).'
        );
      }
    }
    const brush_size = args.brush_size as number;
    const brush_preset = args.brush_preset as string | undefined;
    // Grounded clone/heal SAMPLE point: a source_placement (resolved point + gate)
    // names the sample location instead of guessing source_point pixels; it wins.
    let source_point = args.source_point as
      { x: number; y: number; layer_name?: string } | undefined;
    let sourcePlacementInfo: { target: string; point: { x: number; y: number } } | undefined;
    if (args.source_placement) {
      const sp = await resolveExpectedPlacement(
        connection,
        client,
        args.source_placement,
        'point',
        `${tool} source`
      );
      source_point = { x: sp.point.x, y: sp.point.y };
      sourcePlacementInfo = { target: sp.target, point: sp.point };
    }
    const foreground_color = args.foreground_color as
      { red: number; green: number; blue: number } | undefined;
    const closed = (args.closed as boolean | undefined) ?? false;
    const jitter_px = (args.jitter_px as number | undefined) ?? 0;
    const hardness_pct = args.hardness_pct as number | undefined;
    const opacity_pct = args.opacity_pct as number | undefined;
    const flow_pct = args.flow_pct as number | undefined;
    const apply_to_active_layer = (args.apply_to_active_layer as boolean | undefined) ?? false;

    // Apply hand-drawn jitter to interior anchors BEFORE snippet build.
    // Server-side keeps the snippet simple and lets unit tests pin exact
    // emitted coordinates (the noise function is deterministic by design).
    const pathToStroke = jitter_px > 0 ? applyJitter(path, jitter_px) : path;

    const script = await snippetClient.build('applyBrushStroke', {
      tool,
      path: pathToStroke,
      brush_size,
      brush_preset,
      source_point,
      foreground_color,
      closed,
      apply_to_active_layer,
      hardness_pct,
      opacity_pct,
      flow_pct,
    });
    const result = (await runScript(connection, script)) as {
      stroked: boolean;
      tool: string;
      tool_type: string;
      brush_size: number;
      preset_applied: string | null;
      size_applied: boolean;
      hardness_applied: boolean;
      opacity_applied: boolean;
      flow_applied: boolean;
      clone_source_set: boolean;
      anchors: number;
      closed: boolean;
      path_removed: boolean;
      background_promoted: boolean;
      target_was_copy: boolean;
      target_layer_name: string;
      original_layer_name: string;
      context?: Record<string, unknown>;
    };

    const presetSuffix = result.preset_applied ? ` (preset: ${result.preset_applied})` : '';
    const sourceSuffix = result.clone_source_set ? ' with clone source set' : '';
    const targetSuffix = result.target_was_copy
      ? ` on copy "${result.target_layer_name}"`
      : ` on layer "${result.target_layer_name}"`;

    const placementSuffix = placementInfo ? ' via placement (gate PASS)' : '';

    // Objective target for the CHECK step: the doc-pixel rect the stroke should occupy
    // (the stroked path's bbox, expanded by the brush radius). Gives the caller a
    // concrete envelope to verify occupancy against (ps_get_preview annotation /
    // ps_compare_regions) instead of eyeballing. NOTE: this is the EXPECTED envelope,
    // not a measured read-back — a pixel-level measured post-check would need a
    // before/after content diff (dodge/burn modify pixels; the Bundle-O copy holds the
    // whole layer, so bounds don't isolate the stroke); deferred as high-cost.
    const xs = pathToStroke.map((a) => a.x);
    const ys = pathToStroke.map((a) => a.y);
    const rad = result.brush_size / 2;
    const strokeEnvelope = {
      left: Math.round(Math.min(...xs) - rad),
      top: Math.round(Math.min(...ys) - rad),
      right: Math.round(Math.max(...xs) + rad),
      bottom: Math.round(Math.max(...ys) + rad),
    };

    const structured: Record<string, unknown> = {
      ...(result as unknown as Record<string, unknown>),
      stroke_envelope: strokeEnvelope,
    };
    if (placementInfo) {
      structured.placement = {
        target: placementInfo.target,
        gate: { pass: true },
        anchors: placementInfo.anchors,
        points: placementInfo.points,
      };
    }
    if (sourcePlacementInfo) {
      structured.source_placement = {
        target: sourcePlacementInfo.target,
        gate: { pass: true },
        point: {
          x: Math.round(sourcePlacementInfo.point.x),
          y: Math.round(sourcePlacementInfo.point.y),
        },
      };
    }
    const srcPlaceSuffix = sourcePlacementInfo ? ' [source via placement, gate PASS]' : '';

    return {
      content: [
        {
          type: 'text' as const,
          text:
            `${tool} stroke (${result.anchors} anchors, size ${result.brush_size}px${presetSuffix})` +
            `${sourceSuffix}${srcPlaceSuffix}${targetSuffix}${placementSuffix}. Expected envelope ` +
            `[${strokeEnvelope.left},${strokeEnvelope.top},${strokeEnvelope.right},${strokeEnvelope.bottom}] — ` +
            `verify occupancy there (ps_get_preview / ps_compare_regions).`,
        },
      ],
      structuredContent: structured,
    };
  } catch (error) {
    return toolErrorResult('Error applying brush stroke', error);
  }
}

// ---------- jitter helpers ----------

/**
 * Deterministic pseudo-random value in [-1, 1] from three inputs (anchor
 * index + anchor coordinates + axis salt). Same inputs always produce
 * the same output so unit tests can pin emitted coordinates and the LLM
 * can re-run a call with the same args and get the same stroke shape.
 *
 * Implementation is the well-known `sin·fract` hash from graphics
 * literature — `Math.sin(seed) * 43758.5453` then take the fractional
 * part. It's not cryptographic, but it produces visually uncorrelated
 * jitter across nearby anchors, which is what we want for hand-drawn
 * texture.
 */
function deterministicNoise(i: number, anchorSeed: number, axisSalt: number): number {
  const v = Math.sin(i * 12.9898 + anchorSeed * 78.233 + axisSalt * 37.719) * 43758.5453;
  return (v - Math.floor(v)) * 2 - 1;
}

/**
 * Shift every INTERIOR anchor (not first, not last) by a deterministic
 * pseudo-random offset in `[-jitter_px, +jitter_px]` on each axis. Bezier
 * handles ride along with their anchor so curve tangents are preserved
 * (the segment between two anchors keeps its smooth shape — just at a
 * slightly different position).
 *
 * Endpoints are left untouched so the LLM's stated start/end stay exact.
 *
 * The noise seed mixes the anchor's existing coordinates so a given
 * anchor at (100, 200) gets a different jitter than the same anchor at
 * (101, 200) — small input shifts produce visibly different output,
 * which is what makes consecutive strokes along a similar trajectory
 * read as separate hand-drawn passes instead of obvious repeats.
 */
function applyJitter(
  path: Array<{
    x: number;
    y: number;
    in?: [number, number];
    out?: [number, number];
  }>,
  jitterPx: number
): typeof path {
  if (jitterPx <= 0 || path.length < 3) return path;
  return path.map((p, i) => {
    if (i === 0 || i === path.length - 1) return p;
    const anchorSeed = p.x * 0.0173 + p.y * 0.0297;
    const jx = jitterPx * deterministicNoise(i, anchorSeed, 1);
    const jy = jitterPx * deterministicNoise(i, anchorSeed, 2);
    return {
      ...p,
      x: p.x + jx,
      y: p.y + jy,
      ...(p.in ? { in: [p.in[0] + jx, p.in[1] + jy] as [number, number] } : {}),
      ...(p.out ? { out: [p.out[0] + jx, p.out[1] + jy] as [number, number] } : {}),
    };
  });
}
