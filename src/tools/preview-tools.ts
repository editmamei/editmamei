import { readFile } from 'node:fs/promises';
import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import type { SnippetClient } from '../api/snippet-client.js';
// getContextInfo / normNameHelper are generic helpers (not snippet IP); they
// stay in the shipped bundle via _helpers.js. Imported directly here (not via
// the extendscript assembler, which the Go-sidecar seal excludes from build).
import {
  getContextInfo,
  normNameHelper,
  notFoundMessageHelper,
} from '../api/extendscript/_helpers.js';
import { jsLit, jsNum } from '../utils/jsx.js';
import { runScript } from '../utils/run-script.js';
import { TempDir, userOwnedTempRoot } from '../utils/temp.js';
import { validateArgs, type JsonSchemaObject } from '../utils/validate.js';
import { ANNOTATED_PREVIEW_TIMEOUT_MS } from '../utils/operation-timeouts.js';
import { toolErrorResult, runSnippetTool } from '../utils/tool-helpers.js';

// Verification primitives. The LLM is reliable at
// parametric verification (does the histogram show warmer tones? yes), but
// falls apart on spatial / compositional verification (did the placed
// image land inside the frame interior?). Three additions:
//
// 1. `ps_get_preview` gains an optional `annotations` array — the
//    LLM passes rectangles / guides / points / selection markers in
//    document coordinates and they get drawn onto the rendered preview.
//    Turns "did this land right?" (a fine spatial estimation problem the
//    VLM is bad at) into "is the red rectangle aligned with the placed
//    image edges?" (a coarse semantic comparison the VLM is good at).
//
// 2. `ps_get_layer_bounds_diff` — numeric verification of layer
//    placement vs a target rect. Returns per-edge deltas + scale ratio +
//    centroid offset + a one-word verdict.
//
// 3. `ps_compare_regions` — histogram + pixel-stats compare of
//    two rect regions on the same doc. Single-pixel sampling (1×1 rect)
//    is supported.

// ---------- annotations schema ----------

const COLOR_NAME_HEX: Record<string, string> = {
  red: '#FF0000',
  blue: '#0066FF',
  green: '#00CC00',
  yellow: '#FFCC00',
  magenta: '#FF00FF',
  cyan: '#00CCFF',
  white: '#FFFFFF',
  black: '#000000',
  orange: '#FF8800',
};

function normalizeColor(input: string | undefined, fallback = '#FF0000'): string {
  if (!input) return fallback;
  if (input.startsWith('#') && (input.length === 7 || input.length === 4)) return input;
  return COLOR_NAME_HEX[input.toLowerCase()] ?? fallback;
}

const annotationSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: ['rectangle', 'guide', 'point', 'selection', 'grid', 'composition'],
      description:
        'Annotation type. `rectangle` / `guide` / `point` / `selection` are spatial verification overlays. `grid` draws a regular grid (every-N-pixels, rule of thirds, quarters, or phi/golden-ratio lines) for coordinate readout. `composition` draws photographic composition guides (diagonals, triangles, fibonacci_grid, golden_spiral) for evaluating image balance.',
    },
    // rectangle: explicit bounds OR a layer name
    left: { type: 'number', description: 'rectangle: left edge in document pixels.' },
    top: { type: 'number', description: 'rectangle: top edge in document pixels.' },
    right: { type: 'number', description: 'rectangle: right edge in document pixels.' },
    bottom: { type: 'number', description: 'rectangle: bottom edge in document pixels.' },
    layer: {
      type: 'string',
      description:
        'rectangle: name of a layer to draw a wireframe around. The tool reads the bounds from the layer tree internally — no need to pass coordinates. Bounds use boundsNoEffects (raw pixel bounds, not including layer style effects).',
    },
    // guide
    orientation: {
      type: 'string',
      enum: ['horizontal', 'vertical'],
      description: 'guide: horizontal or vertical reference line.',
    },
    pixel: {
      type: 'number',
      description:
        'guide: position in document pixels. Use this OR canvas_pct. If both, pixel wins.',
    },
    canvas_pct: {
      type: 'number',
      description:
        'guide: position as a fractional 0-1 of the canvas dimension (0.5 = centerline). Easier when the LLM does not yet know the doc dimensions.',
      minimum: 0,
      maximum: 1,
    },
    // point
    x: { type: 'number', description: 'point: x coordinate in document pixels.' },
    y: { type: 'number', description: 'point: y coordinate in document pixels.' },
    marker: {
      type: 'string',
      enum: ['cross', 'dot', 'crosshair'],
      description: 'point: marker shape. Default cross.',
      default: 'cross',
    },
    // grid + composition
    style: {
      type: 'string',
      enum: [
        // grid styles
        'every',
        'thirds',
        'quarters',
        'phi',
        // composition styles
        'diagonals',
        'triangles',
        'fibonacci_grid',
        'golden_spiral',
      ],
      description:
        'grid: `every` (regular every-N-px grid; takes `spacing_px`), `thirds` (2x2 rule-of-thirds lines), `quarters` (center crosshair), `phi` (lines at 0.382/0.618 — golden-ratio analog of thirds). composition: `diagonals` (corner-to-corner X), `triangles` (diagonal + perpendiculars from opposite corners), `fibonacci_grid` (nested golden-ratio rectangles from the named corner), `golden_spiral` (fibonacci_grid plus the iconic spiral curve through it). For composition styles, use `orientation_corner` to set which corner the spiral / grid originates from.',
    },
    spacing_px: {
      type: 'integer',
      description: 'grid (style=every): grid line spacing in document pixels. Default 50.',
      minimum: 10,
      maximum: 4000,
      default: 50,
    },
    orientation_corner: {
      type: 'string',
      enum: ['tl', 'tr', 'bl', 'br'],
      description:
        'composition (fibonacci_grid / golden_spiral): which corner the spiral originates from. `tl` = top-left (spiral expands clockwise from there), `tr` = top-right (counterclockwise), `bl` = bottom-left (counterclockwise), `br` = bottom-right (clockwise). Default `tl`.',
      default: 'tl',
    },
    // styling (all annotation types)
    color: {
      type: 'string',
      description:
        'Annotation color. Either a named color (red / blue / green / yellow / magenta / cyan / orange / white / black) or a hex string (#RRGGBB). Default red.',
    },
    label: {
      type: 'string',
      description:
        'Optional text label drawn near the annotation. Useful for naming what each rectangle represents ("target", "actual", "frame interior", etc.) when multiple annotations appear on the same preview.',
    },
    stroke_width: {
      type: 'number',
      description: 'Stroke width in document pixels. Default 4.',
      minimum: 1,
      maximum: 100,
      default: 4,
    },
  },
  required: ['type'],
};

const previewSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    max_dimension: {
      type: 'integer',
      description:
        'Cap on the long edge in pixels. Defaults to 1024, which is plenty for tone/color/composition judgment and roughly halves the base64 payload vs the older 1500 default. Bump higher only when reading fine detail (e.g. text legibility or fur texture).',
      minimum: 64,
      maximum: 8192,
      default: 1024,
    },
    quality: {
      type: 'integer',
      description:
        'JPEG quality 1-12. Default: 6 (visibly clean for verification at the default 1024px max-dim; halves payload vs the older quality=8 default). Bump to 8-10 only when the preview is the deliverable, not the verification primitive.',
      minimum: 1,
      maximum: 12,
      default: 6,
    },
    annotations: {
      type: 'array',
      description:
        "Optional list of visual annotations to draw onto the preview before rendering — rectangles (by explicit bounds OR by layer name), guides (horizontal / vertical reference lines), point markers, and the current document selection. Use this to verify SPATIAL work (placement, alignment, scaling) — pass both your TARGET rect and the ACTUAL placement (e.g. the layer's bounds) in different colors, then visually compare in the returned image. Skips the spatial-self-evaluation trap where the LLM tries to estimate alignment from a plain preview.",
      items: annotationSchema,
    },
  },
};

// ---------- get_layer_bounds_diff schema ----------

const boundsDiffSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    layer: {
      type: 'string',
      description:
        "Name of the layer to measure. Reads boundsNoEffects (raw pixel bounds without layer-style expansion). The active doc's layer tree is searched recursively (so layers nested in groups are findable by name alone).",
    },
    target_left: {
      type: 'number',
      description: 'Target rectangle left edge in document pixels.',
    },
    target_top: { type: 'number', description: 'Target rectangle top edge.' },
    target_right: { type: 'number', description: 'Target rectangle right edge.' },
    target_bottom: { type: 'number', description: 'Target rectangle bottom edge.' },
    tolerance_px: {
      type: 'number',
      description:
        'Tolerance in pixels for the verdict — within this delta on every edge, the verdict is "aligned". Default 10.',
      minimum: 0,
      maximum: 1000,
      default: 10,
    },
  },
  required: ['layer', 'target_left', 'target_top', 'target_right', 'target_bottom'],
};

// ---------- histogram schema ----------

const histogramSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    channel: {
      type: 'string',
      enum: ['composite', 'red', 'green', 'blue', 'luminosity', 'gray'],
      description:
        'Which channel to read. "composite" (default) is the visible flattened image; if the active layer is an adjustment/fill/shape layer the tool transparently switches to a pixel layer to read it. "red"/"green"/"blue" require an RGB doc; "gray" a grayscale doc. "luminosity" dispatches per doc mode — Lab uses the Lightness channel (exact), Grayscale uses Gray (exact), and RGB reads the per-pixel composite, so mean, stdev, median and clipping reads are all trustworthy. A channel value naming a marginal mixture is a degraded last resort whose shape should not be trusted, only its mean. The result\'s `channel` field annotates which path landed when a fallback was used.',
      default: 'composite',
    },
  },
};

// ---------- compare_regions schema ----------

const compareRegionsSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    region_a_left: { type: 'number', description: 'Region A left edge.' },
    region_a_top: { type: 'number', description: 'Region A top edge.' },
    region_a_right: { type: 'number', description: 'Region A right edge.' },
    region_a_bottom: { type: 'number', description: 'Region A bottom edge.' },
    region_b_left: { type: 'number', description: 'Region B left edge.' },
    region_b_top: { type: 'number', description: 'Region B top edge.' },
    region_b_right: { type: 'number', description: 'Region B right edge.' },
    region_b_bottom: { type: 'number', description: 'Region B bottom edge.' },
    label_a: {
      type: 'string',
      description: 'Optional label for region A in the response.',
    },
    label_b: { type: 'string', description: 'Optional label for region B in the response.' },
  },
  required: [
    'region_a_left',
    'region_a_top',
    'region_a_right',
    'region_a_bottom',
    'region_b_left',
    'region_b_top',
    'region_b_right',
    'region_b_bottom',
  ],
};

export function createPreviewTools(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient
): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'ps_get_preview',
        description:
          'Render the active Photoshop document as a flattened, downscaled image and return it inline so the calling AI can see the current visual state. Use this to verify edits visually, judge whether adjustments went too far or not far enough, and decide what to do next. Read-only with respect to the working document (renders a duplicate that is closed immediately). The optional `annotations` array draws overlays in document-space coordinates: `rectangle` / `guide` / `point` / `selection` for spatial verification, and `grid` / `composition` for coordinate readout and compositional evaluation (added 2026-06-09 — grid styles `every` / `thirds` / `quarters` / `phi`, composition styles `diagonals` / `triangles` / `fibonacci_grid` / `golden_spiral`). Use spatial annotations to verify ("did the placed image land inside the frame interior?") — pass both target and actual bounds in different colors. Use grid / composition annotations to EVALUATE composition (balance, thirds, leading lines, focal-point placement) — not to read a coordinate for a tool call. To place or select precisely, do NOT read a pixel off a grid (unreliable) — NAME the intent to the on-device perception tools instead: `ps_detect` (COCO objects → real document-pixel boxes), `ps_select_by_reference` (a named target → a real selection, not a guessed rectangle), plus any spatial-grounding locator / selection tools present in `tools/list`. Without annotations, behaves identically to a plain preview.',
        inputSchema: previewSchema,
        outputSchema: {
          type: 'object',
          properties: {
            format: { type: 'string' },
            mime_type: { type: 'string' },
            dimensions: { type: 'string' },
            bytes: { type: 'number' },
            annotation_count: { type: 'number' },
            context: { type: 'object' },
          },
        },
        annotations: {
          title: 'Render Document Preview',
          readOnlyHint: true,
          idempotentHint: true,
        },
      },
      handler: async (args) => getPreview(connection, args),
    },
    {
      tool: {
        name: 'ps_get_layer_bounds_diff',
        description:
          'Numeric verification: compute the per-edge pixel deltas between a layer\'s actual bounds and a target rectangle. Returns left/top/right/bottom deltas (actual − target), scale ratio (actual_size / target_size), centroid offset, and a one-word verdict ("aligned", "shifted right", "layer too small", etc.). Use this AFTER place_image / scale_layer / move_layer to confirm the operation produced the intended result — far more reliable than eyeballing a preview for fine alignment. Read-only. Layers nested in groups are found by name recursively.',
        inputSchema: boundsDiffSchema,
        outputSchema: {
          type: 'object',
          properties: {
            verdict: { type: 'string' },
            within_tolerance: { type: 'boolean' },
            actual_bounds: { type: 'object' },
            target_bounds: { type: 'object' },
            deltas: { type: 'object' },
            scale_ratio_x: { type: 'number' },
            scale_ratio_y: { type: 'number' },
            centroid_offset_x: { type: 'number' },
            centroid_offset_y: { type: 'number' },
            context: { type: 'object' },
          },
        },
        annotations: {
          title: 'Compute Layer Bounds Diff',
          readOnlyHint: true,
          idempotentHint: true,
        },
      },
      handler: async (args) => getLayerBoundsDiff(connection, args),
    },
    {
      tool: {
        name: 'ps_get_histogram',
        description:
          "Whole-image (or per-channel) histogram — the quantitative answer to questions get_preview can't reliably answer by eye. Returns 256 bin counts plus mean / stdev / median. Cheap (~50ms), read-only. **Reach for this when**: (a) clipping detection — bins 0 and 255 carry the count of crushed shadows / blown highlights; you can't see clipping reliably in a downsampled JPEG preview; (b) exposure verification after a levels/curves/exposure adjustment — confirm the histogram actually shifted; (c) \"is this image neutral-gray?\" — compare R / G / B channel means; (d) confirming a destructive op did anything (two identical histograms = no-op regardless of the tool's success message). Composite reads the visible flattened image (any color mode). Per-channel reads require the document have that channel.",
        inputSchema: histogramSchema,
        outputSchema: {
          type: 'object',
          properties: {
            channel: { type: 'string' },
            bins: {
              type: 'array',
              items: { type: 'number' },
              minItems: 256,
              maxItems: 256,
            },
            bin_count: { type: 'number' },
            total_pixels: { type: 'number' },
            mean: { type: 'number' },
            stdev: { type: 'number' },
            median: { type: 'number' },
            context: { type: 'object' },
          },
        },
        annotations: {
          title: 'Get Histogram (verification primitive)',
          readOnlyHint: true,
          idempotentHint: true,
        },
      },
      handler: async (args) => getHistogram(connection, snippetClient, args),
    },
    {
      tool: {
        name: 'ps_compare_regions',
        description:
          'Quantitative region comparison — the NUMERIC verification answer when "does it look right?" via get_preview is too subjective. Captures the histogram of two rectangular regions on the same document and reports per-channel mean / stdev / median for each region plus the deltas. **Reach for this when**: (a) "did the placed image match the room\'s lighting?" — sample a region of the placed image vs a region of the surrounding wall; (b) "did this adjustment do anything visible in the shadows?" — sample the same dark region before and after; (c) "is region A noticeably warmer/cooler than region B?" — read the channel means directly. Single-pixel sampling via a 1×1 rect is supported. Read-only.',
        inputSchema: compareRegionsSchema,
        outputSchema: {
          type: 'object',
          properties: {
            region_a: { type: 'object' },
            region_b: { type: 'object' },
            differences: { type: 'object' },
            context: { type: 'object' },
          },
        },
        annotations: {
          title: 'Compare Regions',
          readOnlyHint: true,
          idempotentHint: true,
        },
      },
      handler: async (args) => compareRegions(connection, args),
    },
  ];
}

