import { readFile } from 'node:fs/promises';
import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import type { SnippetClient } from '../api/snippet-client.js';
import { runScript } from '../utils/run-script.js';
import { TempDir } from '../utils/temp.js';
import { validateArgs, type JsonSchemaObject, type JsonSchemaProperty } from '../utils/validate.js';
import { toolErrorResult, runSnippetTool, unknownDiscriminator } from '../utils/tool-helpers.js';
import { type DetectionClient } from '../detection/detection-client.js';
import { OnnxLandmarkDetectionClient } from '../detection/landmark-detection-client.js';
import { resolveExpectedPlacement, PLACEMENT_SCHEMA } from '../perception/grounding-locate.js';
import {
  SELECT_SUBJECT_TIMEOUT_MS,
  SELECT_SKY_TIMEOUT_MS,
  SELECT_FOCUS_AREA_TIMEOUT_MS,
} from '../utils/operation-timeouts.js';

// ---------- Shared schema fragments ----------
//
// selectionTypeFragment / selectionInfoFragment are used across this file's
// selection tools — including the Sensei ps_select_subject / ps_select_sky pair,
// which moved here from selection-tools-pro.ts when they became community tier.

export const SELECTION_TYPE_ENUM = ['replace', 'add', 'subtract', 'intersect'] as const;

export const selectionTypeFragment = {
  type: 'string' as const,
  enum: ['replace', 'add', 'subtract', 'intersect'],
  description:
    "How this selection combines with any existing one. 'replace' (default) overwrites; 'add' unions with the existing selection; 'subtract' removes this from the existing; 'intersect' keeps only the overlap.",
  default: 'replace',
};

// The selection_info bundle returned by every selection tool. The inner
// shape is enumerated here so the LLM can program against fields like
// `selection_info.area_percent` and `selection_info.edge_complexity`
// without reading the source.
export const selectionInfoFragment = {
  type: 'object' as const,
  description:
    'Rich post-op stats. Use these to verify the selection actually grabbed what was intended before committing it to a mask. `has_selection:false` short-circuits the rest of the fields (they will be absent).',
  properties: {
    has_selection: { type: 'boolean' },
    bounds: {
      type: 'object',
      description: 'Pixel bounding box of the selection (omitted when has_selection is false).',
      properties: {
        left: { type: 'number' },
        top: { type: 'number' },
        right: { type: 'number' },
        bottom: { type: 'number' },
      },
    },
    bounds_width: { type: 'number' },
    bounds_height: { type: 'number' },
    bounds_area: { type: 'number', description: 'Bounding-box area in px².' },
    pixel_count: {
      type: 'number',
      description:
        'Coverage-weighted total selected area (sum of coverage/255 over all pixels). Best single metric for "how much area is selected."',
    },
    pixels_with_any_selection: {
      type: 'number',
      description: 'Count of pixels with non-zero selection coverage.',
    },
    fully_selected_pixels: {
      type: 'number',
      description: 'Count of pixels at coverage 255 (fully selected).',
    },
    partial_pixels: {
      type: 'number',
      description:
        'Count of pixels with coverage 1-254 (anti-aliased or feathered edge). High = soft selection.',
    },
    area_percent: {
      type: 'number',
      description: '0-100: pixel_count divided by canvas area, ×100.',
    },
    bounds_fill_ratio: {
      type: 'number',
      description:
        '0-1: pixel_count divided by bounding-box area. Low (<0.4) suggests a patchy or holey selection — magic wand often produces these.',
    },
    edge_complexity: {
      type: 'number',
      description:
        '0-1: partial_pixels divided by pixels_with_any_selection. Near 0 = hard-edged rectangle; >0.1 = significant anti-alias/feather; very high on tricky organic edges like hair.',
    },
    error: {
      type: 'string',
      description: 'Set only when the temp-channel histogram step itself failed.',
    },
  },
};

// ---------- Schemas ----------

const emptySchema: JsonSchemaObject = {
  type: 'object',
  properties: {},
};

const selectRectangleSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    left: { type: 'number', description: 'Left edge in pixels', minimum: 0 },
    top: { type: 'number', description: 'Top edge in pixels', minimum: 0 },
    right: { type: 'number', description: 'Right edge in pixels', minimum: 1 },
    bottom: { type: 'number', description: 'Bottom edge in pixels', minimum: 1 },
    feather_px: {
      type: 'number',
      description:
        'Feather the selection edge by this many pixels after creating it. Default 0 (hard edge). REQUIRED for regional adjustments in smooth areas like open sky — a hard rectangular selection will produce a visible block-edge artifact when an adjustment is applied. Typical values: 40-180.',
      minimum: 0,
      default: 0,
    },
    placement: {
      ...PLACEMENT_SCHEMA,
      description:
        'Grounded alternative to left/top/right/bottom: NAME the region (a `placement` resolving to a REGION — relation `inside` / `gap`) and the selection is its resolved, gate-verified bounding box. Wins over the raw edges. Provide THIS or left+top+right+bottom.',
    },
    selection_type: selectionTypeFragment,
  },
  // left/top/right/bottom OR placement — enforced in the handler.
};

const featherSelectionSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    radius_px: {
      type: 'number',
      description: 'Feather radius in pixels (must be > 0).',
      minimum: 0.1,
    },
  },
  required: ['radius_px'],
};

const selectColorRangeSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    red: { type: 'integer', description: 'Target red (0-255).', minimum: 0, maximum: 255 },
    green: { type: 'integer', description: 'Target green (0-255).', minimum: 0, maximum: 255 },
    blue: { type: 'integer', description: 'Target blue (0-255).', minimum: 0, maximum: 255 },
    fuzziness: {
      type: 'integer',
      description:
        'Tolerance around the target color (0-200). Higher = wider color range selected. Default 40.',
      minimum: 0,
      maximum: 200,
      default: 40,
    },
    selection_type: selectionTypeFragment,
  },
  required: ['red', 'green', 'blue'],
};

const selectLuminanceRangeSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    luminance: {
      type: 'string',
      enum: ['highlights', 'shadows', 'midtones'],
      description: 'Which tonal band to select by brightness.',
    },
    fuzziness: {
      type: 'integer',
      description: 'Selection softness / spread (0-200). PS default 40.',
      minimum: 0,
      maximum: 200,
      default: 40,
    },
    lower_limit: {
      type: 'integer',
      description:
        'highlights/midtones: lower brightness bound (0-255). Default 190 (highlights) / 105 (midtones).',
      minimum: 0,
      maximum: 255,
    },
    upper_limit: {
      type: 'integer',
      description:
        'shadows/midtones: upper brightness bound (0-255). Default 65 (shadows) / 150 (midtones).',
      minimum: 0,
      maximum: 255,
    },
    selection_type: selectionTypeFragment,
  },
  required: ['luminance'],
};

const refineEdgeSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    smooth: {
      type: 'integer',
      description: 'Smooth the selection edge (0-100).',
      minimum: 0,
      maximum: 100,
      default: 0,
    },
    feather: {
      type: 'number',
      description: 'Feather radius in pixels (0-1000) — softens the edge.',
      minimum: 0,
      maximum: 1000,
      default: 0,
    },
    contrast: {
      type: 'number',
      description: 'Edge contrast percent (0-100) — re-sharpens an over-soft edge.',
      minimum: 0,
      maximum: 100,
      default: 0,
    },
    shift_edge: {
      type: 'number',
      description: 'Shift the edge inward (negative) or outward (positive), percent (-100 to 100).',
      minimum: -100,
      maximum: 100,
      default: 0,
    },
    radius: {
      type: 'integer',
      description:
        'Edge-detection radius in pixels (0-250) — helps capture soft/fuzzy edges (hair).',
      minimum: 0,
      maximum: 250,
      default: 0,
    },
    decontaminate: {
      type: 'boolean',
      description: 'Decontaminate edge colors (removes color fringing).',
      default: false,
    },
  },
};

const magicWandSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    x: { type: 'integer', description: 'Click X in document pixel coords.', minimum: 0 },
    y: { type: 'integer', description: 'Click Y in document pixel coords.', minimum: 0 },
    tolerance: {
      type: 'integer',
      description: 'Color similarity tolerance (0-255). Default 32.',
      minimum: 0,
      maximum: 255,
      default: 32,
    },
    contiguous: {
      type: 'boolean',
      description: 'If true (default), only selects connected matching pixels.',
      default: true,
    },
    anti_alias: {
      type: 'boolean',
      description: 'Soften the selection edge. Default true.',
      default: true,
    },
    sample_all_layers: {
      type: 'boolean',
      description:
        'If true, samples color across all visible layers. If false (default), samples the active layer only.',
      default: false,
    },
    placement: {
      ...PLACEMENT_SCHEMA,
      description:
        'Grounded alternative to x/y: NAME the click point (a `placement` resolving to a POINT — a centroid, extremum, grid intersection) and the wand clicks the resolved, gate-verified point. Wins over the raw x/y. Provide THIS or x + y.',
    },
    selection_type: selectionTypeFragment,
  },
  // x/y OR placement — enforced in the handler.
};

const selectEllipseSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    left: { type: 'number', description: 'Left edge of the bounding box, in pixels', minimum: 0 },
    top: { type: 'number', description: 'Top edge of the bounding box, in pixels', minimum: 0 },
    right: { type: 'number', description: 'Right edge of the bounding box, in pixels', minimum: 1 },
    bottom: {
      type: 'number',
      description: 'Bottom edge of the bounding box, in pixels',
      minimum: 1,
    },
    anti_alias: {
      type: 'boolean',
      description: 'Soften the selection edge. Default true.',
      default: true,
    },
    feather_px: {
      type: 'number',
      description:
        'Feather the selection edge by this many pixels as it is created (bakes into the same op). Default 0 (hard edge).',
      minimum: 0,
      default: 0,
    },
    placement: {
      ...PLACEMENT_SCHEMA,
      description:
        'Grounded alternative to left/top/right/bottom: NAME the region (a `placement` resolving to a REGION) and the ellipse is inscribed in its resolved, gate-verified bounding box. Wins over the raw edges. Provide THIS or left+top+right+bottom.',
    },
    selection_type: selectionTypeFragment,
  },
  // left/top/right/bottom OR placement — enforced in the handler.
};

// Shared by ps_select's deprecated mode=grow/similar AND ps_modify_selection's
// op=grow/similar (moved here 2026-08-10 — both require an active selection,
// which is ps_modify_selection's contract, not ps_select's). Both paths build
// the identical `growSelection` snippet from these same params.
const growSelectionSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    tolerance: {
      type: 'integer',
      description:
        'Color similarity tolerance (0-255) for which neighbouring pixels are added. Default 32.',
      minimum: 0,
      maximum: 255,
      default: 32,
    },
    anti_alias: {
      type: 'boolean',
      description: 'Soften the selection edge. Default true.',
      default: true,
    },
  },
};

// color_range preset modes (skin_tones / out_of_gamut). out_of_gamut takes no
// params; skin_tones takes fuzziness (shared key with color_range) + use_faces.
// Also used directly for handler validation, so it carries selection_type.
const colorPresetSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    fuzziness: {
      type: 'integer',
      description: 'skin_tones: tolerance/spread around skin-tone colours (0-200). Default 40.',
      minimum: 0,
      maximum: 200,
      default: 40,
    },
    use_faces: {
      type: 'boolean',
      description:
        'skin_tones only: refine the skin-tone selection using face detection. Default false (pure Lab skin-tone colour preset, no AI dependency).',
      default: false,
    },
    selection_type: selectionTypeFragment,
  },
};

// selectPolygon — absolute-coordinate vertex list. Covers polygonal/freehand/
// magnetic lasso (all bake to the same Plgn point list). The ring auto-closes.
// NOTE: this is a coordinate-driven selector; aiming requires knowing the pixel
// positions (pair with ps_inspect / ps_get_preview). To aim without reading a
// pixel, name the target instead — ps_select_by_reference or a spatial-grounding
// selector — rather than the retired coordinate-grid readout.
const selectPolygonSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    points: {
      type: 'array',
      description:
        'Polygon vertices in ABSOLUTE document pixels: [{x, y}, ...], minimum 3. (0,0) is top-left. The ring auto-closes (last vertex connects back to the first). You must know the pixel coordinates to aim this — pair with ps_inspect (dimensions) / ps_get_preview (content). Covers polygonal/freehand/magnetic lasso shapes.',
      minItems: 3,
      items: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'Vertex X in document pixels.' },
          y: { type: 'number', description: 'Vertex Y in document pixels.' },
        },
        required: ['x', 'y'],
      },
    },
    anti_alias: {
      type: 'boolean',
      description: 'Soften the selection edge. Default true.',
      default: true,
    },
    selection_type: selectionTypeFragment,
  },
  required: ['points'],
};

// modify_selection edge ops (expand/contract/border/smooth). `amount` is the
// pixel distance/radius/width; `at_canvas_bounds` applies to expand/contract/
// smooth (ignored by border).
const modifyEdgeSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    amount: {
      type: 'number',
      description:
        'Pixel amount: expand/contract distance, smooth radius, or border width. Required for expand/contract/border/smooth.',
      minimum: 1,
    },
    at_canvas_bounds: {
      type: 'boolean',
      description:
        'expand/contract/smooth: if true, the effect still applies where the selection meets the canvas edge. Default false.',
      default: false,
    },
  },
  required: ['amount'],
};

// transform_selection op — relative geometric transform of the marching ants
// (not pixels). All defaults are identity (100% / 0° / 0px).
const transformSelectionSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    scale_x_percent: {
      type: 'number',
      description: 'Horizontal scale of the selection, percent. Default 100 (no change).',
      minimum: 1,
      default: 100,
    },
    scale_y_percent: {
      type: 'number',
      description: 'Vertical scale of the selection, percent. Default 100 (no change).',
      minimum: 1,
      default: 100,
    },
    rotate_degrees: {
      type: 'number',
      description: 'Rotate the selection clockwise, degrees. Default 0.',
      minimum: -360,
      maximum: 360,
      default: 0,
    },
    offset_x: {
      type: 'number',
      description: 'Translate the selection horizontally, pixels (relative). Default 0.',
      default: 0,
    },
    offset_y: {
      type: 'number',
      description: 'Translate the selection vertically, pixels (relative). Default 0.',
      default: 0,
    },
  },
};

const selectionPreviewSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    max_dimension: {
      type: 'integer',
      description: 'Long-edge pixel cap for the returned images. Default 800.',
      minimum: 128,
      maximum: 4096,
      default: 800,
    },
  },
};

const saveSelectionToChannelSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    channel_name: {
      type: 'string',
      description:
        'Name for the Alpha channel. If a channel with this name already exists it is overwritten.',
    },
  },
  required: ['channel_name'],
};

const loadSelectionFromChannelSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    channel_name: {
      type: 'string',
      description:
        'Name of the Alpha channel to restore. Must have been previously saved with ps_selection_channel (op=save).',
    },
    operation: selectionTypeFragment,
  },
  required: ['channel_name'],
};

const duplicateChannelSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    channel_name: {
      type: 'string',
      description: 'Name of the existing alpha/spot channel to duplicate.',
    },
    new_channel_name: {
      type: 'string',
      description:
        'Optional name for the duplicate. Photoshop auto-names it "<source> copy" when omitted.',
    },
  },
  required: ['channel_name'],
};

const deleteChannelSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    channel_name: {
      type: 'string',
      description:
        'Name of the alpha/spot channel to delete. Component (RGB/CMYK/Lab) channels are refused.',
    },
  },
  required: ['channel_name'],
};

// ---------- Consolidated schemas (Phase 1, 2026-06-20) ----------

// 'grow'/'similar' are DEPRECATED (2026-08-10) — moved to
// ps_modify_selection's `op`, since both require an existing selection
// (ps_modify_selection's contract) rather than creating one. Kept here for
// one release for backward compatibility — see the `select()` dispatcher.
const SELECT_MODES = [
  'all',
  'none',
  'inverse',
  'rectangle',
  'ellipse',
  'color_range',
  'luminance_range',
  'magic_wand',
  'grow',
  'similar',
  'skin_tones',
  'out_of_gamut',
  'polygon',
] as const;

