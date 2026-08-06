import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import type { SnippetClient } from '../api/snippet-client.js';
import { runScript } from '../utils/run-script.js';
import { validateArgs, type JsonSchemaObject } from '../utils/validate.js';
import { toolErrorResult, runSnippetTool, applyToActiveLayerProp } from '../utils/tool-helpers.js';

// On 2026-05-31 the four destructive bake adjustments — `auto_levels`,
// `auto_contrast`, `desaturate`, `invert` — were removed. Each was a strict
// redundancy with `ps_add_adjustment_layer` (non-destructive +
// editable + maskable) followed by `ps_merge` (mode=visible) if a
// pixel bake was actually wanted. Six months of session logs recorded
// zero LLM calls for any of them.
//
// Seven more adjustment types were added to the
// non-destructive entry point: black_and_white, color_balance,
// photo_filter, vibrance, channel_mixer, selective_color, and
// gradient_map (preset-only for v1). The original four (curves, levels,
// hue_saturation, brightness_contrast) stay as well. Together this brings
// the adjustment surface to what a real Photoshop user expects.

const addAdjustmentLayerSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: [
        'curves',
        'levels',
        'hue_saturation',
        'brightness_contrast',
        'black_and_white',
        'color_balance',
        'photo_filter',
        'vibrance',
        'channel_mixer',
        'selective_color',
        'gradient_map',
        // Closes the most-felt remaining gaps:
        'exposure',
        'color_lookup',
        'invert',
        // Surfaced by the ScriptListener audit
        // gap analysis: every other PS adjustment-layer type was already
        // covered, posterize + threshold were the only ones missing.
        'posterize',
        'threshold',
      ],
      description: 'Adjustment kind.',
    },
    clip_to_below: {
      type: 'boolean',
      description: 'If true, the adjustment only affects the layer directly below.',
      default: false,
    },
    name: {
      type: 'string',
      description: 'Optional name for the new adjustment layer.',
    },

    // ---------- curves ----------
    curves_preset: {
      type: 'string',
      enum: ['linear', 'sCurveLight', 'sCurveMedium', 'sCurveStrong'],
      description: 'For type=curves only. Default sCurveMedium.',
      default: 'sCurveMedium',
    },

    // ---------- levels ----------
    black_point: {
      type: 'number',
      description: 'For type=levels. Input black (0-255).',
      minimum: 0,
      maximum: 255,
      default: 0,
    },
    white_point: {
      type: 'number',
      description: 'For type=levels. Input white (0-255).',
      minimum: 0,
      maximum: 255,
      default: 255,
    },
    gamma: {
      type: 'number',
      description: 'For type=levels. Midpoint gamma.',
      minimum: 0.1,
      maximum: 9.99,
      default: 1.0,
    },

    // ---------- hue_saturation ----------
    hue: {
      type: 'number',
      description: 'For type=hue_saturation. Hue shift in degrees (-180 to 180).',
      minimum: -180,
      maximum: 180,
      default: 0,
    },
    saturation: {
      type: 'number',
      description:
        'For type=hue_saturation. Master saturation (-100 to 100). Note: vibrance has its own vib_saturation param.',
      minimum: -100,
      maximum: 100,
      default: 0,
    },
    lightness: {
      type: 'number',
      description: 'For type=hue_saturation. Lightness (-100 to 100).',
      minimum: -100,
      maximum: 100,
      default: 0,
    },

    // ---------- brightness_contrast ----------
    brightness: {
      type: 'number',
      description: 'For type=brightness_contrast. Brightness (-100 to 100).',
      minimum: -100,
      maximum: 100,
      default: 0,
    },
    contrast: {
      type: 'number',
      description: 'For type=brightness_contrast. Contrast (-100 to 100).',
      minimum: -100,
      maximum: 100,
      default: 0,
    },

    // ---------- black_and_white ----------
    bw_reds: {
      type: 'number',
      description:
        'For type=black_and_white. Red-channel lightness mapping (-200 to 300). PS default 40.',
      minimum: -200,
      maximum: 300,
      default: 40,
    },
    bw_yellows: {
      type: 'number',
      description: 'For type=black_and_white. Yellow-channel mapping (-200 to 300). PS default 60.',
      minimum: -200,
      maximum: 300,
      default: 60,
    },
    bw_greens: {
      type: 'number',
      description: 'For type=black_and_white. Green-channel mapping (-200 to 300). PS default 40.',
      minimum: -200,
      maximum: 300,
      default: 40,
    },
    bw_cyans: {
      type: 'number',
      description: 'For type=black_and_white. Cyan-channel mapping (-200 to 300). PS default 60.',
      minimum: -200,
      maximum: 300,
      default: 60,
    },
    bw_blues: {
      type: 'number',
      description: 'For type=black_and_white. Blue-channel mapping (-200 to 300). PS default 20.',
      minimum: -200,
      maximum: 300,
      default: 20,
    },
    bw_magentas: {
      type: 'number',
      description:
        'For type=black_and_white. Magenta-channel mapping (-200 to 300). PS default 80.',
      minimum: -200,
      maximum: 300,
      default: 80,
    },
    bw_tint: {
      type: 'boolean',
      description:
        'For type=black_and_white. If true, applies a single-color tint over the grayscale conversion (split-toning effect). Pair with bw_tint_hue + bw_tint_saturation.',
      default: false,
    },
    bw_tint_hue: {
      type: 'number',
      description:
        'For type=black_and_white when bw_tint=true. Tint hue in degrees (-180 to 180). Default 220 (cool blue).',
      minimum: -180,
      maximum: 180,
      default: 220,
    },
    bw_tint_saturation: {
      type: 'number',
      description:
        'For type=black_and_white when bw_tint=true. Tint saturation (0 to 100). Default 25.',
      minimum: 0,
      maximum: 100,
      default: 25,
    },

    // ---------- color_balance ----------
    cb_shadows_cyan_red: {
      type: 'number',
      description:
        'For type=color_balance. Shadows: cyan↔red shift (-100 cyan to +100 red). Default 0.',
      minimum: -100,
      maximum: 100,
      default: 0,
    },
    cb_shadows_magenta_green: {
      type: 'number',
      description:
        'For type=color_balance. Shadows: magenta↔green shift (-100 magenta to +100 green).',
      minimum: -100,
      maximum: 100,
      default: 0,
    },
    cb_shadows_yellow_blue: {
      type: 'number',
      description: 'For type=color_balance. Shadows: yellow↔blue shift (-100 yellow to +100 blue).',
      minimum: -100,
      maximum: 100,
      default: 0,
    },
    cb_midtones_cyan_red: {
      type: 'number',
      description: 'For type=color_balance. Midtones: cyan↔red shift.',
      minimum: -100,
      maximum: 100,
      default: 0,
    },
    cb_midtones_magenta_green: {
      type: 'number',
      description: 'For type=color_balance. Midtones: magenta↔green shift.',
      minimum: -100,
      maximum: 100,
      default: 0,
    },
    cb_midtones_yellow_blue: {
      type: 'number',
      description: 'For type=color_balance. Midtones: yellow↔blue shift.',
      minimum: -100,
      maximum: 100,
      default: 0,
    },
    cb_highlights_cyan_red: {
      type: 'number',
      description: 'For type=color_balance. Highlights: cyan↔red shift.',
      minimum: -100,
      maximum: 100,
      default: 0,
    },
    cb_highlights_magenta_green: {
      type: 'number',
      description: 'For type=color_balance. Highlights: magenta↔green shift.',
      minimum: -100,
      maximum: 100,
      default: 0,
    },
    cb_highlights_yellow_blue: {
      type: 'number',
      description: 'For type=color_balance. Highlights: yellow↔blue shift.',
      minimum: -100,
      maximum: 100,
      default: 0,
    },
    cb_preserve_luminosity: {
      type: 'boolean',
      description:
        'For type=color_balance. Preserve luminosity while shifting color. Default true (matches the PS dialog default).',
      default: true,
    },

    // ---------- photo_filter ----------
    pf_preset: {
      type: 'string',
      description:
        'For type=photo_filter. Named filter preset. If set, takes precedence over pf_color_hex. Common picks: warming_85 (warm portraits), cooling_80 (cool down skies), sepia (vintage), warming_lba / cooling_lbb (subtle classic film), underwater.',
      enum: [
        'warming_85',
        'warming_lba',
        'warming_81',
        'cooling_80',
        'cooling_lbb',
        'cooling_82',
        'red',
        'orange',
        'yellow',
        'green',
        'cyan',
        'blue',
        'violet',
        'magenta',
        'sepia',
        'deep_red',
        'deep_blue',
        'deep_emerald',
        'deep_yellow',
        'underwater',
      ],
    },
    pf_color_hex: {
      type: 'string',
      description:
        'For type=photo_filter. Custom filter color as a hex string like "#EC8A00". Only used when pf_preset is not set.',
    },
    pf_density: {
      type: 'number',
      description: 'For type=photo_filter. Filter strength (1-100). PS default 25.',
      minimum: 1,
      maximum: 100,
      default: 25,
    },
    pf_preserve_luminosity: {
      type: 'boolean',
      description: 'For type=photo_filter. Preserve luminosity. Default true.',
      default: true,
    },

    // ---------- vibrance ----------
    vib_vibrance: {
      type: 'number',
      description:
        'For type=vibrance. Vibrance (-100 to 100). Saturation boost that protects skin tones and already-saturated colors. Gentler than hue_saturation.saturation.',
      minimum: -100,
      maximum: 100,
      default: 0,
    },
    vib_saturation: {
      type: 'number',
      description:
        'For type=vibrance. Master saturation override (-100 to 100). Affects all colors equally.',
      minimum: -100,
      maximum: 100,
      default: 0,
    },

    // ---------- channel_mixer ----------
    cm_monochrome: {
      type: 'boolean',
      description:
        'For type=channel_mixer. If true, output is single gray channel and only cm_gray_* params apply. If false, the per-output cm_{r,g,b}_from_* and cm_{r,g,b}_constant params apply for RGB→RGB remix.',
      default: false,
    },
    cm_gray_from_r: {
      type: 'number',
      description:
        'For type=channel_mixer with cm_monochrome=true. Red contribution to gray (-200 to 200). PS default 40.',
      minimum: -200,
      maximum: 200,
      default: 40,
    },
    cm_gray_from_g: {
      type: 'number',
      description:
        'For type=channel_mixer with cm_monochrome=true. Green contribution to gray. PS default 40.',
      minimum: -200,
      maximum: 200,
      default: 40,
    },
    cm_gray_from_b: {
      type: 'number',
      description:
        'For type=channel_mixer with cm_monochrome=true. Blue contribution to gray. PS default 20.',
      minimum: -200,
      maximum: 200,
      default: 20,
    },
    cm_gray_constant: {
      type: 'number',
      description: 'For type=channel_mixer with cm_monochrome=true. Constant added to gray output.',
      minimum: -200,
      maximum: 200,
      default: 0,
    },
    cm_r_from_r: {
      type: 'number',
      description:
        'For type=channel_mixer with cm_monochrome=false. Red-from-Red weight. PS default 100 (identity).',
      minimum: -200,
      maximum: 200,
      default: 100,
    },
    cm_r_from_g: {
      type: 'number',
      description: 'For type=channel_mixer. Red-from-Green weight. Default 0.',
      minimum: -200,
      maximum: 200,
      default: 0,
    },
    cm_r_from_b: {
      type: 'number',
      description: 'For type=channel_mixer. Red-from-Blue weight. Default 0.',
      minimum: -200,
      maximum: 200,
      default: 0,
    },
    cm_r_constant: {
      type: 'number',
      description: 'For type=channel_mixer. Constant added to Red output.',
      minimum: -200,
      maximum: 200,
      default: 0,
    },
    cm_g_from_r: {
      type: 'number',
      description: 'For type=channel_mixer. Green-from-Red weight.',
      minimum: -200,
      maximum: 200,
      default: 0,
    },
    cm_g_from_g: {
      type: 'number',
      description: 'For type=channel_mixer. Green-from-Green weight. PS default 100.',
      minimum: -200,
      maximum: 200,
      default: 100,
    },
    cm_g_from_b: {
      type: 'number',
      description: 'For type=channel_mixer. Green-from-Blue weight.',
      minimum: -200,
      maximum: 200,
      default: 0,
    },
    cm_g_constant: {
      type: 'number',
      description: 'For type=channel_mixer. Constant added to Green output.',
      minimum: -200,
      maximum: 200,
      default: 0,
    },
    cm_b_from_r: {
      type: 'number',
      description: 'For type=channel_mixer. Blue-from-Red weight.',
      minimum: -200,
      maximum: 200,
      default: 0,
    },
    cm_b_from_g: {
      type: 'number',
      description: 'For type=channel_mixer. Blue-from-Green weight.',
      minimum: -200,
      maximum: 200,
      default: 0,
    },
    cm_b_from_b: {
      type: 'number',
      description: 'For type=channel_mixer. Blue-from-Blue weight. PS default 100.',
      minimum: -200,
      maximum: 200,
      default: 100,
    },
    cm_b_constant: {
      type: 'number',
      description: 'For type=channel_mixer. Constant added to Blue output.',
      minimum: -200,
      maximum: 200,
      default: 0,
    },

    // ---------- selective_color ----------
    sc_method: {
      type: 'string',
      enum: ['relative', 'absolute'],
      description:
        'For type=selective_color. "relative" scales adjustments by the existing color amount (subtle, the PS default). "absolute" applies fixed CMYK shifts (more aggressive).',
      default: 'relative',
    },
    sc_colors: {
      type: 'object',
      description:
        'For type=selective_color. Nested per-color-family CMYK shifts. Each family is an object {cyan, magenta, yellow, black} with values -100 to 100. Omitted families default to zero. Families: reds, yellows, greens, cyans, blues, magentas, whites, neutrals, blacks.',
      properties: {
        reds: { type: 'object' },
        yellows: { type: 'object' },
        greens: { type: 'object' },
        cyans: { type: 'object' },
        blues: { type: 'object' },
        magentas: { type: 'object' },
        whites: { type: 'object' },
        neutrals: { type: 'object' },
        blacks: { type: 'object' },
      },
    },

    // ---------- gradient_map ----------
    gm_preset: {
      type: 'string',
      enum: ['black_to_white', 'sepia', 'tint'],
      description:
        'For type=gradient_map. Preset gradient. "black_to_white" is the canonical tonal B&W via gradient. "sepia" is a warm vintage tone. "tint" maps black→tint_color→white using gm_tint_color_hex. For arbitrary color mappings pass gm_stops instead (overrides the preset).',
      default: 'black_to_white',
    },
    gm_stops: {
      type: 'array',
      description:
        'For type=gradient_map. Custom color stops overriding gm_preset — each {red,green,blue (0-255), location (0-100 shadows→highlights), midpoint (5-95, default 50)}. At least 2; sorted by location. E.g. a blue→orange stylized grade: [{red:20,green:40,blue:120,location:0},{red:250,green:150,blue:50,location:100}].',
      items: {
        type: 'object',
        properties: {
          red: { type: 'integer', minimum: 0, maximum: 255 },
          green: { type: 'integer', minimum: 0, maximum: 255 },
          blue: { type: 'integer', minimum: 0, maximum: 255 },
          location: { type: 'number', minimum: 0, maximum: 100 },
          midpoint: { type: 'number', minimum: 5, maximum: 95, default: 50 },
        },
        required: ['red', 'green', 'blue', 'location'],
      },
    },
    gm_tint_color_hex: {
      type: 'string',
      description:
        'For type=gradient_map with gm_preset=tint. Mid-tone tint color as a hex string like "#5588CC". Only used when gm_preset=tint.',
      default: '#5588CC',
    },
    gm_reverse: {
      type: 'boolean',
      description: 'For type=gradient_map. Reverse the gradient direction.',
      default: false,
    },
    gm_dither: {
      type: 'boolean',
      description: 'For type=gradient_map. Apply dithering to reduce banding.',
      default: false,
    },

    // ---------- exposure ----------
    exp_exposure: {
      type: 'number',
      description:
        'For type=exposure. Exposure shift in STOPS (-20 to +20). PS default 0. Photographer-feeling tonal control — 1 stop ≈ 2× linear brightness.',
      minimum: -20,
      maximum: 20,
      default: 0,
    },
    exp_offset: {
      type: 'number',
      description:
        'For type=exposure. Offset shift (-0.5 to +0.5). PS default 0. Shifts the black point — most useful for paired with negative exposure for moody/crushed-shadow looks.',
      minimum: -0.5,
      maximum: 0.5,
      default: 0,
    },
    exp_gamma: {
      type: 'number',
      description:
        'For type=exposure. Gamma correction (0.01 to 9.99). PS default 1.0 (identity). Values <1 brighten midtones; >1 darken them.',
      minimum: 0.01,
      maximum: 9.99,
      default: 1.0,
    },

    // ---------- color_lookup ----------
    cl_lut_name: {
      type: 'string',
      description:
        'For type=color_lookup. The LUT file name as Photoshop sees it. Common built-in 3DLUT presets: "3Strip.look", "Bleach Bypass.look", "Candlelight.CUBE", "Crisp_Warm.look", "Crisp_Winter.look", "DropBlues.3DL", "EdgyAmber.3DL", "FoggyNight.3DL", "FuturisticBleak.3DL", "Horror Blue.3DL", "LateSunset.3DL", "Moonlight.3DL", "NightFromDay.CUBE", "Soft_Warming.look", "TealMagentaGold.look", "TealOrangePlusContrast.3DL". For custom files, pass the absolute path.',
    },
    cl_lut_type: {
      type: 'string',
      enum: ['3dlut', 'abstract', 'device_link'],
      description:
        'For type=color_lookup. Which LUT slot to load into. Default 3dlut covers .cube / .3dl / .look files (the photographer-typical case). abstract and device_link are for color-management workflows.',
      default: '3dlut',
    },

    // ---------- invert ----------
    // No params — creating the layer IS the operation. Type-only.

    // ---------- posterize ----------
    pos_levels: {
      type: 'number',
      description:
        'For type=posterize. Number of tonal levels per channel (2-255). PS default 4. Lower values yield a more graphic / illustration look (2-4); higher values are gentler.',
      minimum: 2,
      maximum: 255,
      default: 4,
    },

    // ---------- threshold ----------
    thr_level: {
      type: 'number',
      description:
        'For type=threshold. Threshold luminance (1-255). PS default 128. Pixels brighter than the threshold become white; darker become black.',
      minimum: 1,
      maximum: 255,
      default: 128,
    },

    // ---------- masking (applies to ALL types) ----------
    mask_from_selection: {
      type: 'boolean',
      description:
        "If true (default) and there is an active selection at the time of this call, the new adjustment layer is automatically masked by that selection. If false, any existing selection is dropped first and the new layer is unmasked (full canvas). Photoshop's native Mk-with-active-selection behavior does the masking; this flag makes it explicit and toggleable.",
      default: true,
    },
    mask_inverted: {
      type: 'boolean',
      description:
        'Only meaningful when mask_from_selection is true AND there is an active selection. If true, the resulting mask is inverted — so the adjustment affects EVERYTHING OUTSIDE the selection rather than inside. Common idiom: "I selected the sky but want to adjust everything else." Defaults to false.',
      default: false,
    },
    into_active_group: {
      type: 'boolean',
      description:
        "Photoshop's Mk-AdjL descriptor carries no placement target, so with a GROUP active it would natively nest the new layer INSIDE that group. Default false hoists the new layer back out so it lands above the active layer/group as a sibling, matching this tool's documented placement. Pass true to keep the new layer nested inside the active group instead.",
      default: false,
    },
  },
  required: ['type'],
};