// ---------- get_preview handler ----------

interface PreviewAnnotation {
  type?: string;
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
  layer?: string;
  orientation?: string;
  pixel?: number;
  canvas_pct?: number;
  x?: number;
  y?: number;
  marker?: string;
  color?: string;
  label?: string;
  stroke_width?: number;
  // grid + composition
  style?: string;
  spacing_px?: number;
  orientation_corner?: string;
}

function buildAnnotationsScript(annotations: PreviewAnnotation[] | undefined): string {
  if (!annotations || annotations.length === 0) return '';

  const calls: string[] = [];
  for (const ann of annotations) {
    const color = normalizeColor(ann.color);
    const strokeWidth = typeof ann.stroke_width === 'number' ? ann.stroke_width : 4;
    const label = ann.label ?? '';

    if (ann.type === 'rectangle') {
      if (typeof ann.layer === 'string' && ann.layer.length > 0) {
        // Layer-name shortcut — resolve bounds at PS-time from dup's layer tree.
        calls.push(
          `drawRectByLayer(${jsLit(ann.layer)}, ${jsLit(color)}, ${jsNum(strokeWidth, 4)}, ${jsLit(label)});`
        );
      } else if (
        typeof ann.left === 'number' &&
        typeof ann.top === 'number' &&
        typeof ann.right === 'number' &&
        typeof ann.bottom === 'number'
      ) {
        calls.push(
          `drawRect(${jsNum(ann.left, 0)}, ${jsNum(ann.top, 0)}, ${jsNum(ann.right, 0)}, ${jsNum(ann.bottom, 0)}, ${jsLit(color)}, ${jsNum(strokeWidth, 4)}, ${jsLit(label)});`
        );
      }
    } else if (ann.type === 'guide') {
      const orient = ann.orientation === 'vertical' ? 'vertical' : 'horizontal';
      const pixel = typeof ann.pixel === 'number' ? ann.pixel : null;
      const pct = typeof ann.canvas_pct === 'number' ? ann.canvas_pct : null;
      calls.push(
        `drawGuide(${jsLit(orient)}, ${pixel !== null ? jsNum(pixel, 0) : 'null'}, ${pct !== null ? jsNum(pct, 0) : 'null'}, ${jsLit(color)}, ${jsNum(strokeWidth, 4)}, ${jsLit(label)});`
      );
    } else if (ann.type === 'point') {
      if (typeof ann.x === 'number' && typeof ann.y === 'number') {
        const marker = ann.marker ?? 'cross';
        calls.push(
          `drawPoint(${jsNum(ann.x, 0)}, ${jsNum(ann.y, 0)}, ${jsLit(marker)}, ${jsLit(color)}, ${jsNum(strokeWidth, 4)}, ${jsLit(label)});`
        );
      }
    } else if (ann.type === 'selection') {
      calls.push(
        `drawCurrentSelection(${jsLit(color)}, ${jsNum(strokeWidth, 4)}, ${jsLit(label)});`
      );
    } else if (ann.type === 'grid') {
      // Defensive validation. The top-level validateArgs() doesn't recurse
      // into array items (utils/validate.ts), so the schema's enum / min /
      // max constraints on these fields never fire. Most consequential
      // here: spacing_px <= 0 would produce an infinite loop in the
      // ExtendScript `for (gx = spacing; gx < docW; gx += spacing)`
      // — a self-inflicted DoS on the user's PS session. Clamp here.
      const GRID_STYLES = ['every', 'thirds', 'quarters', 'phi'] as const;
      const rawStyle = typeof ann.style === 'string' ? ann.style : 'thirds';
      const style = (GRID_STYLES as readonly string[]).includes(rawStyle) ? rawStyle : 'thirds';
      const rawSpacing =
        typeof ann.spacing_px === 'number' && isFinite(ann.spacing_px) ? ann.spacing_px : 50;
      const spacing = Math.max(10, Math.min(4000, Math.floor(rawSpacing)));
      calls.push(
        `drawGrid(${jsLit(style)}, ${jsNum(spacing, 50)}, ${jsLit(color)}, ${jsNum(strokeWidth, 4)}, ${jsLit(label)});`
      );
    } else if (ann.type === 'composition') {
      const COMP_STYLES = ['diagonals', 'triangles', 'fibonacci_grid', 'golden_spiral'] as const;
      const CORNERS = ['tl', 'tr', 'bl', 'br'] as const;
      const rawStyle = typeof ann.style === 'string' ? ann.style : 'golden_spiral';
      const style = (COMP_STYLES as readonly string[]).includes(rawStyle)
        ? rawStyle
        : 'golden_spiral';
      const rawCorner = typeof ann.orientation_corner === 'string' ? ann.orientation_corner : 'tl';
      const corner = (CORNERS as readonly string[]).includes(rawCorner) ? rawCorner : 'tl';
      calls.push(
        `drawComposition(${jsLit(style)}, ${jsLit(corner)}, ${jsLit(color)}, ${jsNum(strokeWidth, 4)}, ${jsLit(label)});`
      );
    }
  }

  // Rewritten 2026-06-02 (post-hotfix): annotations draw directly on the
  // FLATTENED background of the preview duplicate, not on an empty
  // overlay layer. Empty new layers don't accept selection.fill() in
  // PS 27.x ("command not available"). The flattened bg has pixel
  // content so fill works normally. dup is the temp preview duplicate
  // that gets discarded after rendering to JPEG — modifying its bg is
  // a non-issue (orig is untouched throughout).
  //
  // Layer-name annotations (`layer: "<name>"`) are resolved BEFORE the
  // flatten so layer bounds can still be read. Resolved bounds go into
  // a JS cache that drawRectByLayer reads. Text labels are deferred
  // and added at the very end so text layers don't interleave with
  // fill operations on the bg.
  return `
        // ANNOTATIONS BLOCK
        (function () {
          var docW = dup.width.as('px');
          var docH = dup.height.as('px');
          var labelSize = Math.max(docW, docH) / 80;
          if (labelSize < 12) labelSize = 12;

          ${normNameHelper}
          // Em-dash / en-dash tolerant comparison (Bug I) via normName — the
          // LLM routinely swaps these silently; raw equality would miss.
          // Depth cap is defense-in-depth (see selectLayer's identical
          // comment). wantedNorm is pre-normalized by the caller so this fn
          // can be reused across multiple cacheLayerBounds() calls.
          function findLayerByName(layers, wantedNorm, depth) {
            if (depth === undefined) depth = 0;
            if (depth > 32) return null;
            for (var i = 0; i < layers.length; i++) {
              var l = layers[i];
              if (normName(l.name) === wantedNorm) return l;
              var isGroup = false;
              try { isGroup = (l instanceof LayerSet); } catch (eG) {}
              if (isGroup) {
                var inner = findLayerByName(l.layers, wantedNorm, depth + 1);
                if (inner) return inner;
              }
            }
            return null;
          }

          // Phase 1: pre-flatten layer-bounds cache.
          // Any \`layer: "Name"\` rectangle annotation needs the layer's
          // bounds resolved BEFORE we flatten dup (after flatten there's
          // only the single bg). The drawRectByLayer fn below reads from
          // this cache.
          var layerBoundsCache = {};
          function cacheLayerBounds(name) {
            try {
              if (layerBoundsCache[name]) return;
              var lyr = findLayerByName(dup.layers, normName(name));
              if (!lyr) return;
              var b = (lyr.boundsNoEffects !== undefined) ? lyr.boundsNoEffects : lyr.bounds;
              layerBoundsCache[name] = {
                l: b[0].as('px'), t: b[1].as('px'),
                r: b[2].as('px'), b: b[3].as('px')
              };
            } catch (e) {}
          }

          // Phase 2: capture current selection bounds (for the 'selection'
          // annotation type) BEFORE we mess with the doc state.
          var capturedSelBounds = null;
          try {
            var ref = new ActionReference();
            ref.putProperty(charIDToTypeID('Prpr'), charIDToTypeID('fsel'));
            ref.putEnumerated(charIDToTypeID('Dcmn'), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));
            var got = executeActionGet(ref);
            if (got.hasKey(charIDToTypeID('fsel'))) {
              var sb = dup.selection.bounds;
              capturedSelBounds = {
                l: sb[0].as('px'), t: sb[1].as('px'),
                r: sb[2].as('px'), b: sb[3].as('px')
              };
            }
          } catch (e) {}

          ${buildCacheCalls(annotations)}

          // Phase 3: flatten dup. Now we have a single bg layer with
          // pixel content that accepts selection.fill() reliably.
          try { dup.flatten(); } catch (e) {}

          // After flatten there's exactly one layer; make it active.
          try {
            if (dup.backgroundLayer) dup.activeLayer = dup.backgroundLayer;
            else if (dup.artLayers.length > 0) dup.activeLayer = dup.artLayers[0];
          } catch (e) {}

          function hexToColor(hex) {
            var c = new SolidColor();
            c.rgb.red = parseInt(hex.substr(1, 2), 16);
            c.rgb.green = parseInt(hex.substr(3, 2), 16);
            c.rgb.blue = parseInt(hex.substr(5, 2), 16);
            return c;
          }

          // Labels deferred to phase 5 so text layers don't interleave
          // with bg fills (each new text layer would become the active
          // layer and break subsequent selection.fill calls on the bg).
          var pendingLabels = [];
          function addLabel(x, y, text, color) {
            pendingLabels.push({ x: x, y: y, text: text, color: color });
          }

          function fillRect(x1, y1, x2, y2, c) {
            try {
              dup.selection.select(
                [[x1, y1], [x2, y1], [x2, y2], [x1, y2]],
                SelectionType.REPLACE, 0, false
              );
              dup.selection.fill(c);
              dup.selection.deselect();
            } catch (e) {}
          }

          function drawRect(l, t, r, b, hex, sw, label) {
            try {
              var c = hexToColor(hex);
              fillRect(l, t, r, t + sw, c);       // top edge
              fillRect(l, b - sw, r, b, c);       // bottom edge
              fillRect(l, t, l + sw, b, c);       // left edge
              fillRect(r - sw, t, r, b, c);       // right edge
              if (label && label.length > 0) addLabel(l, t - labelSize - sw, label, c);
            } catch (e) {}
          }
          function drawRectByLayer(name, hex, sw, label) {
            var b = layerBoundsCache[name];
            if (!b) return;
            drawRect(b.l, b.t, b.r, b.b, hex, sw, label);
          }
          function drawGuide(orient, pixel, pct, hex, sw, label) {
            try {
              var c = hexToColor(hex);
              var s = sw / 2;
              var pos = (pixel !== null) ? pixel : Math.round((orient === 'horizontal' ? docH : docW) * (pct !== null ? pct : 0.5));
              if (orient === 'horizontal') {
                fillRect(0, pos - s, docW, pos + s, c);
              } else {
                fillRect(pos - s, 0, pos + s, docH, c);
              }
              if (label && label.length > 0) {
                if (orient === 'horizontal') addLabel(10, pos - labelSize - sw, label, c);
                else addLabel(pos + sw + 4, 10, label, c);
              }
            } catch (e) {}
          }
          function drawPoint(x, y, marker, hex, sw, label) {
            try {
              var c = hexToColor(hex);
              if (marker === 'cross' || marker === 'crosshair') {
                var len = sw * 5;
                var s = sw / 2;
                fillRect(x - len, y - s, x + len, y + s, c);
                fillRect(x - s, y - len, x + s, y + len, c);
              } else {
                // dot — small filled square
                var r2 = sw * 2;
                fillRect(x - r2, y - r2, x + r2, y + r2, c);
              }
              if (label && label.length > 0) addLabel(x + sw * 5, y + sw, label, c);
            } catch (e) {}
          }
          function drawCurrentSelection(hex, sw, label) {
            if (!capturedSelBounds) return;
            drawRect(
              capturedSelBounds.l, capturedSelBounds.t,
              capturedSelBounds.r, capturedSelBounds.b,
              hex, sw, label || 'selection'
            );
          }

          // Diagonal line approximated by a thin rotated rectangle. One
          // selection.fill per line — much faster than stepping pixels.
          // The corners of the rectangle are the line endpoints offset by
          // sw/2 perpendicular to the line direction.
          function drawLine(x1, y1, x2, y2, sw, c) {
            try {
              var dx = x2 - x1, dy = y2 - y1;
              var len = Math.sqrt(dx * dx + dy * dy);
              if (len < 0.5) return;
              var nx = -dy / len * sw / 2;
              var ny = dx / len * sw / 2;
              dup.selection.select(
                [
                  [x1 + nx, y1 + ny],
                  [x2 + nx, y2 + ny],
                  [x2 - nx, y2 - ny],
                  [x1 - nx, y1 - ny]
                ],
                SelectionType.REPLACE, 0, false
              );
              dup.selection.fill(c);
              dup.selection.deselect();
            } catch (e) {}
          }

          function drawGrid(style, spacing, hex, sw, label) {
            try {
              var c = hexToColor(hex);
              var s = sw / 2;
              var lines = [];
              if (style === 'every') {
                for (var gx = spacing; gx < docW; gx += spacing) lines.push({ o: 'V', p: gx });
                for (var gy = spacing; gy < docH; gy += spacing) lines.push({ o: 'H', p: gy });
              } else if (style === 'thirds') {
                lines.push({ o: 'V', p: Math.round(docW / 3) });
                lines.push({ o: 'V', p: Math.round(docW * 2 / 3) });
                lines.push({ o: 'H', p: Math.round(docH / 3) });
                lines.push({ o: 'H', p: Math.round(docH * 2 / 3) });
              } else if (style === 'quarters') {
                lines.push({ o: 'V', p: Math.round(docW / 2) });
                lines.push({ o: 'H', p: Math.round(docH / 2) });
              } else if (style === 'phi') {
                // Golden-ratio analog of thirds — lines at 0.382 and 0.618.
                lines.push({ o: 'V', p: Math.round(docW * 0.382) });
                lines.push({ o: 'V', p: Math.round(docW * 0.618) });
                lines.push({ o: 'H', p: Math.round(docH * 0.382) });
                lines.push({ o: 'H', p: Math.round(docH * 0.618) });
              }
              for (var i = 0; i < lines.length; i++) {
                var ln = lines[i];
                if (ln.o === 'H') fillRect(0, ln.p - s, docW, ln.p + s, c);
                else fillRect(ln.p - s, 0, ln.p + s, docH, c);
              }
              if (label && label.length > 0) addLabel(10, labelSize, label, c);
            } catch (e) {}
          }

          // Quarter-arc approximation using line segments. Center at (cx, cy)
          // with radius r; the arc goes from startAngle to endAngle (radians,
          // 0 = right, pi/2 = down in screen coords). nSegments controls
          // smoothness — 24 looks clean at preview resolution.
          function drawArc(cx, cy, r, startAngle, endAngle, nSegments, sw, c) {
            try {
              var prevX = cx + Math.cos(startAngle) * r;
              var prevY = cy + Math.sin(startAngle) * r;
              for (var i = 1; i <= nSegments; i++) {
                var t = startAngle + (endAngle - startAngle) * (i / nSegments);
                var nxX = cx + Math.cos(t) * r;
                var nxY = cy + Math.sin(t) * r;
                drawLine(prevX, prevY, nxX, nxY, sw, c);
                prevX = nxX;
                prevY = nxY;
              }
            } catch (e) {}
          }

          function drawComposition(style, corner, hex, sw, label) {
            try {
              var c = hexToColor(hex);
              if (style === 'diagonals') {
                drawLine(0, 0, docW, docH, sw, c);
                drawLine(docW, 0, 0, docH, sw, c);
              } else if (style === 'triangles') {
                // "Golden triangle" composition: main diagonal + perpendiculars
                // dropped from the OTHER two corners onto that diagonal.
                drawLine(0, 0, docW, docH, sw, c);
                // Foot of perpendicular from (docW, 0) to line through (0,0)-(docW,docH):
                //   The line's direction is (docW, docH); length^2 = docW^2 + docH^2.
                //   Project (docW, 0) onto direction: t = (docW * docW + 0 * docH) / L2
                //   Foot = t * (docW, docH)
                var L2 = docW * docW + docH * docH;
                var t1 = (docW * docW) / L2;
                drawLine(docW, 0, t1 * docW, t1 * docH, sw, c);
                // Perpendicular from (0, docH):
                //   t = (0 * docW + docH * docH) / L2
                var t2 = (docH * docH) / L2;
                drawLine(0, docH, t2 * docW, t2 * docH, sw, c);
              } else if (style === 'fibonacci_grid' || style === 'golden_spiral') {
                drawFibonacciOverlay(corner, c, sw, style === 'golden_spiral');
              }
              if (label && label.length > 0) addLabel(10, labelSize, label, c);
            } catch (e) {}
          }

          // Fibonacci subdivision: at each step, cut a square off the long
          // side of the active rectangle. The square is aligned with one
          // corner of the active rectangle — which corner depends on the
          // starting corner of the overall spiral and the current depth
          // (each level rotates 90 degrees).
          //
          // For golden_spiral=true we also draw a quarter-arc inside each
          // square, going from one corner of the square to the adjacent
          // corner, building the spiral curve as we go.
          //
          // NOTE on non-golden aspect ratios: this algorithm uses the
          // fixed cyclic rotation (tl -> tr -> br -> bl) which produces
          // a perfectly-continuous spiral on a TRUE golden rectangle
          // (aspect 1.618:1). On arbitrary canvases — 4:3, 16:9, 1:1
          // — the squares still place correctly but consecutive arcs
          // can show small discontinuities at iteration boundaries.
          // The visual result is still useful as a compositional aid;
          // it's just not a mathematically-perfect golden spiral when
          // the canvas isn't golden. maxLevels capped at 8 to keep the
          // total fill count bounded for the 90s annotated-preview
          // timeout.
          function drawFibonacciOverlay(startCorner, c, sw, drawSpiral) {
            try {
              // Track the active rectangle as we shrink it.
              var x = 0, y = 0, w = docW, h = docH;
              // "Corner direction" — which corner of the active rect the next
              // square sits in. Spiral rotates through tl -> tr -> br -> bl
              // (clockwise) for the 'tl' starting corner. Other starting
              // corners rotate the cycle.
              var corners = ['tl', 'tr', 'br', 'bl'];
              var clockwise = (startCorner === 'tl' || startCorner === 'br');
              var startIdx = corners.indexOf(startCorner);
              if (startIdx < 0) startIdx = 0;
              var dir = startIdx;

              var maxLevels = 8;
              for (var lv = 0; lv < maxLevels && w > 8 && h > 8; lv++) {
                var size = Math.min(w, h);
                // The square sits in the current corner; the remainder is the next active rect.
                var sqX, sqY, sqW, sqH;
                var cornerNow = corners[dir];
                if (cornerNow === 'tl') { sqX = x; sqY = y; sqW = size; sqH = size; }
                else if (cornerNow === 'tr') { sqX = x + w - size; sqY = y; sqW = size; sqH = size; }
                else if (cornerNow === 'br') { sqX = x + w - size; sqY = y + h - size; sqW = size; sqH = size; }
                else { sqX = x; sqY = y + h - size; sqW = size; sqH = size; } // bl

                // Draw the square outline.
                fillRect(sqX, sqY, sqX + sqW, sqY + sw, c);             // top
                fillRect(sqX, sqY + sqH - sw, sqX + sqW, sqY + sqH, c); // bottom
                fillRect(sqX, sqY, sqX + sw, sqY + sqH, c);             // left
                fillRect(sqX + sqW - sw, sqY, sqX + sqW, sqY + sqH, c); // right

                // Quarter-arc inside the square for the spiral curve.
                if (drawSpiral) {
                  // The arc center is the corner of the square OPPOSITE the
                  // overall starting corner of the spiral — that's where two
                  // sides of the square meet the next-smaller rectangle.
                  var arcCX, arcCY, startA, endA;
                  if (cornerNow === 'tl') {
                    arcCX = sqX + sqW; arcCY = sqY + sqH;
                    startA = Math.PI; endA = clockwise ? 1.5 * Math.PI : 0.5 * Math.PI;
                  } else if (cornerNow === 'tr') {
                    arcCX = sqX; arcCY = sqY + sqH;
                    startA = clockwise ? 1.5 * Math.PI : -0.5 * Math.PI;
                    endA = clockwise ? 2 * Math.PI : 0;
                  } else if (cornerNow === 'br') {
                    arcCX = sqX; arcCY = sqY;
                    startA = 0; endA = clockwise ? 0.5 * Math.PI : -0.5 * Math.PI;
                  } else { // bl
                    arcCX = sqX + sqW; arcCY = sqY;
                    startA = clockwise ? 0.5 * Math.PI : 1.5 * Math.PI;
                    endA = Math.PI;
                  }
                  drawArc(arcCX, arcCY, size, startA, endA, 24, sw, c);
                }

                // Shrink to the remainder rectangle (the strip NOT covered by the square).
                if (w >= h) {
                  // Square ate either the left or right strip.
                  if (cornerNow === 'tl' || cornerNow === 'bl') {
                    x += size; w -= size;
                  } else {
                    w -= size;
                  }
                } else {
                  // Square ate either the top or bottom strip.
                  if (cornerNow === 'tl' || cornerNow === 'tr') {
                    y += size; h -= size;
                  } else {
                    h -= size;
                  }
                }

                // Rotate direction by 90 degrees.
                dir = clockwise ? (dir + 1) % 4 : (dir + 3) % 4;
              }
            } catch (e) {}
          }

          // Phase 4: draw all the rectangles / guides / points / selection
          // markers. Labels accumulate in pendingLabels.
          ${calls.join('\n          ')}

          // Phase 5: now that all bg painting is done, add the text labels.
          // Each label creates a text layer that becomes active, which is
          // why we defer them — they'd break fill operations on the bg.
          for (var li = 0; li < pendingLabels.length; li++) {
            try {
              var lbl = pendingLabels[li];
              var tl = dup.artLayers.add();
              tl.kind = LayerKind.TEXT;
              var ti = tl.textItem;
              ti.contents = lbl.text;
              try { ti.font = 'ArialMT'; } catch (eF) {}
              ti.size = labelSize;
              ti.color = lbl.color;
              ti.position = [lbl.x, lbl.y < labelSize ? labelSize : lbl.y];
            } catch (e) {}
          }
        })();
      `;
}