// ps_select merges the geometric/color/wand selectors + all/none/inverse.
// Shared selection_type / fuzziness collide identically; the per-mode handler
// re-validates against its exact schema (required coords, ranges).
const SELECT_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    mode: {
      type: 'string',
      enum: [...SELECT_MODES],
      description:
        'all: select the whole canvas. none: deselect. inverse: invert the current selection. ' +
        'rectangle: left/top/right/bottom (+optional feather_px). ' +
        'ellipse: left/top/right/bottom bounding box (+anti_alias, +optional feather_px) — circles/ovals. ' +
        'color_range: target red/green/blue (+fuzziness) — "select all the red / skin". ' +
        'luminance_range: luminance highlights|shadows|midtones (+fuzziness, lower_limit, upper_limit) — glow/dodge-burn foundation. ' +
        'magic_wand: click x/y (+tolerance, contiguous, anti_alias, sample_all_layers). ' +
        'grow: DEPRECATED here — use ps_modify_selection(op=grow) instead (kept for one release for backward compatibility, identical behaviour). Expands the CURRENT selection to adjacent similar-colour pixels (+tolerance, anti_alias). ' +
        'similar: DEPRECATED here — use ps_modify_selection(op=similar) instead (kept for one release for backward compatibility, identical behaviour). Expands the CURRENT selection to ALL similar-colour pixels document-wide (+tolerance, anti_alias). ' +
        'skin_tones: select skin-coloured pixels (+fuzziness; use_faces=true adds face-aware refinement). ' +
        'out_of_gamut: select colours outside the printable CMYK gamut (no params). ' +
        'polygon: points [{x,y},...] in ABSOLUTE document pixels (min 3, auto-closes) — covers polygonal/freehand lasso. Coordinate-driven: you must know the pixel positions (use ps_inspect / ps_get_preview to aim, or ps_path create_from_placement → load_as_selection for a grounded outline). ' +
        'rectangle/ellipse/magic_wand also take a grounded `placement` instead of raw coords (region → the bbox; point → the wand click). ' +
        'rectangle/ellipse/polygon/color_range/luminance_range/magic_wand/skin_tones/out_of_gamut also take selection_type to combine with an existing selection.',
    },
    ...selectRectangleSchema.properties,
    ...selectColorRangeSchema.properties,
    ...selectLuminanceRangeSchema.properties,
    ...magicWandSchema.properties,
    ...colorPresetSchema.properties,
    ...selectPolygonSchema.properties,
    // Unified `placement` for the consolidated view (the per-mode spreads above each
    // carry their own; this overrides so the tool-level description covers all three:
    // rectangle/ellipse → a REGION bbox, magic_wand → a POINT click).
    placement: {
      ...PLACEMENT_SCHEMA,
      description:
        'Grounded coordinates (rectangle/ellipse/magic_wand): NAME anchors + a relation instead of guessing pixels. rectangle/ellipse ← a REGION relation (inside/gap) → the selection bounding box; magic_wand ← a POINT relation (centroid/extremum/grid) → the click. Verified by the objective gate; wins over the raw edges/x-y. See ps_resolve_placement for the vocabulary.',
    },
  },
  required: ['mode'],
};

const MODIFY_SELECTION_OPS = [
  'feather',
  'refine_edge',
  'expand',
  'contract',
  'border',
  'smooth',
  'transform',
  'grow',
  'similar',
] as const;

// ps_modify_selection merges feather + refine_edge + the four geometric
// edge ops (expand/contract/border/smooth) + grow/similar (colour-similarity
// growth — moved here from ps_select 2026-08-10, see growSelectionSchema).
// `radius`/`feather` (refine_edge), `radius_px` (feather), `amount`
// (geometric ops), and `tolerance`/`anti_alias` (grow/similar) are distinct
// fields so there are no collisions.
const MODIFY_SELECTION_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    op: {
      type: 'string',
      enum: [...MODIFY_SELECTION_OPS],
      description:
        'feather: soften the selection edge by radius_px. ' +
        'refine_edge: Select-and-Mask global sliders (smooth, feather, contrast, shift_edge, radius edge-detection, decontaminate) to clean halos / soft hair edges. ' +
        'expand: grow the selection outward by `amount` px. contract: shrink it inward by `amount` px. ' +
        'border: replace the selection with a `amount`-px-wide band straddling its edge. ' +
        'smooth: round off the selection corners with a `amount`-px radius. ' +
        'grow: expand the selection to adjacent similar-colour pixels (+tolerance, anti_alias). ' +
        'similar: expand the selection to ALL similar-colour pixels document-wide (+tolerance, anti_alias). ' +
        'transform: relatively scale (scale_x_percent / scale_y_percent), rotate (rotate_degrees) and/or translate (offset_x / offset_y) the marching ants — not pixels. ' +
        'expand/contract/border/smooth all require an active selection and take `amount`; expand/contract/smooth also take at_canvas_bounds. grow/similar also require an active selection.',
    },
    ...featherSelectionSchema.properties,
    ...refineEdgeSchema.properties,
    ...modifyEdgeSchema.properties,
    ...transformSelectionSchema.properties,
    ...growSelectionSchema.properties,
  },
  required: ['op'],
};

const SELECTION_CHANNEL_OPS = ['save', 'load', 'duplicate', 'delete'] as const;

// ps_selection_channel merges save/load + duplicate/delete of named Alpha channels.
const SELECTION_CHANNEL_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    op: {
      type: 'string',
      enum: [...SELECTION_CHANNEL_OPS],
      description:
        'save: store the current selection to a named Alpha channel (channel_name; overwrites if it exists). ' +
        'load: restore a saved Alpha channel as the selection (channel_name + operation to combine). ' +
        'duplicate: copy an existing alpha/spot channel (channel_name) to a new channel (optional new_channel_name; auto-named "<src> copy" otherwise). ' +
        'delete: remove an alpha/spot channel (channel_name). Refuses to delete component RGB/CMYK/Lab channels.',
    },
    ...saveSelectionToChannelSchema.properties,
    ...loadSelectionFromChannelSchema.properties,
    new_channel_name: {
      type: 'string',
      description:
        'duplicate only: name for the new channel. Optional — Photoshop auto-names it "<source> copy" when omitted.',
    },
  },
  required: ['op', 'channel_name'],
};

const LAYER_MASK_OPS = ['create', 'delete', 'apply', 'gradient'] as const;

// op=gradient fade params — shared between the tool schema and the
// stripped-op dispatch schema.
const MASK_GRADIENT_PROPS: Record<string, JsonSchemaProperty> = {
  fade_to: {
    type: 'string',
    enum: ['bottom', 'top', 'left', 'right'],
    description:
      'op=gradient: the side that ends fully HIDDEN (mask black). The opposite side stays fully visible. E.g. a water reflection fades with fade_to=bottom.',
    default: 'bottom',
  },
  start: {
    type: 'number',
    minimum: 0,
    maximum: 1,
    description:
      'op=gradient: 0-1 fraction along the fade direction where the fade begins — the layer stays fully visible up to here.',
    default: 0,
  },
  end: {
    type: 'number',
    minimum: 0,
    maximum: 1,
    description:
      'op=gradient: 0-1 fraction where the fade completes — fully hidden from here on. Must be greater than start.',
    default: 1,
  },
  extent: {
    type: 'string',
    enum: ['layer', 'canvas'],
    description:
      "op=gradient: measure start/end over the active layer's pixel bounds (default) or the whole canvas. A layer with no pixel bounds falls back to canvas.",
    default: 'layer',
  },
};

// ps_layer_mask merges create/delete/apply (param-free) + gradient (fade params).
const LAYER_MASK_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    op: {
      type: 'string',
      enum: [...LAYER_MASK_OPS],
      description:
        'create: add a layer mask on the active layer (if a selection is active it reveals the selection — the "mask to the frame opening" answer; adjustment layers load the selection into their built-in mask). ' +
        'delete: remove the mask (layer pixels preserved). ' +
        'apply: DESTRUCTIVE — bake the mask into pixels (pixels outside the mask are lost). ' +
        'gradient: draw a linear white→black fade INTO the mask (auto-creates a reveal-all mask if none) — the universal fade-out primitive (reflections, sky blends, edge feathering). REPLACES existing mask content.',
    },
    ...MASK_GRADIENT_PROPS,
  },
  required: ['op'],
};

// op=gradient sub-schema (op stripped before dispatch).
const MASK_GRADIENT_ARGS_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: { ...MASK_GRADIENT_PROPS },
};

// ---------- Factory ----------