// ---------- Shadows/Highlights (destructive op) ----------
//
// PS only ships Shadows/Highlights as a one-pass destructive command
// (Image > Adjustments > Shadows/Highlights — no adjustment-layer
// equivalent). The auto-duplicate-first pattern keeps the original
// layer intact so the LLM can revert by deleting the copy.

const colorLookupBakeSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    cl_lut_name: {
      type: 'string',
      description:
        'Leaf name of a 3DLUT file in PS\'s Presets/3DLUTs/ folder (e.g. "TealOrangePlusContrast.3DL", "FallColors.look", "Kodak 5205 Fuji 3510 (by Adobe).cube") OR an absolute path to a .3DL / .look / .cube file. Extension-agnostic leaf-name resolution (the same base name with a different extension still matches).',
    },
    apply_to_active_layer: applyToActiveLayerProp('the color lookup'),
  },
  required: ['cl_lut_name'],
};

const equalizeSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    apply_to_active_layer: applyToActiveLayerProp('the equalize'),
  },
};

const shadowsHighlightsSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    shadow_amount: {
      type: 'number',
      description: 'Shadow recovery amount (0-100). PS default 35.',
      minimum: 0,
      maximum: 100,
      default: 35,
    },
    shadow_width: {
      type: 'number',
      description:
        'Tonal width of shadows (0-100). Wider = more midtones treated as shadow. PS default 50.',
      minimum: 0,
      maximum: 100,
      default: 50,
    },
    shadow_radius: {
      type: 'number',
      description: 'Local-contrast radius for shadow recovery in pixels (0-2500). PS default 30.',
      minimum: 0,
      maximum: 2500,
      default: 30,
    },
    highlight_amount: {
      type: 'number',
      description: 'Highlight recovery amount (0-100). PS default 0.',
      minimum: 0,
      maximum: 100,
      default: 0,
    },
    highlight_width: {
      type: 'number',
      description: 'Tonal width of highlights (0-100). PS default 50.',
      minimum: 0,
      maximum: 100,
      default: 50,
    },
    highlight_radius: {
      type: 'number',
      description:
        'Local-contrast radius for highlight recovery in pixels (0-2500). PS default 30.',
      minimum: 0,
      maximum: 2500,
      default: 30,
    },
    color_correction: {
      type: 'number',
      description:
        'Color saturation compensation for recovered shadows (-100 to +100). PS default +20 — counteracts the desaturation that shadow recovery tends to produce.',
      minimum: -100,
      maximum: 100,
      default: 20,
    },
    midtone_contrast: {
      type: 'number',
      description: 'Midtone contrast (-100 to +100). PS default 0.',
      minimum: -100,
      maximum: 100,
      default: 0,
    },
    black_clip: {
      type: 'number',
      description:
        'Percent of the darkest shadow pixels to clip to pure black (0-50). PS default 0.01 — minimal clipping. Higher values increase contrast but lose shadow detail.',
      minimum: 0,
      maximum: 50,
      default: 0.01,
    },
    white_clip: {
      type: 'number',
      description:
        'Percent of the brightest highlight pixels to clip to pure white (0-50). PS default 0.01. Higher values increase contrast but lose highlight detail.',
      minimum: 0,
      maximum: 50,
      default: 0.01,
    },
    apply_to_active_layer: applyToActiveLayerProp('the op'),
  },
};