/**
 * Emit JS code that pre-caches layer bounds for each `layer: "<name>"`
 * rectangle annotation, before the flatten step removes the layers.
 */
function buildCacheCalls(annotations: PreviewAnnotation[]): string {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const ann of annotations) {
    if (ann.type === 'rectangle' && typeof ann.layer === 'string' && ann.layer.length > 0) {
      if (!seen.has(ann.layer)) {
        seen.add(ann.layer);
        names.push(ann.layer);
      }
    }
  }
  return names.map((n) => `cacheLayerBounds(${jsLit(n)});`).join('\n          ');
}

async function getPreview(
  connection: PhotoshopConnection,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(previewSchema, rawArgs);
    const maxDimension = args.max_dimension as number;
    const quality = args.quality as number;
    const annotations = (args.annotations as PreviewAnnotation[] | undefined) ?? [];

    const annotationsScript = buildAnnotationsScript(annotations);

    // 2026-06-08: on macOS, `tmpdir()` can return `/tmp` and Photoshop's
    // saveAs to `/tmp` paths silently fails — saveAs returns success but
    // no file is written, then the readFile below throws ENOENT. Confirmed
    // against a v0.5.3 Mac session NDJSON where two get_preview calls hit
    // exactly this. The userOwnedTempRoot() helper resolves to
    // `~/Library/Caches/editmamei/tmp` on macOS, which is a user-owned
    // cache directory PS can definitely write to. On Windows and Linux
    // the default tmpdir() path is fine; only macOS needs the override.
    const dir =
      process.platform === 'darwin'
        ? await TempDir.createWithRoot(userOwnedTempRoot(), 'editmamei-preview-')
        : await TempDir.create('editmamei-preview-');
    try {
      const tempPath = dir.path('preview.jpg');

      // JPEG is the only output. PNG was removed 2026-06-10 — for any
      // non-tiny document the PNG payload blows past the MCP response
      // size cap (the MCP transport caps individual responses at ~1 MB
      // and a 1024px PNG of a typical photo is 1.5-3 MB), and PNG offers
      // no verification benefit over JPEG at the quality=6 default: the
      // LLM evaluates spatial layout + tone + color, all of which JPEG
      // preserves at this scale.
      const saveBlock = `var opts = new JPEGSaveOptions();
             opts.quality = ${jsNum(quality, 6)};
             opts.embedColorProfile = true;
             opts.formatOptions = FormatOptions.STANDARDBASELINE;
             dup.saveAs(outFile, opts, true, Extension.LOWERCASE);`;

      // Order matters:
      //   1. duplicate orig (preserves layers — needed to resolve `layer: "..."` annotations)
      //   2. draw annotations on dup using document-space coordinates
      //   3. resize dup (annotations scale proportionally with the image)
      //   4. save (JPEG save flattens implicitly)
      const script = `
        ${getContextInfo}

        if (app.documents.length === 0) {
          throw new Error('No document is open in Photoshop');
        }
        // Defensive cleanup: a prior killed wrapper.vbs (annotated previews
        // timing out at 30s) leaves a stale "<orig> __mcp_preview__" doc
        // open. Close any we find before creating a new one — otherwise
        // subsequent previews succeed at the script level but PS still
        // shows the orphan doc and later get_preview calls compound the
        // mess. Match by name substring, not exact name, because PS
        // appends " copy" / " copy 2" when names collide.
        for (var __pi = app.documents.length - 1; __pi >= 0; __pi--) {
          try {
            var __pd = app.documents[__pi];
            if (String(__pd.name).indexOf('__mcp_preview__') !== -1) {
              try { __pd.close(SaveOptions.DONOTSAVECHANGES); } catch (__pcErr) {}
            }
          } catch (__plErr) {}
        }
        var orig = app.activeDocument;
        var dup = orig.duplicate(orig.name + ' __mcp_preview__');
        try {
          ${annotationsScript}

          var w = dup.width.as('px');
          var h = dup.height.as('px');
          var longEdge = (w > h) ? w : h;
          if (longEdge > ${jsNum(maxDimension, 1024)}) {
            var scale = ${jsNum(maxDimension, 1024)} / longEdge;
            dup.resizeImage(
              UnitValue(Math.round(w * scale), 'px'),
              UnitValue(Math.round(h * scale), 'px'),
              null,
              ResampleMethod.BICUBIC
            );
          }
          var outFile = new File(${jsLit(tempPath)});
          ${saveBlock}
          // Defensive existence check: macOS Photoshop's saveAs to certain
          // paths (notably anything under /tmp) has been observed to return
          // success without actually writing the file. Catching it here
          // turns "ENOENT" handler-side into a clear diagnostic naming the
          // exact path PS claimed to write. See the 2026-06-08 preview-
          // tools comment for the original incident.
          if (!outFile.exists) {
            try { dup.close(SaveOptions.DONOTSAVECHANGES); } catch (eDup) {}
            try { app.activeDocument = orig; } catch (eAd) {}
            throw new Error(
              'JPEG saveAs reported success but the file is not present at ' +
              outFile.fsName + '. This is a known macOS Photoshop quirk when saving ' +
              'to a sandbox-restricted path (e.g. /tmp). The handler should be using ' +
              'a user-owned cache directory; if you are seeing this anyway, the temp ' +
              'root resolution is broken.'
            );
          }
          var finalW = dup.width.as('px');
          var finalH = dup.height.as('px');
          dup.close(SaveOptions.DONOTSAVECHANGES);
          app.activeDocument = orig;
          return {
            ok: true,
            width_px: finalW,
            height_px: finalH,
            context: getContextInfo()
          };
        } catch (e) {
          try { dup.close(SaveOptions.DONOTSAVECHANGES); } catch (e2) {}
          try { app.activeDocument = orig; } catch (e3) {}
          throw e;
        }
      `;

      // Annotated previews on multi-layer docs legitimately exceed the
      // 30s runner default — the per-rect 4 selection.fill ops + the
      // dup.flatten on a 6+ layer document have been seen at 18s for a
      // single rect and 30s+ (timeout) for two guides with labels in live
      // PS. Bump to 90s when annotations are present so the wrapper
      // doesn't get SIGKILL'd mid-flatten and leave a stale __mcp_preview__
      // doc behind (which then breaks the next 2-3 previews until state
      // recovers).
      const execTimeoutMs = annotations.length > 0 ? ANNOTATED_PREVIEW_TIMEOUT_MS : undefined;
      const result = (await runScript(connection, script, execTimeoutMs)) as {
        ok?: boolean;
        width_px?: number;
        height_px?: number;
        context?: Record<string, unknown>;
      };

      const bytes: Buffer = await readFile(tempPath);

      const base64 = bytes.toString('base64');
      const dims =
        result?.width_px && result?.height_px
          ? `${result.width_px}x${result.height_px}`
          : 'unknown';
      const annotationCount = annotations.length;
      const annNote = annotationCount > 0 ? `, ${annotationCount} annotation(s) overlaid` : '';

      return {
        content: [
          { type: 'image' as const, data: base64, mimeType: 'image/jpeg' },
          {
            type: 'text' as const,
            text: `Preview rendered (JPEG, ${dims}, ${formatBytes(bytes.length)}${annNote}). This is the current flattened state of the active document.`,
          },
        ],
        structuredContent: {
          format: 'jpeg',
          mime_type: 'image/jpeg',
          dimensions: dims,
          bytes: bytes.length,
          annotation_count: annotationCount,
          context: result?.context,
        },
      };
    } finally {
      await dir.cleanup();
    }
  } catch (error) {
    return toolErrorResult('Error rendering preview', error);
  }
}