export function createSelectionTools(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  // Backs anchor-relational `placement` on rectangle/ellipse (region) + magic_wand
  // (point); the other modes never touch it. Mesh-capable default (matches the
  // other grounded CE tools); a landmark anchor degrades to CE boxes without the mesh.
  client: DetectionClient = new OnnxLandmarkDetectionClient()
): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'ps_select',
        description:
          'Create a NEW selection — choose with `mode`. (To edit the CURRENT selection instead — including growing it by colour similarity — use ps_modify_selection.) `all` selects the canvas; `none` deselects; `inverse` inverts the current selection (e.g. select the subject, then inverse to act on the background). `rectangle` (left/top/right/bottom, optional feather_px to avoid hard block-edges in smooth sky). `ellipse` (left/top/right/bottom bounding box + anti_alias — circles/ovals). `color_range` (target red/green/blue + fuzziness — "select all the red / skin tones"). `luminance_range` (highlights/shadows/midtones — foundation for glow / dodge-burn). `magic_wand` (click x/y + tolerance, contiguous). `grow` / `similar` are DEPRECATED here (they act on the CURRENT selection, not a new one) — use ps_modify_selection(op=grow|similar) instead; kept for one release for backward compatibility, identical behaviour. rectangle/ellipse/magic_wand also accept a grounded `placement` (NAME a region/point instead of guessing pixels — resolved + gate-verified). The geometric/color/wand modes take selection_type (replace|add|subtract|intersect) to combine with an existing selection and return a rich selection_info bundle — verify it (or ps_get_selection_preview) before committing to a mask.',
        inputSchema: SELECT_INPUT_SCHEMA,
        outputSchema: {
          type: 'object',
          properties: {
            selection: { type: 'string' },
            selected: { type: 'boolean' },
            deselected: { type: 'boolean' },
            inverted: { type: 'boolean' },
            method: { type: 'string' },
            selection_type: { type: 'string' },
            requested_bounds: { type: 'array', items: { type: 'number' } },
            feather_px: { type: 'number' },
            target_color: { type: 'object' },
            fuzziness: { type: 'number' },
            luminance: { type: 'string' },
            lower_limit: { type: 'number' },
            upper_limit: { type: 'number' },
            sample_point: { type: 'object' },
            tolerance: { type: 'number' },
            contiguous: { type: 'boolean' },
            anti_alias: { type: 'boolean' },
            sample_all_layers: { type: 'boolean' },
            preset: { type: 'string' },
            point_count: { type: 'number' },
            placement: { type: 'object' },
            selection_info: selectionInfoFragment,
          },
        },
        annotations: {
          title: 'Select',
          idempotentHint: false,
        },
      },
      handler: async (args) => select(connection, snippetClient, client, args),
    },
    {
      tool: {
        name: 'ps_modify_selection',
        description:
          "Modify the CURRENT selection — choose with `op`. (To create a NEW selection instead, use ps_select.) `feather` softens by radius_px (use when a selection was made hard, e.g. after select all/inverse, before applying an adjustment). `refine_edge` runs Select-and-Mask's global sliders headlessly (smooth, feather, contrast, shift_edge, edge-detection radius, decontaminate) to clean halos and soft/fuzzy edges (hair) after a rough color-range / magic-wand / subject selection. `expand` / `contract` grow / shrink the selection by `amount` px. `border` replaces the selection with an `amount`-px band around its edge. `smooth` rounds the corners with an `amount`-px radius. `grow` / `similar` expand the selection to similar-colour pixels by `tolerance` (+anti_alias) — `grow` to adjacent pixels only, `similar` document-wide. `transform` relatively scales (scale_x_percent / scale_y_percent), rotates (rotate_degrees) and/or translates (offset_x / offset_y) the marching ants — pixels are untouched. All require an active selection and return selection_info.",
        inputSchema: MODIFY_SELECTION_INPUT_SCHEMA,
        outputSchema: {
          type: 'object',
          properties: {
            feathered: { type: 'boolean' },
            refined: { type: 'boolean' },
            modified: { type: 'boolean' },
            transformed: { type: 'boolean' },
            selected: { type: 'boolean', description: 'op=grow/similar: true on success.' },
            method: { type: 'string', description: 'op=grow/similar: "grow" or "similar".' },
            mode: { type: 'string' },
            amount_px: { type: 'number' },
            scale_x_percent: { type: 'number' },
            scale_y_percent: { type: 'number' },
            rotate_degrees: { type: 'number' },
            offset_x: { type: 'number' },
            offset_y: { type: 'number' },
            radius_px: { type: 'number' },
            radius: { type: 'number' },
            smooth: { type: 'number' },
            feather: { type: 'number' },
            contrast: { type: 'number' },
            shift_edge: { type: 'number' },
            decontaminate: { type: 'boolean' },
            tolerance: { type: 'number', description: 'op=grow/similar: tolerance used.' },
            anti_alias: { type: 'boolean', description: 'op=grow/similar: anti_alias used.' },
            output: { type: 'string' },
            selection_info: selectionInfoFragment,
          },
        },
        annotations: {
          title: 'Modify Selection',
          idempotentHint: false,
        },
      },
      handler: async (args) => modifySelection(connection, snippetClient, args),
    },
    // The old dedicated get_selection_info reader merged into
    // ps_inspect(what='selection_info') on 2026-06-26 (Phase 1b).
    // getSelectionInfoHandler is exported below for inspect-tools.ts.
    {
      tool: {
        name: 'ps_get_selection_preview',
        description:
          'Render TWO inline JPEGs so the agent can visually verify what is currently selected: (1) an OVERLAY of the document with a 50% red wash over the selected area (Quick Mask-style — most intuitive); (2) a B/W MASK where black = selected, white = not. Heavier than the selection_info bundle (~2-4s) — call this when the stats look off or before committing a mask. Does NOT modify the source document.',
        inputSchema: selectionPreviewSchema,
        outputSchema: {
          type: 'object',
          properties: {
            rendered: { type: 'boolean' },
            max_dimension: { type: 'number' },
            overlay_bytes: { type: 'number' },
            mask_bytes: { type: 'number' },
            selection_info: selectionInfoFragment,
          },
        },
        annotations: {
          title: 'Get Selection Preview (overlay + mask)',
          readOnlyHint: true,
          idempotentHint: true,
        },
      },
      handler: async (args) => getSelectionPreview(connection, snippetClient, args),
    },
    {
      tool: {
        name: 'ps_layer_mask',
        description:
          'Manage the active layer\'s mask — choose with `op`. `create`: add a layer mask; if a selection is active it reveals the selection and hides the rest (the one-call "mask the placed image to the frame opening" — make the selection first, then create); with no selection, a reveal-all mask; adjustment layers load the current selection into their built-in mask. `delete`: remove the mask (layer pixels preserved). `apply`: DESTRUCTIVE — permanently bake the mask into the pixels (outside-mask pixels lost). `gradient`: draw a linear fade into the mask (fade_to names the side that ends hidden; start/end place the fade; auto-creates the mask; replaces existing mask content and clears any active selection first) — the standard fade for reflections, sky blends, and soft edge falloff. Verify with ps_get_preview. Prefer keeping masks non-destructive unless flattening for export. **Don\'t write `Mk Chnl At=Msk` or `Grdn` AM scripts in execute_script — this tool already does both.**',
        inputSchema: LAYER_MASK_INPUT_SCHEMA,
        outputSchema: {
          type: 'object',
          properties: {
            maskCreated: { type: 'boolean' },
            modifiedExistingMask: { type: 'boolean' },
            activeLayerKind: { type: 'string' },
            hadSelection: { type: 'boolean' },
            maskDeleted: { type: 'boolean' },
            maskApplied: { type: 'boolean' },
            mask_gradient: { type: 'boolean' },
            created_mask: {
              type: 'boolean',
              description: 'op=gradient: true when the reveal-all mask had to be created first.',
            },
            fade_to: { type: 'string' },
            from: {
              type: 'object',
              description: 'op=gradient: fully-visible end of the drawn fade, doc pixels.',
            },
            to: {
              type: 'object',
              description: 'op=gradient: fully-hidden end of the drawn fade, doc pixels.',
            },
            extent: {
              type: 'string',
              description: "op=gradient: 'layer' or 'canvas' — reports the extent actually used.",
            },
            bounds_used: { type: 'object' },
            layer_name: { type: 'string' },
            context: { type: 'object' },
          },
        },
        annotations: {
          title: 'Layer Mask',
          destructiveHint: true,
        },
      },
      handler: async (args) => layerMask(connection, snippetClient, args),
    },
    {
      tool: {
        name: 'ps_selection_channel',
        description:
          "Persist, restore, or manage a named Alpha channel — choose with `op`. `save`: store the current selection to channel_name (overwrites if it exists) so a complex AI/multi-step/feathered selection can be reloaded without rebuilding (throws if no active selection). `load`: restore a saved channel as the selection, with `operation` (replace|add|subtract|intersect) to combine — reapply one selection across layers. `duplicate`: copy an existing alpha/spot channel to a new one (optional new_channel_name). `delete`: remove an alpha/spot channel (won't touch the RGB/CMYK/Lab component channels).",
        inputSchema: SELECTION_CHANNEL_INPUT_SCHEMA,
        outputSchema: {
          type: 'object',
          properties: {
            saved: { type: 'boolean' },
            loaded: { type: 'boolean' },
            duplicated: { type: 'boolean' },
            deleted: { type: 'boolean' },
            channel_name: { type: 'string' },
            new_channel_name: { type: 'string' },
            overwritten: {
              type: 'boolean',
              description: 'True if an existing channel with the same name was replaced.',
            },
            channel_count: {
              type: 'number',
              description: 'Total channels in the document after the op.',
            },
            operation: { type: 'string' },
            selection_info: selectionInfoFragment,
          },
        },
        annotations: {
          title: 'Selection Channel',
          idempotentHint: false,
        },
      },
      handler: async (args) => selectionChannel(connection, snippetClient, args),
    },
    // ps_select_subject + ps_select_sky (Adobe Sensei) — community tier.
    // Moved from the deleted selection-tools-pro.ts; their
    // go-core selectSubject/selectSky emitters likewise moved to the community binary.
    {
      tool: {
        name: 'ps_select_subject',
        description:
          'Run Photoshop\'s "Select Subject" (Adobe Sensei). One-call selection of the main subject — person, animal, product, etc. ~2-5s on typical images. Default sample_all_layers=true analyzes the full visible composite, which matches PS 2025 behavior and works around the PS 2026 "active layer only" default that fails opaquely when the active layer is a blurred / adjusted copy. Combines with existing selection via selection_type. Returns selection_info so the agent can verify area / edge complexity; if results look off, call ps_get_selection_preview for a visual. On failure, the error message lists fallbacks (Cloud processing in PS Preferences, manual UI selection).',
        inputSchema: selectSubjectSchema,
        outputSchema: {
          type: 'object',
          properties: {
            selected: { type: 'boolean' },
            method: { type: 'string' },
            strategy_used: {
              type: 'string',
              description:
                '"dom:selectSubject" (preferred — DOM method, PS handles descriptor internals) or "executeAction:autoCutout" (legacy AM fallback). Telemetry surface: lets us see in the field whether the DOM path needs widening.',
            },
            sample_all_layers: { type: 'boolean' },
            active_layer_temporarily_changed: {
              type: 'boolean',
              description:
                'True if we temporarily switched the active layer to the bottom layer during detection (to work around PS 2026 "active layer only" behavior when sample_all_layers=true). Original active layer is restored before return.',
            },
            selection_type: { type: 'string' },
            selection_info: selectionInfoFragment,
          },
        },
        annotations: {
          title: 'Select Subject (Sensei)',
          idempotentHint: true,
        },
      },
      handler: async (args) => selectSubject(connection, snippetClient, args),
    },
    {
      tool: {
        name: 'ps_select_sky',
        description:
          'Run Photoshop\'s "Select Sky" (Adobe Sensei, PS 2021+). One-call sky masking for landscape work. Default sample_all_layers=true analyzes the full visible composite. Returns selection_info — high edge_complexity on tricky horizons (foreground objects against sky) is the signal to verify with ps_get_selection_preview before committing.',
        inputSchema: selectSkySchema,
        outputSchema: {
          type: 'object',
          properties: {
            selected: { type: 'boolean' },
            method: { type: 'string' },
            strategy_used: {
              type: 'string',
              description:
                '"dom:selectSky" (preferred DOM method when exposed) or "executeAction:selectSky" (AM fallback).',
            },
            sample_all_layers: { type: 'boolean' },
            active_layer_temporarily_changed: {
              type: 'boolean',
              description:
                'True if active layer was temporarily switched to the bottom layer during detection. Restored before return.',
            },
            selection_type: { type: 'string' },
            selection_info: selectionInfoFragment,
          },
        },
        annotations: {
          title: 'Select Sky (Sensei)',
          idempotentHint: true,
        },
      },
      handler: async (args) => selectSky(connection, snippetClient, args),
    },
    // ps_select_focus_area — dev tier. Standalone on purpose: a parameter
    // cannot be tiered, so it ships as its own gated tool and folds into
    // ps_select as mode=focus_area at promotion (the ps_smart_filter → ps_filter
    // precedent). Delete this entry in the same commit as the fold.
    {
      tool: {
        name: 'ps_select_focus_area',
        description:
          'Run Photoshop\'s "Focus Area" — select what the lens rendered SHARP, by depth of field rather than by subject or colour. Use it when the thing you want is defined by focus and not by what it is: lifting a subject off a bokeh background, masking the in-focus plane of a macro shot, or grabbing a shallow-depth foreground that Select Subject splits badly. Takes NO coordinates. in_focus_radius widens (higher) or narrows (lower) what counts as sharp; soft_mask=true gives feathered edges instead of a hard boundary. Analyses the ACTIVE layer, so target the photographic pixels you mean: if the active layer is anything other than an ordinary raster layer (adjustment, empty, smart object, text, shape), detection is retargeted to the bottom layer and active_layer_temporarily_changed comes back true — check it, because the analysed layer was then NOT the one you selected. ALWAYS read the returned selection_info: a uniformly sharp image (or too high an in_focus_radius) selects the WHOLE canvas and still reports success, so area_percent near 100 means the result is useless rather than correct.',
        inputSchema: selectFocusAreaSchema,
        outputSchema: {
          type: 'object',
          properties: {
            selected: { type: 'boolean' },
            method: { type: 'string' },
            strategy_used: { type: 'string' },
            in_focus_radius: { type: 'number' },
            soft_mask: { type: 'boolean' },
            active_layer_temporarily_changed: {
              type: 'boolean',
              description:
                'True if the active layer was not an ordinary pixel layer and detection was temporarily retargeted to the bottom layer. The original active layer is restored before return.',
            },
            whole_canvas_selected: {
              type: 'boolean',
              description:
                'True when the result covers essentially the entire canvas — usually a non-result (radius too high, or nothing photographic to analyse) rather than a correct answer. Check this before committing to a mask.',
            },
            warning: { type: ['string', 'null'] },
            selection_type: { type: 'string' },
            selection_info: selectionInfoFragment,
          },
        },
        annotations: {
          title: 'Select Focus Area',
          idempotentHint: true,
        },
      },
      handler: async (args) => selectFocusArea(connection, snippetClient, args),
    },
  ];
}