const APPLY_ADJUSTMENT_TYPES = ['shadows_highlights', 'equalize', 'color_lookup'] as const;

// Consolidated input schema for ps_apply_adjustment (Phase 1, 2026-06-20)
// — the three destructive bakes that have no adjustment-layer equivalent. Merges
// the per-type schemas (apply_to_active_layer collides identically); the handler
// re-validates against the exact per-type schema (e.g. color_lookup requires
// cl_lut_name). The non-destructive add_adjustment_layer stays separate.
const APPLY_ADJUSTMENT_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: [...APPLY_ADJUSTMENT_TYPES],
      description:
        'Which destructive adjustment to bake (none exist as adjustment layers in PS). ' +
        'shadows_highlights: one-pass shadow/highlight recovery (shadow_amount, highlight_amount, …). ' +
        'equalize: parameter-free histogram equalization. ' +
        'color_lookup: bake a 3DLUT grade — cl_lut_name REQUIRED. ' +
        'All auto-duplicate the active layer by default (apply_to_active_layer:true to bake in place).',
    },
    ...shadowsHighlightsSchema.properties,
    ...equalizeSchema.properties,
    ...colorLookupBakeSchema.properties,
  },
  required: ['type'],
};

export function createAdjustmentTools(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient
): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'ps_apply_adjustment',
        description:
          "Apply a DESTRUCTIVE tonal adjustment that Photoshop does NOT offer as an adjustment layer — chosen via `type`. Runs on a DUPLICATE of the active layer by default (auto-duplicate-first — the original is preserved; revert by deleting the copy); pass `apply_to_active_layer: true` to bake in place. Auto-rasterizes text/smart-object layers. `shadows_highlights` recovers blown highlights + crushed shadows in one pass (defaults match Adobe's dialog: 35 shadow amount, +20 color correction); `equalize` stretches/flattens the histogram (parameter-free); `color_lookup` bakes a 3DLUT grade (cl_lut_name required — leaf name of a file in Presets/3DLUTs/ or an absolute .cube/.3dl/.look path). For EDITABLE tonal/color work, prefer ps_add_adjustment_layer.",
        inputSchema: APPLY_ADJUSTMENT_INPUT_SCHEMA,
        outputSchema: {
          type: 'object',
          properties: {
            filter: { type: 'string' },
            shadow_amount: { type: 'number' },
            shadow_width: { type: 'number' },
            shadow_radius: { type: 'number' },
            highlight_amount: { type: 'number' },
            highlight_width: { type: 'number' },
            highlight_radius: { type: 'number' },
            color_correction: { type: 'number' },
            midtone_contrast: { type: 'number' },
            lut_path: { type: 'string' },
            lut_format: { type: 'string' },
            target_was_copy: { type: 'boolean' },
            target_layer_name: { type: 'string' },
            original_layer_name: { type: 'string' },
            context: { type: 'object' },
          },
        },
        annotations: {
          title: 'Apply Adjustment (destructive, auto-duplicates)',
          destructiveHint: true,
          idempotentHint: false,
        },
      },
      handler: async (args) => applyAdjustment(connection, snippetClient, args),
    },
    {
      tool: {
        name: 'ps_add_adjustment_layer',
        description:
          "Create a non-destructive adjustment layer above the active layer — hoisted out of the active layer's group by default even though Photoshop's own Mk-AdjL placement rule would otherwise nest it INSIDE that group (pass into_active_group:true to keep that native nesting). Supports the full real-Photoshop tonal/color surface: Curves (with S-curve presets), Levels, Hue/Saturation, Brightness/Contrast, Black & White (with optional tint), Color Balance, Photo Filter (preset or custom color), Vibrance, Channel Mixer, Selective Color, Gradient Map (preset), Exposure (stops + offset + gamma), Color Lookup (3DLUT presets or custom file path), and Invert. Values are editable, maskable, and removable. This is the canonical entry point for ALL tonal/color adjustments; the old destructive bake tools (auto_levels / auto_contrast / desaturate / invert) were removed on 2026-05-31 — if you genuinely need a pixel bake, follow this call with `ps_merge` (mode=visible). Optionally clips the adjustment to only affect the layer directly below it. If a selection is active at call time, the new layer is automatically masked by it (toggle with mask_from_selection / mask_inverted). For destructive ops that don't have an adjustment-layer equivalent in Photoshop (Shadows/Highlights — single-pass shadow/highlight recovery), use `ps_apply_adjustment` (type=shadows_highlights) which auto-duplicates the active layer to keep the original intact. Returns context (the new adjustment layer becomes active) plus parent_path — the actual containing-group chain, so placement is never silent.",
        inputSchema: addAdjustmentLayerSchema,
        outputSchema: {
          type: 'object',
          properties: {
            created: { type: 'boolean' },
            type: { type: 'string' },
            layerName: { type: 'string' },
            layerKind: { type: 'string' },
            kindMatches: { type: 'boolean' },
            clipped: { type: 'boolean' },
            customValuesApplied: { type: 'boolean' },
            had_selection: { type: 'boolean' },
            mask_applied: { type: 'boolean' },
            mask_inverted: { type: 'boolean' },
            mask_inversion_error: { type: ['string', 'null'] },
            clipError: { type: 'string' },
            hoisted: {
              type: 'boolean',
              description:
                'True when the new layer had to be moved back out of the previously-active group to honor into_active_group:false (the default). False when it landed correctly on its own, or when the move-back itself failed — check the layer tree if this matters and hoisted is false.',
            },
            parent_path: {
              type: ['array', 'null'],
              items: { type: 'string' },
              description:
                'The containing-group name chain (outermost first), empty array at the document root.',
            },
            context: { type: 'object' },
          },
        },
        annotations: {
          title: 'Add Adjustment Layer (non-destructive)',
          idempotentHint: true,
        },
      },
      handler: async (args) => addAdjustmentLayer(connection, snippetClient, args),
    },
  ];
}