// ---------- get_layer_bounds_diff handler ----------

async function getLayerBoundsDiff(
  connection: PhotoshopConnection,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(boundsDiffSchema, rawArgs);
    const layer = args.layer as string;
    const targetLeft = args.target_left as number;
    const targetTop = args.target_top as number;
    const targetRight = args.target_right as number;
    const targetBottom = args.target_bottom as number;
    const tolerancePx = (args.tolerance_px as number) ?? 10;

    const script = `
      ${getContextInfo}

      if (app.documents.length === 0) throw new Error('No document is open in Photoshop');
      var doc = app.activeDocument;

      ${normNameHelper}
      ${notFoundMessageHelper}
      // Em-dash / en-dash tolerant comparison (Bug I) via normName — the
      // LLM routinely swaps these silently; raw equality would miss.
      // Depth cap is defense-in-depth (see selectLayer's identical comment).
      var targetNorm = normName(${jsLit(layer)});
      function findLayerByName(layers, depth) {
        if (depth === undefined) depth = 0;
        if (depth > 32) return null;
        for (var i = 0; i < layers.length; i++) {
          var l = layers[i];
          if (normName(l.name) === targetNorm) return l;
          var isGroup = false;
          try { isGroup = (l instanceof LayerSet); } catch (eG) {}
          if (isGroup) {
            var inner = findLayerByName(l.layers, depth + 1);
            if (inner) return inner;
          }
        }
        return null;
      }
      var lyr = findLayerByName(doc.layers);
      if (!lyr) throw new Error(__notFoundMessage('Layer', ${jsLit(layer)}, false));

      var b = (lyr.boundsNoEffects !== undefined) ? lyr.boundsNoEffects : lyr.bounds;
      var aLeft = b[0].as('px');
      var aTop = b[1].as('px');
      var aRight = b[2].as('px');
      var aBottom = b[3].as('px');
      var aW = aRight - aLeft;
      var aH = aBottom - aTop;
      var aCx = (aLeft + aRight) / 2;
      var aCy = (aTop + aBottom) / 2;

      var tLeft = ${jsNum(targetLeft, 0)};
      var tTop = ${jsNum(targetTop, 0)};
      var tRight = ${jsNum(targetRight, 0)};
      var tBottom = ${jsNum(targetBottom, 0)};
      var tW = tRight - tLeft;
      var tH = tBottom - tTop;
      var tCx = (tLeft + tRight) / 2;
      var tCy = (tTop + tBottom) / 2;

      // deltas = actual - target (positive = actual is to the right / below / larger)
      var dLeft = aLeft - tLeft;
      var dTop = aTop - tTop;
      var dRight = aRight - tRight;
      var dBottom = aBottom - tBottom;
      var dCx = aCx - tCx;
      var dCy = aCy - tCy;
      var scaleX = (tW > 0) ? (aW / tW) : 0;
      var scaleY = (tH > 0) ? (aH / tH) : 0;

      var tol = ${jsNum(tolerancePx, 10)};
      var withinTol = (Math.abs(dLeft) <= tol) && (Math.abs(dTop) <= tol)
                  && (Math.abs(dRight) <= tol) && (Math.abs(dBottom) <= tol);
      var verdict;
      if (withinTol) {
        verdict = 'aligned';
      } else {
        // Pick the dominant issue.
        var absMax = 0; var which = '';
        if (Math.abs(dCx) > absMax) { absMax = Math.abs(dCx); which = (dCx > 0) ? 'shifted right' : 'shifted left'; }
        if (Math.abs(dCy) > absMax) { absMax = Math.abs(dCy); which = (dCy > 0) ? 'shifted down' : 'shifted up'; }
        var sizeDiffX = aW - tW;
        var sizeDiffY = aH - tH;
        if (Math.abs(sizeDiffX) > absMax * 1.5 || Math.abs(sizeDiffY) > absMax * 1.5) {
          if (sizeDiffX < 0 && sizeDiffY < 0) which = 'layer too small';
          else if (sizeDiffX > 0 && sizeDiffY > 0) which = 'layer too large';
          else which = 'aspect mismatch';
        }
        verdict = which || 'misaligned';
      }

      return {
        verdict: verdict,
        within_tolerance: withinTol,
        actual_bounds: { left: aLeft, top: aTop, right: aRight, bottom: aBottom, width: aW, height: aH },
        target_bounds: { left: tLeft, top: tTop, right: tRight, bottom: tBottom, width: tW, height: tH },
        deltas: { left: dLeft, top: dTop, right: dRight, bottom: dBottom },
        scale_ratio_x: scaleX,
        scale_ratio_y: scaleY,
        centroid_offset_x: dCx,
        centroid_offset_y: dCy,
        context: getContextInfo()
      };
    `;

    const result = (await runScript(connection, script)) as {
      verdict?: string;
      within_tolerance?: boolean;
      deltas?: { left: number; top: number; right: number; bottom: number };
      scale_ratio_x?: number;
      scale_ratio_y?: number;
    };

    const d = result.deltas;
    const summary =
      `Verdict: ${result.verdict ?? '?'}.` +
      (d
        ? ` Deltas (actual−target): left=${d.left.toFixed(0)} top=${d.top.toFixed(0)} right=${d.right.toFixed(0)} bottom=${d.bottom.toFixed(0)} px.`
        : '') +
      (typeof result.scale_ratio_x === 'number'
        ? ` Scale ratio: ${result.scale_ratio_x.toFixed(2)}×${result.scale_ratio_y?.toFixed(2)}.`
        : '');

    return {
      content: [{ type: 'text' as const, text: summary }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  } catch (error) {
    return toolErrorResult('Error computing bounds diff', error);
  }
}

// ---------- get_histogram handler ----------

async function getHistogram(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: histogramSchema,
    snippet: 'getHistogram',
    errorPrefix: 'Error reading histogram',
    params: (args) => ({ channel: (args.channel as string) ?? 'composite' }),
    successText: (result) => {
      const r = result as {
        channel: string;
        total_pixels: number;
        mean: number;
        stdev: number;
        median: number;
      };
      return (
        `Histogram (${r.channel}): ` +
        `total=${r.total_pixels.toLocaleString()} px, ` +
        `mean=${r.mean.toFixed(1)}, ` +
        `stdev=${r.stdev.toFixed(1)}, ` +
        `median=${r.median}`
      );
    },
  });
}