// ---------- Sensei selections (community tier) ----------
// Moved verbatim from selection-tools-pro.ts (deleted). CE-shipped now; the go-core
// selectSubject/selectSky snippets moved to the community binary in the same change.

const selectSubjectSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    sample_all_layers: {
      type: 'boolean',
      description:
        'If true (default), the model considers all visible layers — matches PS 2025 behavior and the user mental model of "select the subject of this image." If false, considers only the active layer (PS 2026 menu default — but on processed/blurred active layers this often yields "no subject" and an opaque "parameters not valid" error). Override to false only when you specifically want layer-isolated detection.',
      default: true,
    },
    selection_type: selectionTypeFragment,
  },
};

const selectSkySchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    sample_all_layers: {
      type: 'boolean',
      description:
        'If true (default), the sky model considers all visible layers — the correct setting for most workflows. If false, considers only the active layer.',
      default: true,
    },
    selection_type: selectionTypeFragment,
  },
};

// Focus Area takes no coordinates and no sample_all_layers — the descriptor has
// no such field, so the PS 2026 active-layer workaround that selectSubject /
// selectSky carry does not apply here and is deliberately absent.
const selectFocusAreaSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    in_focus_radius: {
      type: 'number',
      description:
        'How much blur still counts as "in focus", in pixels. Higher pulls more of the soft transition zone into the selection; lower keeps only the crisply resolved plane. 4.07 is the Photoshop dialog default and a sane starting point. The useful band is narrow — measured live, a radius of 40 selected 100% of the canvas — so move in small steps and CHECK selection_info.area_percent: a value near 100 means the radius is too high and the selection is worthless, even though the call reports success.',
      default: 4.07,
      minimum: 0.1,
      maximum: 15,
    },
    soft_mask: {
      type: 'boolean',
      description:
        'False (default) yields a hard-edged selection — every pixel fully in or fully out, which is what you want before ps_modify_selection feathering. True lets Photoshop feather the focus falloff itself, useful when the subject edge is genuinely gradual (hair, fur, motion).',
      default: false,
    },
    selection_type: selectionTypeFragment,
  },
};

async function selectFocusArea(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: selectFocusAreaSchema,
    snippet: 'selectFocusArea',
    errorPrefix: 'Error running Focus Area selection',
    timeoutMs: SELECT_FOCUS_AREA_TIMEOUT_MS,
    params: (args) => ({
      inFocusRadius: (args.in_focus_radius as number) ?? 4.07,
      softMask: (args.soft_mask as boolean) ?? false,
      selectionType: normalizeSelectionType(args.selection_type),
    }),
    successText: (_result, args) =>
      `Focus Area selection (${normalizeSelectionType(args.selection_type)}) complete`,
  });
}