// Dispatch the consolidated ps_apply_adjustment tool to the per-type
// bake handler. `type` is stripped so the delegate validates only its own params.
async function applyAdjustment(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  const type = rawArgs.type;
  const { type: _omit, ...rest } = rawArgs;
  switch (type) {
    case 'shadows_highlights':
      return applyShadowsHighlights(connection, snippetClient, rest);
    case 'equalize':
      return applyEqualize(connection, snippetClient, rest);
    case 'color_lookup':
      return applyColorLookup(connection, snippetClient, rest);
    default:
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: unknown adjustment type "${String(type)}". Allowed: ${APPLY_ADJUSTMENT_TYPES.join(', ')}.`,
          },
        ],
        isError: true,
      };
  }
}

// Forward every recognised param key from validated args into the params
// record consumed by the ExtendScript snippet. Any unrecognised keys are
// dropped — keeps the snippet's defaults in control.
const FORWARDED_KEYS = new Set<string>([
  // curves / levels / hue_sat / brightness_contrast
  'curves_preset',
  'black_point',
  'white_point',
  'gamma',
  'hue',
  'saturation',
  'lightness',
  'brightness',
  'contrast',
  // black_and_white
  'bw_reds',
  'bw_yellows',
  'bw_greens',
  'bw_cyans',
  'bw_blues',
  'bw_magentas',
  'bw_tint',
  'bw_tint_hue',
  'bw_tint_saturation',
  // color_balance
  'cb_shadows_cyan_red',
  'cb_shadows_magenta_green',
  'cb_shadows_yellow_blue',
  'cb_midtones_cyan_red',
  'cb_midtones_magenta_green',
  'cb_midtones_yellow_blue',
  'cb_highlights_cyan_red',
  'cb_highlights_magenta_green',
  'cb_highlights_yellow_blue',
  'cb_preserve_luminosity',
  // photo_filter
  'pf_preset',
  'pf_color_hex',
  'pf_density',
  'pf_preserve_luminosity',
  // vibrance
  'vib_vibrance',
  'vib_saturation',
  // channel_mixer
  'cm_monochrome',
  'cm_gray_from_r',
  'cm_gray_from_g',
  'cm_gray_from_b',
  'cm_gray_constant',
  'cm_r_from_r',
  'cm_r_from_g',
  'cm_r_from_b',
  'cm_r_constant',
  'cm_g_from_r',
  'cm_g_from_g',
  'cm_g_from_b',
  'cm_g_constant',
  'cm_b_from_r',
  'cm_b_from_g',
  'cm_b_from_b',
  'cm_b_constant',
  // selective_color
  'sc_method',
  'sc_colors',
  // gradient_map
  'gm_preset',
  'gm_tint_color_hex',
  'gm_reverse',
  'gm_dither',
  'gm_stops',
  // exposure / color_lookup
  'exp_exposure',
  'exp_offset',
  'exp_gamma',
  'cl_lut_name',
  'cl_lut_type',
  // posterize / threshold
  'pos_levels',
  'thr_level',
]);

async function addAdjustmentLayer(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(addAdjustmentLayerSchema, rawArgs);
    const type = args.type as string;
    const clipToBelow = (args.clip_to_below as boolean) ?? false;
    const name = args.name as string | undefined;
    const maskFromSelection = (args.mask_from_selection as boolean) ?? true;
    const maskInverted = (args.mask_inverted as boolean) ?? false;
    const intoActiveGroup = (args.into_active_group as boolean) ?? false;

    const params: Record<string, unknown> = {};
    for (const key of FORWARDED_KEYS) {
      if (args[key] !== undefined) params[key] = args[key];
    }

    // Conditional-required check: color_lookup without a LUT
    // name would create an empty / do-nothing CL adjustment layer. JSON
    // Schema can't easily express "field X is required when type=Y", so
    // we enforce it at the handler boundary instead. The schema's
    // cl_lut_name description names the canonical 3DLUT preset strings.
    if (type === 'color_lookup' && !params.cl_lut_name) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Error: type=color_lookup requires cl_lut_name (built-in 3DLUT name like "3Strip.look" / "TealOrangePlusContrast.3DL" or absolute path to a .cube/.3dl/.look file). Without it, PS would create an empty Color Lookup layer with no effect.',
          },
        ],
        isError: true,
      };
    }

    const buildParams: Record<string, unknown> = {
      type,
      clip_to_below: clipToBelow,
      mask_from_selection: maskFromSelection,
      mask_inverted: maskInverted,
      into_active_group: intoActiveGroup,
      ...params,
    };
    if (name !== undefined) buildParams.name = name;

    const script = await snippetClient.build('addAdjustmentLayer', buildParams);
    const result = await runScript(connection, script);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Adjustment layer added:\n${JSON.stringify(result, null, 2)}`,
        },
      ],
      structuredContent: result as Record<string, unknown>,
    };
  } catch (error) {
    return toolErrorResult('Error adding adjustment layer', error);
  }
}