// ---------- compare_regions handler ----------

async function compareRegions(
  connection: PhotoshopConnection,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(compareRegionsSchema, rawArgs);
    const aLeft = args.region_a_left as number;
    const aTop = args.region_a_top as number;
    const aRight = args.region_a_right as number;
    const aBottom = args.region_a_bottom as number;
    const bLeft = args.region_b_left as number;
    const bTop = args.region_b_top as number;
    const bRight = args.region_b_right as number;
    const bBottom = args.region_b_bottom as number;
    const labelA = (args.label_a as string) ?? 'A';
    const labelB = (args.label_b as string) ?? 'B';

    const script = `
      ${getContextInfo}

      if (app.documents.length === 0) throw new Error('No document is open in Photoshop');
      var doc = app.activeDocument;

      function statsForRect(left, top, right, bottom) {
        // Select the rect, then read histograms of R/G/B channels.
        // For a 1x1 rect, this still works — selection of a single pixel.
        doc.selection.select(
          [[left, top], [right, top], [right, bottom], [left, bottom]],
          SelectionType.REPLACE, 0, false
        );
        function chanStats(hist) {
          var sum = 0, count = 0, vals = [];
          for (var i = 0; i < 256; i++) {
            sum += i * hist[i];
            count += hist[i];
          }
          var mean = count > 0 ? sum / count : 0;
          var varSum = 0;
          for (var j = 0; j < 256; j++) {
            varSum += hist[j] * (j - mean) * (j - mean);
          }
          var stdev = count > 0 ? Math.sqrt(varSum / count) : 0;
          // median: cumulative until half
          var cum = 0; var median = 0;
          for (var k = 0; k < 256; k++) {
            cum += hist[k];
            if (cum >= count / 2) { median = k; break; }
          }
          return { mean: mean, stdev: stdev, median: median, total: count };
        }
        var r = chanStats(doc.channels[0].histogram);
        var g = chanStats(doc.channels[1].histogram);
        var b = chanStats(doc.channels[2].histogram);
        var lum = 0.299 * r.mean + 0.587 * g.mean + 0.114 * b.mean;
        return {
          width: right - left,
          height: bottom - top,
          pixel_count: r.total,
          red: r,
          green: g,
          blue: b,
          luminosity_mean: lum
        };
      }

      var statsA = statsForRect(${jsNum(aLeft, 0)}, ${jsNum(aTop, 0)}, ${jsNum(aRight, 1)}, ${jsNum(aBottom, 1)});
      var statsB = statsForRect(${jsNum(bLeft, 0)}, ${jsNum(bTop, 0)}, ${jsNum(bRight, 1)}, ${jsNum(bBottom, 1)});
      doc.selection.deselect();

      var diff = {
        red_mean_diff: statsB.red.mean - statsA.red.mean,
        green_mean_diff: statsB.green.mean - statsA.green.mean,
        blue_mean_diff: statsB.blue.mean - statsA.blue.mean,
        luminosity_mean_diff: statsB.luminosity_mean - statsA.luminosity_mean
      };

      return {
        region_a: { label: ${jsLit(labelA)}, stats: statsA },
        region_b: { label: ${jsLit(labelB)}, stats: statsB },
        differences: diff,
        context: getContextInfo()
      };
    `;

    const result = (await runScript(connection, script)) as {
      region_a?: { label: string; stats: { luminosity_mean: number; red: { mean: number } } };
      region_b?: { label: string; stats: { luminosity_mean: number; red: { mean: number } } };
      differences?: { luminosity_mean_diff: number };
    };

    const a = result.region_a;
    const b = result.region_b;
    const dLum = result.differences?.luminosity_mean_diff ?? 0;
    const summary =
      a && b
        ? `Region ${a.label} mean luminance ${a.stats.luminosity_mean.toFixed(1)}; Region ${b.label} mean luminance ${b.stats.luminosity_mean.toFixed(1)}; diff ${dLum.toFixed(1)}.`
        : 'Region comparison complete.';

    return {
      content: [{ type: 'text' as const, text: summary }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  } catch (error) {
    return toolErrorResult('Error comparing regions', error);
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