async function selectSubject(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: selectSubjectSchema,
    snippet: 'selectSubject',
    errorPrefix: 'Error running Select Subject',
    timeoutMs: SELECT_SUBJECT_TIMEOUT_MS,
    params: (args) => ({
      sampleAllLayers: (args.sample_all_layers as boolean) ?? true,
      selectionType: normalizeSelectionType(args.selection_type),
    }),
    successText: (_result, args) =>
      `Select Subject (${normalizeSelectionType(args.selection_type)}) complete`,
  });
}

async function selectSky(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: selectSkySchema,
    snippet: 'selectSky',
    errorPrefix: 'Error running Select Sky',
    timeoutMs: SELECT_SKY_TIMEOUT_MS,
    params: (args) => ({
      sampleAllLayers: (args.sample_all_layers as boolean) ?? true,
      selectionType: normalizeSelectionType(args.selection_type),
    }),
    successText: (_result, args) =>
      `Select Sky (${normalizeSelectionType(args.selection_type)}) complete`,
  });
}

// ---------- Consolidated dispatchers (Phase 1, 2026-06-20) ----------
// unknownDiscriminator moved to tool-helpers.ts when ps_clipping_mask joined
// the op-discriminated family from another module.

// ps_select → per-mode selector. `mode` is stripped so the delegate
// validates only its own params.
async function select(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  detClient: DetectionClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  const mode = rawArgs.mode;
  const { mode: _omit, ...rest } = rawArgs;
  switch (mode) {
    case 'all':
      return selectAll(connection, snippetClient);
    case 'none':
      return deselect(connection, snippetClient);
    case 'inverse':
      return invertSelection(connection, snippetClient);
    case 'rectangle':
      return selectRectangle(connection, snippetClient, detClient, rest);
    case 'ellipse':
      return selectEllipse(connection, snippetClient, detClient, rest);
    case 'color_range':
      return selectColorRange(connection, snippetClient, rest);
    case 'luminance_range':
      return selectLuminanceRange(connection, snippetClient, rest);
    case 'magic_wand':
      return magicWand(connection, snippetClient, detClient, rest);
    // DEPRECATED here (2026-08-10) — grow/similar moved to ps_modify_selection's
    // `op`. Kept accepting these mode values for one release so existing callers
    // don't break; identical dispatch, same growSelection snippet + params.
    case 'grow':
      return growSelection(connection, snippetClient, 'grow', rest);
    case 'similar':
      return growSelection(connection, snippetClient, 'similar', rest);
    case 'skin_tones':
      return selectColorPreset(connection, snippetClient, 'skin_tones', rest);
    case 'out_of_gamut':
      return selectColorPreset(connection, snippetClient, 'out_of_gamut', rest);
    case 'polygon':
      return selectPolygon(connection, snippetClient, rest);
    default:
      return unknownDiscriminator('select mode', mode, SELECT_MODES);
  }
}

// ps_modify_selection → feather / refine_edge / expand / contract / border /
// smooth / transform / grow / similar.
async function modifySelection(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  const op = rawArgs.op;
  const { op: _omit, ...rest } = rawArgs;
  switch (op) {
    case 'feather':
      return featherSelection(connection, snippetClient, rest);
    case 'refine_edge':
      return refineEdge(connection, snippetClient, rest);
    case 'expand':
    case 'contract':
    case 'border':
    case 'smooth':
      return modifySelectionEdge(connection, snippetClient, op, rest);
    case 'transform':
      return transformSelection(connection, snippetClient, rest);
    case 'grow':
      return growSelection(connection, snippetClient, 'grow', rest);
    case 'similar':
      return growSelection(connection, snippetClient, 'similar', rest);
    default:
      return unknownDiscriminator('modify_selection op', op, MODIFY_SELECTION_OPS);
  }
}

// ps_selection_channel → save / load.
async function selectionChannel(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  const op = rawArgs.op;
  const { op: _omit, ...rest } = rawArgs;
  switch (op) {
    case 'save':
      return saveSelectionToChannel(connection, snippetClient, rest);
    case 'load':
      return loadSelectionFromChannel(connection, snippetClient, rest);
    case 'duplicate':
      return duplicateChannel(connection, snippetClient, rest);
    case 'delete':
      return deleteChannel(connection, snippetClient, rest);
    default:
      return unknownDiscriminator('selection_channel op', op, SELECTION_CHANNEL_OPS);
  }
}

// ps_layer_mask → create / delete / apply (param-free) / gradient (fade params).
async function layerMask(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  const { op: _omit, ...rest } = rawArgs;
  switch (rawArgs.op) {
    case 'create':
      return createLayerMask(connection, snippetClient);
    case 'delete':
      return deleteLayerMask(connection, snippetClient);
    case 'apply':
      return applyLayerMask(connection, snippetClient);
    case 'gradient':
      return maskGradient(connection, snippetClient, rest);
    default:
      return unknownDiscriminator('layer_mask op', rawArgs.op, LAYER_MASK_OPS);
  }
}

// ---------- Helpers ----------

export function normalizeSelectionType(raw: unknown): 'replace' | 'add' | 'subtract' | 'intersect' {
  const v = raw === undefined ? 'replace' : String(raw);
  return (SELECTION_TYPE_ENUM as readonly string[]).includes(v)
    ? (v as 'replace' | 'add' | 'subtract' | 'intersect')
    : 'replace';
}

function describeMaskOutcome(result: {
  maskCreated?: boolean;
  modifiedExistingMask?: boolean;
  hadSelection?: boolean;
}): string {
  if (result.maskCreated) return 'Layer mask created from selection';
  if (result.modifiedExistingMask) return 'Selection loaded into existing adjustment-layer mask';
  if (result.hadSelection) {
    // Defensive: shouldn't happen — if there was a selection on an adj layer
    // we should have set modifiedExistingMask above. Listed for completeness.
    return 'No mask change (active layer already has mask; selection ignored)';
  }
  return 'No mask change — active layer already has a mask and no selection was active';
}

// ---------- Handlers ----------

// Shared grounding front-end for the coordinate-driven selection modes: resolve a
// REGION `placement` to a selection bounding box (rectangle/ellipse) or a POINT
// `placement` to a wand click, falling back to the raw edges/x-y. Fail-closed via
// resolveExpectedPlacement (throws on gate REJECT / target mismatch).
async function resolveSelectionBox(
  connection: PhotoshopConnection,
  detClient: DetectionClient,
  args: Record<string, unknown>,
  mode: string,
  label: string
): Promise<{
  bounds: { left: number; top: number; right: number; bottom: number };
  placement?: Record<string, unknown>;
  note: string;
}> {
  if (args.placement) {
    const rp = await resolveExpectedPlacement(
      connection,
      detClient,
      args.placement,
      'region',
      label
    );
    return {
      bounds: rp.bbox,
      placement: { target: 'region', gate: { pass: true }, anchors: rp.anchors, bbox: rp.bbox },
      note: ` — region ${rp.summary} via placement (gate PASS)`,
    };
  }
  const left = args.left as number | undefined;
  const top = args.top as number | undefined;
  const right = args.right as number | undefined;
  const bottom = args.bottom as number | undefined;
  if (left === undefined || top === undefined || right === undefined || bottom === undefined) {
    throw new Error(`${mode} needs left+top+right+bottom, or a placement resolving to a region.`);
  }
  return { bounds: { left, top, right, bottom }, note: '' };
}

async function resolveSelectionPoint(
  connection: PhotoshopConnection,
  detClient: DetectionClient,
  args: Record<string, unknown>,
  label: string
): Promise<{ point: { x: number; y: number }; placement?: Record<string, unknown>; note: string }> {
  if (args.placement) {
    const rp = await resolveExpectedPlacement(
      connection,
      detClient,
      args.placement,
      'point',
      label
    );
    return {
      point: rp.point,
      placement: { target: 'point', gate: { pass: true }, anchors: rp.anchors, point: rp.point },
      note: ` — point ${rp.summary} via placement (gate PASS)`,
    };
  }
  const x = args.x as number | undefined;
  const y = args.y as number | undefined;
  if (x === undefined || y === undefined) {
    throw new Error('magic_wand needs x+y, or a placement resolving to a point.');
  }
  return { point: { x, y }, note: '' };
}