async function applyColorLookup(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: colorLookupBakeSchema,
    snippet: 'applyColorLookup',
    errorPrefix: 'Error applying color lookup',
    params: (args) => ({
      lutName: args.cl_lut_name as string,
      applyToActiveLayer: (args.apply_to_active_layer as boolean) ?? false,
    }),
    successText: (result) =>
      `Color Lookup applied (BAKE, experimental):\n${JSON.stringify(result, null, 2)}`,
  });
}

async function applyEqualize(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: equalizeSchema,
    snippet: 'applyEqualize',
    errorPrefix: 'Error applying equalize',
    params: (args) => ({
      applyToActiveLayer: (args.apply_to_active_layer as boolean) ?? false,
    }),
    successText: (result) => `Equalize applied:\n${JSON.stringify(result, null, 2)}`,
  });
}

async function applyShadowsHighlights(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: shadowsHighlightsSchema,
    snippet: 'applyShadowsHighlights',
    errorPrefix: 'Error applying shadows/highlights',
    params: (args) => ({
      shadowAmount: (args.shadow_amount as number) ?? 35,
      shadowWidth: (args.shadow_width as number) ?? 50,
      shadowRadius: (args.shadow_radius as number) ?? 30,
      highlightAmount: (args.highlight_amount as number) ?? 0,
      highlightWidth: (args.highlight_width as number) ?? 50,
      highlightRadius: (args.highlight_radius as number) ?? 30,
      colorCorrection: (args.color_correction as number) ?? 20,
      midtoneContrast: (args.midtone_contrast as number) ?? 0,
      blackClip: (args.black_clip as number) ?? 0.01,
      whiteClip: (args.white_clip as number) ?? 0.01,
      applyToActiveLayer: (args.apply_to_active_layer as boolean) ?? false,
    }),
    successText: (result, args) => {
      const r = result as { target_was_copy?: boolean; target_layer_name?: string };
      const target = r.target_was_copy
        ? `new copy "${r.target_layer_name ?? '?'}"`
        : 'active layer (in place)';
      const shadowAmount = (args.shadow_amount as number) ?? 35;
      const highlightAmount = (args.highlight_amount as number) ?? 0;
      const colorCorrection = (args.color_correction as number) ?? 20;
      return `Shadows/Highlights applied to ${target} (shadow ${shadowAmount}, highlight ${highlightAmount}, color ${colorCorrection}).`;
    },
  });
}