async function selectRectangle(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  detClient: DetectionClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(selectRectangleSchema, rawArgs);
    const box = await resolveSelectionBox(
      connection,
      detClient,
      args,
      'rectangle',
      'rectangle selection'
    );
    const { left, top, right, bottom } = box.bounds;
    const featherPx = (args.feather_px as number) ?? 0;
    const selectionType = normalizeSelectionType(args.selection_type);

    const script = await snippetClient.build('selectRectangle', {
      left,
      top,
      right,
      bottom,
      featherPx,
      selectionType,
    });
    const result = (await runScript(connection, script)) as Record<string, unknown>;
    if (box.placement) result.placement = box.placement;

    const featherNote = featherPx > 0 ? `, feathered ${featherPx}px` : '';
    return {
      content: [
        {
          type: 'text' as const,
          text: `Rectangular selection (${selectionType}) (${left}, ${top}) to (${right}, ${bottom})${featherNote}${box.note}`,
        },
      ],
      structuredContent: result,
    };
  } catch (error) {
    return toolErrorResult('Error creating selection', error);
  }
}

async function selectEllipse(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  detClient: DetectionClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(selectEllipseSchema, rawArgs);
    const box = await resolveSelectionBox(
      connection,
      detClient,
      args,
      'ellipse',
      'ellipse selection'
    );
    const { left, top, right, bottom } = box.bounds;
    const featherPx = (args.feather_px as number) ?? 0;
    const antiAlias = (args.anti_alias as boolean) ?? true;
    const selectionType = normalizeSelectionType(args.selection_type);

    const script = await snippetClient.build('selectEllipse', {
      left,
      top,
      right,
      bottom,
      featherPx,
      antiAlias,
      selectionType,
    });
    const result = (await runScript(connection, script)) as Record<string, unknown>;
    if (box.placement) result.placement = box.placement;

    const featherNote = featherPx > 0 ? `, feathered ${featherPx}px` : '';
    return {
      content: [
        {
          type: 'text' as const,
          text: `Elliptical selection (${selectionType}) (${left}, ${top}) to (${right}, ${bottom})${featherNote}${box.note}`,
        },
      ],
      structuredContent: result as Record<string, unknown>,
    };
  } catch (error) {
    return toolErrorResult('Error creating elliptical selection', error);
  }
}

// Backs both ps_modify_selection(op=grow|similar) — the current home — and
// ps_select(mode=grow|similar) — the deprecated alias. Same snippet, same
// params either way; see growSelectionSchema for why the move is safe.
async function growSelection(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  mode: 'grow' | 'similar',
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: growSelectionSchema,
    snippet: 'growSelection',
    errorPrefix: 'Error growing selection',
    params: (args) => ({
      mode,
      tolerance: (args.tolerance as number) ?? 32,
      antiAlias: (args.anti_alias as boolean) ?? true,
    }),
    successText: (_result, args) => {
      const tolerance = (args.tolerance as number) ?? 32;
      const what =
        mode === 'similar'
          ? 'expanded to similar colours (document-wide)'
          : 'grown to adjacent similar colours';
      return `Selection ${what} (tolerance ${tolerance})`;
    },
  });
}

async function transformSelection(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: transformSelectionSchema,
    snippet: 'transformSelection',
    errorPrefix: 'Error transforming selection',
    params: (args) => ({
      scaleXPercent: (args.scale_x_percent as number) ?? 100,
      scaleYPercent: (args.scale_y_percent as number) ?? 100,
      rotateDegrees: (args.rotate_degrees as number) ?? 0,
      offsetX: (args.offset_x as number) ?? 0,
      offsetY: (args.offset_y as number) ?? 0,
    }),
    successText: (_result, args) => {
      const scaleXPercent = (args.scale_x_percent as number) ?? 100;
      const scaleYPercent = (args.scale_y_percent as number) ?? 100;
      const rotateDegrees = (args.rotate_degrees as number) ?? 0;
      const offsetX = (args.offset_x as number) ?? 0;
      const offsetY = (args.offset_y as number) ?? 0;
      return `Selection transformed (scale ${scaleXPercent}%×${scaleYPercent}%, rotate ${rotateDegrees}°, offset ${offsetX},${offsetY})`;
    },
  });
}

async function selectColorPreset(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  preset: 'skin_tones' | 'out_of_gamut',
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(colorPresetSchema, rawArgs);
    const fuzziness = (args.fuzziness as number) ?? 40;
    const useFaces = (args.use_faces as boolean) ?? false;
    const selectionType = normalizeSelectionType(args.selection_type);

    const script = await snippetClient.build('selectColorPreset', {
      preset,
      fuzziness,
      useFaces,
      selectionType,
    });
    const result = await runScript(connection, script);

    const label = preset === 'skin_tones' ? `skin tones ±${fuzziness}` : 'out-of-gamut colours';
    return {
      content: [
        {
          type: 'text' as const,
          text: `Selected ${label} (${selectionType})`,
        },
      ],
      structuredContent: result as Record<string, unknown>,
    };
  } catch (error) {
    return toolErrorResult(`Error selecting ${preset}`, error);
  }
}

async function selectPolygon(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: selectPolygonSchema,
    snippet: 'selectPolygon',
    errorPrefix: 'Error creating polygon selection',
    params: (args) => {
      const rawPoints = args.points as Array<{ x?: unknown; y?: unknown }>;
      if (!Array.isArray(rawPoints) || rawPoints.length < 3) {
        throw new Error('polygon requires at least 3 points');
      }
      const points = rawPoints.map((p, i) => {
        if (typeof p?.x !== 'number' || typeof p?.y !== 'number') {
          throw new Error(`polygon point ${i} must be {x:number, y:number}`);
        }
        return { x: p.x, y: p.y };
      });
      const antiAlias = (args.anti_alias as boolean) ?? true;
      const selectionType = normalizeSelectionType(args.selection_type);
      return { points, antiAlias, selectionType };
    },
    successText: (_result, args) => {
      const selectionType = normalizeSelectionType(args.selection_type);
      const pointCount = (args.points as unknown[]).length;
      return `Polygon selection (${selectionType}) with ${pointCount} vertices`;
    },
  });
}

async function modifySelectionEdge(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  mode: 'expand' | 'contract' | 'border' | 'smooth',
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(modifyEdgeSchema, rawArgs);
    const amount = args.amount as number;
    const atCanvasBounds = (args.at_canvas_bounds as boolean) ?? false;

    const script = await snippetClient.build('modifySelectionEdge', {
      mode,
      amount,
      atCanvasBounds,
    });
    const result = await runScript(connection, script);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Selection ${mode} by ${amount}px`,
        },
      ],
      structuredContent: result as Record<string, unknown>,
    };
  } catch (error) {
    return toolErrorResult(`Error modifying selection (${mode})`, error);
  }
}

async function selectLuminanceRange(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: selectLuminanceRangeSchema,
    snippet: 'selectLuminanceRange',
    errorPrefix: 'Error selecting luminance range',
    params: (args) => {
      const luminance = args.luminance as string;
      const fuzziness = (args.fuzziness as number) ?? 40;
      const selectionType = normalizeSelectionType(args.selection_type);
      const params: Record<string, unknown> = { mode: luminance, fuzziness, selectionType };
      if (args.lower_limit !== undefined) params.lowerLimit = args.lower_limit as number;
      if (args.upper_limit !== undefined) params.upperLimit = args.upper_limit as number;
      return params;
    },
    successText: (_result, args) => {
      const luminance = args.luminance as string;
      const fuzziness = (args.fuzziness as number) ?? 40;
      const selectionType = normalizeSelectionType(args.selection_type);
      return `Luminance range selected: ${luminance} ±${fuzziness} (${selectionType})`;
    },
  });
}

async function refineEdge(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: refineEdgeSchema,
    snippet: 'refineEdge',
    errorPrefix: 'Error refining edge',
    params: (args) => ({
      radius: (args.radius as number) ?? 0,
      smooth: (args.smooth as number) ?? 0,
      feather: (args.feather as number) ?? 0,
      contrast: (args.contrast as number) ?? 0,
      shiftEdge: (args.shift_edge as number) ?? 0,
      decontaminate: (args.decontaminate as boolean) ?? false,
    }),
    successText: (_result, args) => {
      const smooth = (args.smooth as number) ?? 0;
      const feather = (args.feather as number) ?? 0;
      const contrast = (args.contrast as number) ?? 0;
      const shiftEdge = (args.shift_edge as number) ?? 0;
      return `Selection edge refined (smooth ${smooth}, feather ${feather}, contrast ${contrast}%, shift ${shiftEdge}%)`;
    },
  });
}

async function selectColorRange(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: selectColorRangeSchema,
    snippet: 'selectColorRange',
    errorPrefix: 'Error selecting color range',
    params: (args) => ({
      red: args.red as number,
      green: args.green as number,
      blue: args.blue as number,
      fuzziness: (args.fuzziness as number) ?? 40,
      selectionType: normalizeSelectionType(args.selection_type),
    }),
    successText: (_result, args) => {
      const red = args.red as number;
      const green = args.green as number;
      const blue = args.blue as number;
      const fuzziness = (args.fuzziness as number) ?? 40;
      const selectionType = normalizeSelectionType(args.selection_type);
      return `Color range selected: RGB(${red},${green},${blue}) ±${fuzziness} (${selectionType})`;
    },
  });
}

async function magicWand(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  detClient: DetectionClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(magicWandSchema, rawArgs);
    const pt = await resolveSelectionPoint(connection, detClient, args, 'magic-wand click');
    const { x, y } = pt.point;
    const tolerance = (args.tolerance as number) ?? 32;
    const contiguous = (args.contiguous as boolean) ?? true;
    const antiAlias = (args.anti_alias as boolean) ?? true;
    const sampleAllLayers = (args.sample_all_layers as boolean) ?? false;
    const selectionType = normalizeSelectionType(args.selection_type);

    const script = await snippetClient.build('magicWand', {
      x,
      y,
      tolerance,
      contiguous,
      antiAlias,
      sampleAllLayers,
      selectionType,
    });
    const result = (await runScript(connection, script)) as Record<string, unknown>;
    if (pt.placement) result.placement = pt.placement;
    return {
      content: [
        {
          type: 'text' as const,
          text: `Magic wand @ (${x},${y}) tol=${tolerance} (${selectionType})${pt.note}`,
        },
      ],
      structuredContent: result,
    };
  } catch (error) {
    return toolErrorResult('Error running magic wand', error);
  }
}

export async function getSelectionInfoHandler(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient
): Promise<ToolResult> {
  try {
    const script = await snippetClient.build('getSelectionState');
    const result = (await runScript(connection, script)) as {
      has_selection: boolean;
      area_percent?: number;
      pixel_count?: number;
      bounds_fill_ratio?: number;
      edge_complexity?: number;
    };

    const summary = result.has_selection
      ? `Active selection: ${(result.area_percent ?? 0).toFixed(1)}% of canvas (${(result.pixel_count ?? 0).toLocaleString()} px), bounds-fill ratio ${(result.bounds_fill_ratio ?? 0).toFixed(2)}, edge complexity ${(result.edge_complexity ?? 0).toFixed(2)}`
      : 'No active selection.';

    return {
      content: [{ type: 'text' as const, text: summary }],
      structuredContent: { selection_info: result } as Record<string, unknown>,
    };
  } catch (error) {
    return toolErrorResult('Error reading selection state', error);
  }
}

async function getSelectionPreview(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(selectionPreviewSchema, rawArgs);
    const maxDimension = (args.max_dimension as number) ?? 800;

    const dir = await TempDir.create('editmamei-sel-preview-');
    try {
      const overlayPath = dir.path('overlay.jpg');
      const maskPath = dir.path('mask.jpg');

      const script = await snippetClient.build('getSelectionPreview', {
        overlayPath,
        maskPath,
        maxDim: maxDimension,
      });
      const result = (await runScript(connection, script)) as {
        rendered: boolean;
        reason?: string;
        overlay_path?: string;
        mask_path?: string;
        max_dimension?: number;
        selection_info: { has_selection: boolean };
      };

      if (!result.rendered) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Selection preview not rendered: ${result.reason ?? 'unknown reason'} (selection_info follows)`,
            },
          ],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }

      const overlayBytes = await readFile(overlayPath);
      const maskBytes = await readFile(maskPath);
      const overlayB64 = overlayBytes.toString('base64');
      const maskB64 = maskBytes.toString('base64');

      return {
        content: [
          {
            type: 'text' as const,
            text: `Selection preview rendered. Image 1 = overlay (red wash on selected area). Image 2 = mask (black=selected, white=not).`,
          },
          { type: 'image' as const, data: overlayB64, mimeType: 'image/jpeg' },
          { type: 'image' as const, data: maskB64, mimeType: 'image/jpeg' },
        ],
        structuredContent: {
          rendered: true,
          max_dimension: result.max_dimension ?? maxDimension,
          overlay_bytes: overlayBytes.length,
          mask_bytes: maskBytes.length,
          selection_info: result.selection_info,
        },
      };
    } finally {
      await dir.cleanup();
    }
  } catch (error) {
    return toolErrorResult('Error rendering selection preview', error);
  }
}

async function featherSelection(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: featherSelectionSchema,
    snippet: 'featherSelection',
    errorPrefix: 'Error feathering selection',
    params: (args) => ({ radiusPx: args.radius_px as number }),
    successText: (_result, args) => `Selection feathered by ${args.radius_px as number}px.`,
  });
}

async function selectAll(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs: {},
    schema: emptySchema,
    snippet: 'selectAll',
    errorPrefix: 'Error selecting all',
    successText: () => 'All selected',
  });
}

async function deselect(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs: {},
    schema: emptySchema,
    snippet: 'deselect',
    errorPrefix: 'Error deselecting',
    successText: () => 'Selection cleared',
  });
}

async function invertSelection(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs: {},
    schema: emptySchema,
    snippet: 'invertSelection',
    errorPrefix: 'Error inverting selection',
    successText: () => 'Selection inverted',
  });
}

async function createLayerMask(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs: {},
    schema: emptySchema,
    snippet: 'createLayerMask',
    errorPrefix: 'Error creating layer mask',
    successText: (result) =>
      describeMaskOutcome(
        result as { maskCreated?: boolean; modifiedExistingMask?: boolean; hadSelection?: boolean }
      ),
  });
}

async function deleteLayerMask(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs: {},
    schema: emptySchema,
    snippet: 'deleteLayerMask',
    errorPrefix: 'Error deleting layer mask',
    successText: () => 'Layer mask deleted',
  });
}

async function applyLayerMask(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs: {},
    schema: emptySchema,
    snippet: 'applyLayerMask',
    errorPrefix: 'Error applying layer mask',
    successText: () => 'Layer mask applied (merged to layer)',
  });
}

async function maskGradient(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: MASK_GRADIENT_ARGS_SCHEMA,
    snippet: 'maskGradient',
    errorPrefix: 'Error drawing mask gradient',
    params: (args) => ({
      fade_to: (args.fade_to as string) ?? 'bottom',
      start: (args.start as number) ?? 0,
      end: (args.end as number) ?? 1,
      extent: (args.extent as string) ?? 'layer',
    }),
    successText: (result, args) => {
      const r = result as Record<string, unknown>;
      const created = r.created_mask ? ' (mask created)' : '';
      return `Mask gradient drawn: fade to ${(args.fade_to as string) ?? 'bottom'}${created}\nResult: ${JSON.stringify(result)}`;
    },
  });
}

async function saveSelectionToChannel(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: saveSelectionToChannelSchema,
    snippet: 'saveSelectionToChannel',
    errorPrefix: 'Error saving selection to channel',
    timeoutMs: 120000,
    params: (args) => ({ channelName: args.channel_name as string }),
    successText: (result, args) => {
      const channelName = args.channel_name as string;
      const overwrote = (result as Record<string, unknown>).overwritten
        ? ' (overwrote existing)'
        : '';
      return `Selection saved to channel "${channelName}"${overwrote}.`;
    },
  });
}

async function loadSelectionFromChannel(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: loadSelectionFromChannelSchema,
    snippet: 'loadSelectionFromChannel',
    errorPrefix: 'Error loading selection from channel',
    timeoutMs: 120000,
    params: (args) => ({
      channelName: args.channel_name as string,
      operation: normalizeSelectionType(args.operation),
    }),
    successText: (_result, args) => {
      const channelName = args.channel_name as string;
      const operation = normalizeSelectionType(args.operation);
      return `Selection loaded from channel "${channelName}" (${operation}).`;
    },
  });
}

async function duplicateChannel(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: duplicateChannelSchema,
    snippet: 'duplicateChannel',
    errorPrefix: 'Error duplicating channel',
    params: (args) => {
      const channelName = args.channel_name as string;
      const params: Record<string, unknown> = { channelName };
      if (args.new_channel_name !== undefined) params.newName = args.new_channel_name as string;
      return params;
    },
    successText: (result, args) => {
      const channelName = args.channel_name as string;
      const r = result as Record<string, unknown>;
      return `Channel "${channelName}" duplicated to "${String(r.new_channel_name ?? '')}".`;
    },
  });
}

async function deleteChannel(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: deleteChannelSchema,
    snippet: 'deleteChannel',
    errorPrefix: 'Error deleting channel',
    params: (args) => ({ channelName: args.channel_name as string }),
    successText: (_result, args) => `Channel "${args.channel_name as string}" deleted.`,
  });
}
