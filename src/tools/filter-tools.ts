import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import type { SnippetClient } from '../api/snippet-client.js';
import { runScript } from '../utils/run-script.js';
import { validateArgs, type JsonSchemaObject } from '../utils/validate.js';
import { type DetectionClient } from '../detection/detection-client.js';
import { OnnxLandmarkDetectionClient } from '../detection/landmark-detection-client.js';
import { resolveGatedPlacement, PLACEMENT_SCHEMA } from '../perception/grounding-locate.js';
import { toolErrorResult, runSnippetTool, applyToActiveLayerProp } from '../utils/tool-helpers.js';

// Every filter tool auto-duplicates the active
// layer before applying the destructive op. The original layer is
// preserved; the filtered copy becomes the active layer. Callers that
// want the historical bake-into-active-layer behavior set
// `apply_to_active_layer: true`. See CLAUDE.md "Auto-duplicate-first
// pattern" for the rule.

const gaussianBlurSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    radius: {
      type: 'number',
      description: 'Blur radius in pixels (0.1-250).',
      minimum: 0.1,
      maximum: 250,
    },
    apply_to_active_layer: applyToActiveLayerProp('the filter'),
  },
  required: ['radius'],
};

const sharpenSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    amount: {
      type: 'number',
      description: 'Sharpening amount in percent (1-500).',
      minimum: 1,
      maximum: 500,
    },
    radius: {
      type: 'number',
      description: 'Radius in pixels (0.1-250).',
      minimum: 0.1,
      maximum: 250,
    },
    threshold: {
      type: 'integer',
      description: 'Threshold levels (0-255). Default: 0.',
      minimum: 0,
      maximum: 255,
      default: 0,
    },
    apply_to_active_layer: applyToActiveLayerProp('the filter'),
  },
  required: ['amount', 'radius'],
};

const noiseSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    amount: {
      type: 'number',
      description: 'Noise amount in percent (0.1-400).',
      minimum: 0.1,
      maximum: 400,
    },
    distribution: {
      type: 'string',
      description: 'Noise distribution type. Default: UNIFORM.',
      enum: ['UNIFORM', 'GAUSSIAN'],
      default: 'UNIFORM',
    },
    monochromatic: {
      type: 'boolean',
      description: 'Apply monochromatic noise. Default: false.',
      default: false,
    },
    apply_to_active_layer: applyToActiveLayerProp('the filter'),
  },
  required: ['amount'],
};

const motionBlurSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    angle: {
      type: 'number',
      description: 'Blur angle in degrees (-360 to 360).',
      minimum: -360,
      maximum: 360,
    },
    radius: {
      type: 'number',
      description: 'Blur distance in pixels (1-999).',
      minimum: 1,
      maximum: 999,
    },
    apply_to_active_layer: applyToActiveLayerProp('the filter'),
  },
  required: ['angle', 'radius'],
};

// ---------- Lens Blur, Smart Sharpen, Reduce Noise, High Pass ----------
// All follow the established auto-duplicate-first pattern.

const lensBlurSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    radius: {
      type: 'number',
      description:
        'Blur radius in pixels (0-100). PS default 15. Higher = more blur. The defining param of the filter — start here.',
      minimum: 0,
      maximum: 100,
      default: 15,
    },
    iris_shape: {
      type: 'string',
      enum: ['triangle', 'square', 'pentagon', 'hexagon', 'heptagon', 'octagon'],
      description:
        'Aperture iris shape — affects the look of out-of-focus highlights (bokeh). PS default hexagon. Triangle = 3 blades, octagon = 8 blades. Real lenses with fewer blades produce more polygonal bokeh.',
      default: 'hexagon',
    },
    iris_blade_curvature: {
      type: 'number',
      description:
        'Iris blade curvature (0-100). 0 = polygonal bokeh, 100 = perfectly circular. PS default 0.',
      minimum: 0,
      maximum: 100,
      default: 0,
    },
    iris_rotation: {
      type: 'number',
      description:
        'Iris rotation in degrees (0-360). Rotates the iris-shape pattern. PS default 0.',
      minimum: 0,
      maximum: 360,
      default: 0,
    },
    specular_brightness: {
      type: 'number',
      description:
        'Specular highlight brightness boost (0-255). PS default 0. Lift highlights to enhance bokeh "balls" — values around 50-100 produce visible specular highlights, higher = more dramatic.',
      minimum: 0,
      maximum: 255,
      default: 0,
    },
    specular_threshold: {
      type: 'number',
      description:
        'Specular highlight threshold (0-255). PS default 255 (no specular boost applies). Lower the threshold to let more pixels be treated as specular highlights for the brightness boost. Typical photographic use: 240-250.',
      minimum: 0,
      maximum: 255,
      default: 255,
    },
    noise_amount: {
      type: 'number',
      description:
        'Noise added to the blurred result (0-100). PS default 0. Lens Blur can produce un-naturally clean blur regions; a small noise amount (5-15) keeps the texture believable.',
      minimum: 0,
      maximum: 100,
      default: 0,
    },
    noise_distribution: {
      type: 'string',
      enum: ['uniform', 'gaussian'],
      description: 'Noise distribution type. PS default uniform.',
      default: 'uniform',
    },
    noise_monochromatic: {
      type: 'boolean',
      description: 'Monochromatic noise (luminance-only). PS default true.',
      default: true,
    },
    depth_source: {
      type: 'string',
      enum: ['none', 'transparency', 'layerMask'],
      description:
        'Depth map source for selective focus. "none" = uniform blur across the whole layer. "transparency" = use the layer alpha channel as depth (foreground sharper). "layerMask" = use the layer mask. PS default none.',
      default: 'none',
    },
    focal_distance: {
      type: 'number',
      description:
        'Focal-plane depth value (0-255), only meaningful when depth_source != none. Pixels at this depth stay sharp; pixels farther from it blur progressively.',
      minimum: 0,
      maximum: 255,
      default: 0,
    },
    invert_depth: {
      type: 'boolean',
      description: 'Invert the depth map. PS default false.',
      default: false,
    },
    apply_to_active_layer: applyToActiveLayerProp('the filter'),
  },
};

const smartSharpenSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    amount: {
      type: 'number',
      description: 'Sharpening amount (1-500%). PS default 100. The main strength dial.',
      minimum: 1,
      maximum: 500,
      default: 100,
    },
    radius: {
      type: 'number',
      description:
        'Sharpening radius in pixels (0.1-64). PS default 1.5. Determines the size of the edge detection — smaller for high-frequency detail, larger for soft edges.',
      minimum: 0.1,
      maximum: 64,
      default: 1.5,
    },
    noise_reduction: {
      type: 'number',
      description:
        'Noise reduction during sharpening (0-100). PS default 10. Prevents sharpening from amplifying existing noise. For low-light photos, raise this (25-50).',
      minimum: 0,
      maximum: 100,
      default: 10,
    },
    remove_mode: {
      type: 'string',
      enum: ['gaussianBlur', 'lensBlur', 'motionBlur'],
      description:
        'Blur model to remove. gaussianBlur (default) is the general-purpose modern Unsharp Mask replacement. lensBlur removes lens-style softness with better edge handling. motionBlur removes directional motion blur — pair with motion_angle.',
      default: 'lensBlur',
    },
    motion_angle: {
      type: 'number',
      description:
        'Motion blur angle in degrees (-360 to 360). Only meaningful when remove_mode=motionBlur.',
      minimum: -360,
      maximum: 360,
      default: 0,
    },
    shadow_fade: {
      type: 'number',
      description:
        'Shadows tab: amount of sharpening to fade in shadow regions (0-100). 0 = sharpen shadows fully, 100 = no shadow sharpening. Useful for preventing shadow-noise amplification. PS default 0.',
      minimum: 0,
      maximum: 100,
      default: 0,
    },
    shadow_tonal_width: {
      type: 'number',
      description:
        'Shadows tab: tonal width — how broadly "shadows" is defined (0-100). PS default 50.',
      minimum: 0,
      maximum: 100,
      default: 50,
    },
    shadow_radius: {
      type: 'number',
      description:
        'Shadows tab: local-contrast radius in pixels (1-100). PS default 30. Defines the neighborhood used to classify pixels as shadows.',
      minimum: 1,
      maximum: 100,
      default: 30,
    },
    highlight_fade: {
      type: 'number',
      description:
        'Highlights tab: amount of sharpening to fade in highlight regions (0-100). PS default 0.',
      minimum: 0,
      maximum: 100,
      default: 0,
    },
    highlight_tonal_width: {
      type: 'number',
      description: 'Highlights tab: tonal width (0-100). PS default 50.',
      minimum: 0,
      maximum: 100,
      default: 50,
    },
    highlight_radius: {
      type: 'number',
      description: 'Highlights tab: local-contrast radius in pixels (1-100). PS default 30.',
      minimum: 1,
      maximum: 100,
      default: 30,
    },
    apply_to_active_layer: applyToActiveLayerProp('the filter'),
  },
};

const reduceNoiseSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    strength: {
      type: 'number',
      description:
        'Luminance noise reduction strength (0-10). PS default 5. Higher = more aggressive noise reduction but more detail loss.',
      minimum: 0,
      maximum: 10,
      default: 5,
    },
    preserve_details: {
      type: 'number',
      description:
        'Preserve details percentage (0-100). PS default 50. Higher protects edges; lower lets the smoother kick in further.',
      minimum: 0,
      maximum: 100,
      default: 50,
    },
    color_noise: {
      type: 'number',
      description:
        'Color (chroma) noise reduction (0-100). PS default 45. Hits the colorful speckle noise typical of high-ISO photos.',
      minimum: 0,
      maximum: 100,
      default: 45,
    },
    sharpen_details: {
      type: 'number',
      description:
        'Sharpening to apply after noise reduction (0-100). PS default 25. Compensates for the softening that noise reduction causes.',
      minimum: 0,
      maximum: 100,
      default: 25,
    },
    remove_jpeg_artifact: {
      type: 'boolean',
      description:
        'Remove JPEG compression artifacts (the 8x8 block boundaries and ringing). PS default false.',
      default: false,
    },
    per_channel: {
      type: 'boolean',
      description:
        'Enable per-channel advanced mode. If true, the per-channel strength/preserve_details params (red_*, green_*, blue_*) override the global strength/preserve_details for each RGB channel — useful when noise is concentrated in one channel (typically blue for low-light shots). PS default false.',
      default: false,
    },
    red_strength: {
      type: 'number',
      description:
        'Per-channel: red channel noise-reduction strength (0-10). Only used when per_channel=true.',
      minimum: 0,
      maximum: 10,
      default: 5,
    },
    red_preserve_details: {
      type: 'number',
      description:
        'Per-channel: red channel preserve-details percentage (0-100). Only used when per_channel=true.',
      minimum: 0,
      maximum: 100,
      default: 50,
    },
    green_strength: {
      type: 'number',
      description: 'Per-channel: green channel noise-reduction strength.',
      minimum: 0,
      maximum: 10,
      default: 5,
    },
    green_preserve_details: {
      type: 'number',
      description: 'Per-channel: green channel preserve-details percentage.',
      minimum: 0,
      maximum: 100,
      default: 50,
    },
    blue_strength: {
      type: 'number',
      description:
        'Per-channel: blue channel noise-reduction strength. Usually the noisiest channel in low-light photos.',
      minimum: 0,
      maximum: 10,
      default: 5,
    },
    blue_preserve_details: {
      type: 'number',
      description: 'Per-channel: blue channel preserve-details percentage.',
      minimum: 0,
      maximum: 100,
      default: 50,
    },
    apply_to_active_layer: applyToActiveLayerProp('the filter'),
  },
};

const highPassSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    radius: {
      type: 'number',
      description:
        'High Pass radius in pixels (0.1-1000). PS default 10. Determines what counts as "edge detail" — small radius (1-5) for fine detail extraction (sharpening workflow), larger radius (50-100) for broader local-contrast effects (dodge-and-burn workflow).',
      minimum: 0.1,
      maximum: 1000,
      default: 10,
    },
    apply_to_active_layer: applyToActiveLayerProp('the filter'),
  },
  required: ['radius'],
};

const radialBlurSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    amount: {
      type: 'integer',
      description: 'Blur strength (1-100). PS default 10.',
      minimum: 1,
      maximum: 100,
      default: 10,
    },
    method: {
      type: 'string',
      description:
        'spin = rotational blur around the center (turntable motion); zoom = radial streaks toward/from the center (the classic "god rays" / speed-zoom look).',
      enum: ['spin', 'zoom'],
      default: 'spin',
    },
    quality: {
      type: 'string',
      description: 'Render quality. best is smoothest but slowest.',
      enum: ['draft', 'good', 'best'],
      default: 'good',
    },
    center_x: {
      type: 'number',
      description: 'Horizontal blur center, normalized 0-1 (0.5 = middle). Resolution-independent.',
      minimum: 0,
      maximum: 1,
      default: 0.5,
    },
    center_y: {
      type: 'number',
      description: 'Vertical blur center, normalized 0-1 (0.5 = middle). Resolution-independent.',
      minimum: 0,
      maximum: 1,
      default: 0.5,
    },
    center_placement: {
      ...PLACEMENT_SCHEMA,
      description:
        'Grounded alternative to center_x/center_y: NAME the blur center (a `placement` resolving to a POINT — an object centroid, an extremum, a grid intersection). The resolved document-pixel point is normalized to the 0-1 center for you and WINS over center_x/center_y. The blur runs ONLY if the objective gate PASSES.',
    },
    apply_to_active_layer: applyToActiveLayerProp('the filter'),
  },
};

const pixelateSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    mode: {
      type: 'string',
      enum: ['color_halftone', 'mosaic', 'crystallize', 'pointillize', 'facet', 'fragment'],
      description:
        'color_halftone = simulated CMYK halftone dot screen (retro comic / print-dot look); mosaic = blocky square cells (pixelation / censor look); crystallize = irregular polygonal cells of solid color; pointillize = random dots over the background color (painterly stipple); facet = clumps similar-colored pixels into flat blocks (parameterless); fragment = four offset copies averaged for a shaken/blurry look (parameterless).',
    },
    max_radius: {
      type: 'integer',
      description: 'color_halftone only: maximum dot radius in pixels (4-127). PS default 8.',
      minimum: 4,
      maximum: 127,
      default: 8,
    },
    angle_1: {
      type: 'integer',
      description: 'color_halftone only: screen angle for channel 1 in degrees. PS default 108.',
      minimum: -360,
      maximum: 360,
      default: 108,
    },
    angle_2: {
      type: 'integer',
      description: 'color_halftone only: screen angle for channel 2. PS default 162.',
      minimum: -360,
      maximum: 360,
      default: 162,
    },
    angle_3: {
      type: 'integer',
      description: 'color_halftone only: screen angle for channel 3. PS default 90.',
      minimum: -360,
      maximum: 360,
      default: 90,
    },
    angle_4: {
      type: 'integer',
      description: 'color_halftone only: screen angle for channel 4. PS default 45.',
      minimum: -360,
      maximum: 360,
      default: 45,
    },
    cell_size: {
      type: 'integer',
      description:
        'Cell size in pixels — used by mosaic (2-300, PS default 10), crystallize (3-300), and pointillize (3-300, PS default 5). Ignored by color_halftone/facet/fragment.',
      minimum: 2,
      maximum: 300,
      default: 10,
    },
    apply_to_active_layer: applyToActiveLayerProp('the filter'),
  },
  required: ['mode'],
};

const distortSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    mode: {
      type: 'string',
      enum: ['twirl', 'ripple', 'polar', 'wave', 'pinch', 'spherize', 'zigzag'],
      description:
        'twirl = rotational swirl; ripple = fixed-size wavy displacement; polar = rectangular<->polar coordinate warp (wrap a strip into a circle / "tiny planet", or unwrap a panorama); wave = multi-generator sine/triangle/square waves; pinch = squeeze/bulge toward or away from center; spherize = wrap onto a sphere (bulge); zigzag = concentric ripples (pond-ripple style).',
    },
    angle: {
      type: 'integer',
      description: 'twirl only: swirl angle in degrees (-999 to 999; positive = clockwise).',
      minimum: -999,
      maximum: 999,
      default: 90,
    },
    amount: {
      type: 'integer',
      description:
        'Displacement amount. ripple: -999 to 999 (default 100). pinch: -100 to 100 (positive pinches inward, negative bulges; default 50). spherize: -100 to 100 (positive bulges out; default 100). zigzag: -100 to 100 (default 10).',
      minimum: -999,
      maximum: 999,
      default: 100,
    },
    ridges: {
      type: 'integer',
      description: 'zigzag only: number of concentric ridges (0-20). PS default 5.',
      minimum: 0,
      maximum: 20,
      default: 5,
    },
    size: {
      type: 'string',
      enum: ['small', 'medium', 'large'],
      description: 'ripple only: ripple wavelength size.',
      default: 'medium',
    },
    conversion: {
      type: 'string',
      enum: ['rect_to_polar', 'polar_to_rect'],
      description:
        'polar only: rect_to_polar wraps the image into a circle; polar_to_rect unwraps it.',
      default: 'rect_to_polar',
    },
    wave_type: {
      type: 'string',
      enum: ['sine', 'triangle', 'square'],
      description: 'wave only: waveform shape.',
      default: 'sine',
    },
    generators: {
      type: 'integer',
      description: 'wave only: number of wave generators (1-999).',
      minimum: 1,
      maximum: 999,
      default: 5,
    },
    wavelength_min: {
      type: 'integer',
      description: 'wave only: minimum wavelength (1-998; must be <= wavelength_max).',
      minimum: 1,
      maximum: 998,
      default: 10,
    },
    wavelength_max: {
      type: 'integer',
      description: 'wave only: maximum wavelength (1-999).',
      minimum: 1,
      maximum: 999,
      default: 120,
    },
    amplitude_min: {
      type: 'integer',
      description: 'wave only: minimum amplitude (1-998; must be <= amplitude_max).',
      minimum: 1,
      maximum: 998,
      default: 5,
    },
    amplitude_max: {
      type: 'integer',
      description: 'wave only: maximum amplitude (1-999).',
      minimum: 1,
      maximum: 999,
      default: 35,
    },
    scale_horizontal: {
      type: 'integer',
      description: 'wave only: horizontal scale percent (1-100).',
      minimum: 1,
      maximum: 100,
      default: 100,
    },
    scale_vertical: {
      type: 'integer',
      description: 'wave only: vertical scale percent (1-100).',
      minimum: 1,
      maximum: 100,
      default: 100,
    },
    undefined_areas: {
      type: 'string',
      enum: ['repeat_edge', 'wrap_around'],
      description: 'wave only: how to fill areas pushed outside the layer.',
      default: 'repeat_edge',
    },
    random_seed: {
      type: 'integer',
      description: 'wave only: random seed for the wave pattern (change for a different pattern).',
      minimum: 0,
      default: 12345,
    },
    apply_to_active_layer: applyToActiveLayerProp('the filter'),
  },
  required: ['mode'],
};

const stylizeSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    mode: {
      type: 'string',
      enum: ['emboss', 'find_edges', 'solarize', 'wind', 'trace_contour', 'tiles'],
      description:
        'emboss = grey relief with raised edges (angle/height/amount); find_edges = outline edges on a white field (parameterless); solarize = partial tonal inversion (parameterless); wind = fine directional streaks (wind_method + wind_direction); trace_contour = thin contour lines at a brightness level (level + edge); tiles = break the image into offset square tiles (number + offset).',
    },
    angle: {
      type: 'integer',
      description: 'emboss only: relief angle in degrees (-360 to 360). PS default 135.',
      minimum: -360,
      maximum: 360,
      default: 135,
    },
    amount: {
      type: 'integer',
      description: 'emboss only: amount percent (1-500). PS default 100.',
      minimum: 1,
      maximum: 500,
      default: 100,
    },
    height: {
      type: 'integer',
      description: 'emboss only: relief height in pixels (1-100). PS default 3.',
      minimum: 1,
      maximum: 100,
      default: 3,
    },
    wind_method: {
      type: 'string',
      enum: ['wind', 'blast', 'stagger'],
      description: 'wind only: streak intensity/style. PS default wind.',
      default: 'wind',
    },
    wind_direction: {
      type: 'string',
      enum: ['left', 'right'],
      description: 'wind only: streak direction. PS default left.',
      default: 'left',
    },
    level: {
      type: 'integer',
      description:
        'trace_contour only: brightness level the contour traces (0-255). PS default 128.',
      minimum: 0,
      maximum: 255,
      default: 128,
    },
    edge: {
      type: 'string',
      enum: ['lower', 'upper'],
      description:
        'trace_contour only: trace the lower or upper edge of the level. PS default lower.',
      default: 'lower',
    },
    number: {
      type: 'integer',
      description: 'tiles only: number of tiles across (1-99). PS default 10.',
      minimum: 1,
      maximum: 99,
      default: 10,
    },
    offset: {
      type: 'integer',
      description: 'tiles only: maximum tile offset percent (1-99). PS default 10.',
      minimum: 1,
      maximum: 99,
      default: 10,
    },
    apply_to_active_layer: applyToActiveLayerProp('the filter'),
  },
  required: ['mode'],
};

const renderSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    mode: {
      type: 'string',
      enum: ['clouds', 'difference_clouds', 'fibers'],
      description:
        'clouds = soft random cloud texture from the current foreground/background colors (replaces the layer content); difference_clouds = clouds blended via Difference with the existing pixels (run repeatedly for marble/veining); fibers = woven fiber texture from the FG/BG colors. All three read the FG/BG colors — set them first for a specific palette.',
    },
    variance: {
      type: 'integer',
      description: 'fibers only: color variance / streak length (1-64). PS default 16.',
      minimum: 1,
      maximum: 64,
      default: 16,
    },
    fiber_strength: {
      type: 'integer',
      description: 'fibers only: fiber strength / definition (1-64). PS default 4.',
      minimum: 1,
      maximum: 64,
      default: 4,
    },
    seed: {
      type: 'integer',
      description:
        'fibers only: randomize seed — change for a different fiber pattern. PS default 12345.',
      minimum: 0,
      default: 12345,
    },
    apply_to_active_layer: applyToActiveLayerProp('the filter'),
  },
  required: ['mode'],
};

const otherSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    mode: {
      type: 'string',
      enum: ['maximum', 'minimum', 'offset'],
      description:
        'maximum = spread/grow bright areas (choke masks, radius + preserve); minimum = spread dark areas (radius + preserve); offset = shift the layer by horizontal/vertical pixels and wrap the edges (seamless-tile workflow).',
    },
    radius: {
      type: 'number',
      description: 'maximum/minimum only: radius in pixels (1-500). PS default 3.',
      minimum: 1,
      maximum: 500,
      default: 3,
    },
    preserve: {
      type: 'string',
      enum: ['roundness', 'squareness'],
      description: 'maximum/minimum only: edge-preservation shape. PS default roundness.',
      default: 'roundness',
    },
    horizontal: {
      type: 'integer',
      description: 'offset only: horizontal shift in pixels (positive = right).',
      default: 0,
    },
    vertical: {
      type: 'integer',
      description: 'offset only: vertical shift in pixels (positive = down).',
      default: 0,
    },
    apply_to_active_layer: applyToActiveLayerProp('the filter'),
  },
  required: ['mode'],
};

const denoiseSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    mode: {
      type: 'string',
      enum: ['median', 'dust_and_scratches', 'despeckle'],
      description:
        'median = replace each pixel with the median of its neighborhood (removes speckle, radius); dust_and_scratches = remove small defects above a threshold (radius + threshold); despeckle = light edge-preserving blur (parameterless).',
    },
    radius: {
      type: 'number',
      description:
        'median/dust_and_scratches only: radius in pixels (1-100). PS default 4 (median) / 3 (dust).',
      minimum: 1,
      maximum: 100,
      default: 4,
    },
    threshold: {
      type: 'integer',
      description:
        'dust_and_scratches only: tonal threshold (0-255) below which differences are smoothed. PS default 10.',
      minimum: 0,
      maximum: 255,
      default: 10,
    },
    apply_to_active_layer: applyToActiveLayerProp('the filter'),
  },
  required: ['mode'],
};

const blurAdvSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    mode: {
      type: 'string',
      enum: ['surface_blur', 'box_blur', 'average'],
      description:
        'surface_blur = blur while preserving edges above a threshold (skin-smoothing; radius + threshold); box_blur = fast square-kernel blur (radius); average = fill the layer with its single average color (parameterless).',
    },
    radius: {
      type: 'number',
      description:
        'surface_blur/box_blur only: radius in pixels (1-500). PS default 15 (surface) / 12 (box).',
      minimum: 1,
      maximum: 500,
      default: 15,
    },
    threshold: {
      type: 'integer',
      description:
        'surface_blur only: tonal threshold (0-255) — edges differing by more than this are preserved. PS default 20.',
      minimum: 0,
      maximum: 255,
      default: 20,
    },
    apply_to_active_layer: applyToActiveLayerProp('the filter'),
  },
  required: ['mode'],
};

const oilPaintSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    stylization: {
      type: 'number',
      description: 'Brush-stroke stylization (0.1-10).',
      minimum: 0.1,
      maximum: 10,
      default: 4,
    },
    cleanliness: {
      type: 'number',
      description: 'Stroke cleanliness / smoothness (0-10).',
      minimum: 0,
      maximum: 10,
      default: 2.3,
    },
    brush_scale: {
      type: 'number',
      description: 'Brush scale (0.1-2).',
      minimum: 0.1,
      maximum: 2,
      default: 0.8,
    },
    bristle_detail: {
      type: 'number',
      description: 'Bristle detail (0-10).',
      minimum: 0,
      maximum: 10,
      default: 10,
    },
    light_direction: {
      type: 'integer',
      description: 'Lighting angle in degrees (-180 to 180).',
      minimum: -180,
      maximum: 180,
      default: -60,
    },
    shine: {
      type: 'number',
      description: 'Specular shine (0-10).',
      minimum: 0,
      maximum: 10,
      default: 1.3,
    },
    lighting_on: {
      type: 'boolean',
      description: 'Whether the lighting/shine relief is applied.',
      default: true,
    },
    apply_to_active_layer: applyToActiveLayerProp('the filter'),
  },
};

const displaceSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    map_path: {
      type: 'string',
      description:
        "Absolute path to the displacement-map .psd file (required). The map's brightness drives the per-pixel warp — mid-gray = no shift, lighter/darker push in opposite directions.",
    },
    horizontal_scale: {
      type: 'integer',
      description: 'Horizontal displacement scale (-999 to 999). PS default 10.',
      minimum: -999,
      maximum: 999,
      default: 10,
    },
    vertical_scale: {
      type: 'integer',
      description: 'Vertical displacement scale (-999 to 999). PS default 10.',
      minimum: -999,
      maximum: 999,
      default: 10,
    },
    displacement_map: {
      type: 'string',
      enum: ['stretch_to_fit', 'tile'],
      description:
        'How the map fits the layer: stretch_to_fit (resize the map) or tile (repeat it).',
      default: 'stretch_to_fit',
    },
    undefined_areas: {
      type: 'string',
      enum: ['repeat_edge', 'wrap_around'],
      description: 'How to fill areas pushed outside the layer.',
      default: 'repeat_edge',
    },
    apply_to_active_layer: applyToActiveLayerProp('the filter'),
  },
  required: ['map_path'],
};

const FILTER_OUTPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    applied: { type: 'boolean' as const },
    filter: { type: 'string' as const },
    target_was_copy: { type: 'boolean' as const },
    target_layer_name: { type: 'string' as const },
    original_layer_name: { type: 'string' as const },
    context: { type: 'object' as const },
  },
};

const FILTER_TYPES = [
  'gaussian_blur',
  'motion_blur',
  'lens_blur',
  'radial_blur',
  'sharpen',
  'smart_sharpen',
  'noise',
  'reduce_noise',
  'high_pass',
  'pixelate',
  'distort',
  'stylize',
  'render',
  'other',
  'denoise',
  'blur',
  'displace',
  'oil_paint',
] as const;

// Single discriminated input schema for the consolidated ps_apply_filter
// tool. Built by merging every per-type schema's properties so the LLM sees the
// full parameter surface; the `type` field documents which params each filter
// uses, and the handler re-validates the args against the EXACT per-type schema
// (correct ranges + required fields). Shared param names (radius/amount/angle)
// carry generic descriptions here because their range depends on `type` — the
// per-type validation enforces the real bounds.
const FILTER_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: [...FILTER_TYPES],
      description:
        'Which filter to apply. Each type uses its own parameters: ' +
        'gaussian_blur(radius); motion_blur(angle, radius); lens_blur(radius, iris_shape, …); ' +
        'radial_blur(amount, method spin|zoom, quality, center_x, center_y); ' +
        'sharpen=Unsharp Mask(amount, radius, threshold); smart_sharpen(amount, radius, remove_mode, …); ' +
        'noise=Add Noise(amount, distribution, monochromatic); ' +
        'reduce_noise(strength, preserve_details, color_noise, …); high_pass(radius); ' +
        'pixelate(mode color_halftone|mosaic|crystallize|pointillize|facet|fragment, …); distort(mode twirl|ripple|polar|wave|pinch|spherize|zigzag, …); ' +
        'stylize(mode emboss|find_edges|solarize|wind|trace_contour|tiles, …); ' +
        'render(mode clouds|difference_clouds|fibers, …); ' +
        'other(mode maximum|minimum|offset, …); denoise(mode median|dust_and_scratches|despeckle, …); blur(mode surface_blur|box_blur|average, …); ' +
        'displace(map_path, horizontal_scale, vertical_scale, …); oil_paint(stylization, cleanliness, …).',
    },
    ...gaussianBlurSchema.properties,
    ...motionBlurSchema.properties,
    ...lensBlurSchema.properties,
    ...radialBlurSchema.properties,
    ...sharpenSchema.properties,
    ...smartSharpenSchema.properties,
    ...noiseSchema.properties,
    ...reduceNoiseSchema.properties,
    ...highPassSchema.properties,
    ...pixelateSchema.properties,
    ...distortSchema.properties,
    ...stylizeSchema.properties,
    ...renderSchema.properties,
    ...otherSchema.properties,
    ...denoiseSchema.properties,
    ...blurAdvSchema.properties,
    ...displaceSchema.properties,
    ...oilPaintSchema.properties,
    // Override the collision-prone shared names with type-agnostic docs (real
    // ranges enforced per-type in the handler).
    radius: {
      type: 'number',
      description:
        'Radius/distance in px. Range depends on type — gaussian_blur 0.1–250, motion_blur 1–999, lens_blur 0–100, smart_sharpen 0.1–64, high_pass 0.1–1000.',
    },
    amount: {
      type: 'number',
      description:
        'Filter strength. Range depends on type — sharpen 1–500, noise 0.1–400, radial_blur 1–100, distort/ripple −999–999.',
    },
    angle: {
      type: 'number',
      description: 'Angle in degrees. Used by motion_blur (−360–360) and distort/twirl (−999–999).',
    },
    apply_to_active_layer: applyToActiveLayerProp('the filter'),
  },
  required: ['type'],
};

export function createFilterTools(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  // Backs anchor-relational `center_placement` on type=radial_blur only; the other
  // filters never touch it. Mesh-capable default (matches ps_crop_document /
  // ps_transform_layer); a landmark center degrades to CE boxes when the mesh is absent.
  client: DetectionClient = new OnnxLandmarkDetectionClient()
): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'ps_apply_filter',
        description:
          'Apply a Photoshop filter to a DUPLICATE of the active layer by default (auto-duplicate-first — the original is preserved, undo by deleting the copy). Pass `apply_to_active_layer: true` to bake into the original. Auto-rasterizes text/smart-object layers. Choose the filter with `type`; each type takes its own parameters (see the `type` field). Covers blur (gaussian_blur/motion_blur/lens_blur/radial_blur), sharpen (`sharpen`=Unsharp Mask, `smart_sharpen`), noise (`noise`=Add Noise, `reduce_noise`), high_pass, pixelate, distort, displace, and oil_paint.',
        inputSchema: FILTER_INPUT_SCHEMA,
        outputSchema: FILTER_OUTPUT_SCHEMA,
        annotations: {
          title: 'Apply Filter',
          destructiveHint: true,
          idempotentHint: false,
        },
      },
      handler: async (args) => applyFilter(connection, snippetClient, client, args),
    },
  ];
}

// Dispatch the consolidated tool to the per-filter handler. `type` is stripped
// so the delegate validates only its own params against its per-type schema.
async function applyFilter(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  detClient: DetectionClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  const type = rawArgs.type;
  const { type: _omit, ...rest } = rawArgs;
  switch (type) {
    case 'gaussian_blur':
      return applyGaussianBlur(connection, snippetClient, rest);
    case 'motion_blur':
      return applyMotionBlur(connection, snippetClient, rest);
    case 'lens_blur':
      return applyLensBlur(connection, snippetClient, rest);
    case 'radial_blur':
      return applyRadialBlur(connection, snippetClient, detClient, rest);
    case 'sharpen':
      return applySharpen(connection, snippetClient, rest);
    case 'smart_sharpen':
      return applySmartSharpen(connection, snippetClient, rest);
    case 'noise':
      return applyNoise(connection, snippetClient, rest);
    case 'reduce_noise':
      return applyReduceNoise(connection, snippetClient, rest);
    case 'high_pass':
      return applyHighPass(connection, snippetClient, rest);
    case 'pixelate':
      return applyPixelate(connection, snippetClient, rest);
    case 'distort':
      return applyDistort(connection, snippetClient, rest);
    case 'stylize':
      return applyStylize(connection, snippetClient, rest);
    case 'render':
      return applyRender(connection, snippetClient, rest);
    case 'other':
      return applyOther(connection, snippetClient, rest);
    case 'denoise':
      return applyDenoise(connection, snippetClient, rest);
    case 'blur':
      return applyBlurAdv(connection, snippetClient, rest);
    case 'displace':
      return applyDisplace(connection, snippetClient, rest);
    case 'oil_paint':
      return applyOilPaint(connection, snippetClient, rest);
    default:
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: unknown filter type "${String(type)}". Allowed: ${FILTER_TYPES.join(', ')}.`,
          },
        ],
        isError: true,
      };
  }
}

async function applyGaussianBlur(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: gaussianBlurSchema,
    snippet: 'applyGaussianBlur',
    errorPrefix: 'Error applying Gaussian Blur',
    params: (args) => ({
      radius: args.radius as number,
      applyToActiveLayer: (args.apply_to_active_layer as boolean) ?? false,
    }),
    successText: (result, args) => {
      const r = result as { target_was_copy?: boolean; target_layer_name?: string };
      const target = r.target_was_copy
        ? `new copy "${r.target_layer_name ?? '?'}"`
        : 'active layer (in place)';
      return `Gaussian Blur radius ${args.radius as number}px applied to ${target}.`;
    },
  });
}

async function applySharpen(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: sharpenSchema,
    snippet: 'applyUnsharpMask',
    errorPrefix: 'Error applying sharpen',
    params: (args) => ({
      amount: args.amount as number,
      radius: args.radius as number,
      threshold: args.threshold as number,
      applyToActiveLayer: (args.apply_to_active_layer as boolean) ?? false,
    }),
    successText: (result, args) => {
      const r = result as { target_was_copy?: boolean; target_layer_name?: string };
      const target = r.target_was_copy
        ? `new copy "${r.target_layer_name ?? '?'}"`
        : 'active layer (in place)';
      return `Unsharp Mask (amount ${args.amount as number}%, radius ${args.radius as number}px, threshold ${args.threshold as number}) applied to ${target}.`;
    },
  });
}

async function applyNoise(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: noiseSchema,
    snippet: 'applyAddNoise',
    errorPrefix: 'Error applying noise',
    params: (args) => ({
      amount: args.amount as number,
      distribution: args.distribution as string,
      monochromatic: args.monochromatic as boolean,
      applyToActiveLayer: (args.apply_to_active_layer as boolean) ?? false,
    }),
    successText: (result, args) => {
      const r = result as { target_was_copy?: boolean; target_layer_name?: string };
      const target = r.target_was_copy
        ? `new copy "${r.target_layer_name ?? '?'}"`
        : 'active layer (in place)';
      const amount = args.amount as number;
      const distribution = args.distribution as string;
      const monochromatic = args.monochromatic as boolean;
      return `Add Noise ${amount}% (${distribution}${monochromatic ? ', mono' : ''}) applied to ${target}.`;
    },
  });
}

async function applyMotionBlur(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: motionBlurSchema,
    snippet: 'applyMotionBlur',
    errorPrefix: 'Error applying motion blur',
    params: (args) => ({
      angle: args.angle as number,
      radius: args.radius as number,
      applyToActiveLayer: (args.apply_to_active_layer as boolean) ?? false,
    }),
    successText: (result, args) => {
      const r = result as { target_was_copy?: boolean; target_layer_name?: string };
      const target = r.target_was_copy
        ? `new copy "${r.target_layer_name ?? '?'}"`
        : 'active layer (in place)';
      return `Motion Blur (angle ${args.angle as number}°, radius ${args.radius as number}px) applied to ${target}.`;
    },
  });
}

async function applyLensBlur(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: lensBlurSchema,
    snippet: 'applyLensBlur',
    errorPrefix: 'Error applying Lens Blur',
    params: (args) => ({
      radius: (args.radius as number) ?? 15,
      irisShape: (args.iris_shape as string) ?? 'hexagon',
      irisBladeCurvature: (args.iris_blade_curvature as number) ?? 0,
      irisRotation: (args.iris_rotation as number) ?? 0,
      specularBrightness: (args.specular_brightness as number) ?? 0,
      specularThreshold: (args.specular_threshold as number) ?? 255,
      noiseAmount: (args.noise_amount as number) ?? 0,
      noiseDistribution: (args.noise_distribution as string) ?? 'uniform',
      noiseMonochromatic: (args.noise_monochromatic as boolean) ?? true,
      depthSource: (args.depth_source as string) ?? 'none',
      focalDistance: (args.focal_distance as number) ?? 0,
      invertDepth: (args.invert_depth as boolean) ?? false,
      applyToActiveLayer: (args.apply_to_active_layer as boolean) ?? false,
    }),
    successText: (result, args) => {
      const r = result as { target_was_copy?: boolean; target_layer_name?: string };
      const target = r.target_was_copy
        ? `new copy "${r.target_layer_name ?? '?'}"`
        : 'active layer (in place)';
      const radius = (args.radius as number) ?? 15;
      const irisShape = (args.iris_shape as string) ?? 'hexagon';
      const depthSource = (args.depth_source as string) ?? 'none';
      return `Lens Blur (radius ${radius}px, ${irisShape} iris${depthSource !== 'none' ? `, depth=${depthSource}` : ''}) applied to ${target}.`;
    },
  });
}

async function applySmartSharpen(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: smartSharpenSchema,
    snippet: 'applySmartSharpen',
    errorPrefix: 'Error applying Smart Sharpen',
    params: (args) => ({
      amount: (args.amount as number) ?? 100,
      radius: (args.radius as number) ?? 1.5,
      noiseReduction: (args.noise_reduction as number) ?? 10,
      removeMode: (args.remove_mode as string) ?? 'lensBlur',
      motionAngle: (args.motion_angle as number) ?? 0,
      shadowFade: (args.shadow_fade as number) ?? 0,
      shadowTonalWidth: (args.shadow_tonal_width as number) ?? 50,
      shadowRadius: (args.shadow_radius as number) ?? 30,
      highlightFade: (args.highlight_fade as number) ?? 0,
      highlightTonalWidth: (args.highlight_tonal_width as number) ?? 50,
      highlightRadius: (args.highlight_radius as number) ?? 30,
      applyToActiveLayer: (args.apply_to_active_layer as boolean) ?? false,
    }),
    successText: (result, args) => {
      const r = result as { target_was_copy?: boolean; target_layer_name?: string };
      const target = r.target_was_copy
        ? `new copy "${r.target_layer_name ?? '?'}"`
        : 'active layer (in place)';
      const amount = (args.amount as number) ?? 100;
      const radius = (args.radius as number) ?? 1.5;
      const removeMode = (args.remove_mode as string) ?? 'lensBlur';
      return `Smart Sharpen (amount ${amount}%, radius ${radius}px, remove ${removeMode}) applied to ${target}.`;
    },
  });
}

async function applyReduceNoise(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: reduceNoiseSchema,
    snippet: 'applyReduceNoise',
    errorPrefix: 'Error applying Reduce Noise',
    params: (args) => ({
      strength: (args.strength as number) ?? 5,
      preserveDetails: (args.preserve_details as number) ?? 50,
      colorNoise: (args.color_noise as number) ?? 45,
      sharpenDetails: (args.sharpen_details as number) ?? 25,
      removeJpegArtifact: (args.remove_jpeg_artifact as boolean) ?? false,
      perChannel: (args.per_channel as boolean) ?? false,
      redStrength: (args.red_strength as number) ?? 5,
      redPreserveDetails: (args.red_preserve_details as number) ?? 50,
      greenStrength: (args.green_strength as number) ?? 5,
      greenPreserveDetails: (args.green_preserve_details as number) ?? 50,
      blueStrength: (args.blue_strength as number) ?? 5,
      bluePreserveDetails: (args.blue_preserve_details as number) ?? 50,
      applyToActiveLayer: (args.apply_to_active_layer as boolean) ?? false,
    }),
    successText: (result, args) => {
      const r = result as { target_was_copy?: boolean; target_layer_name?: string };
      const target = r.target_was_copy
        ? `new copy "${r.target_layer_name ?? '?'}"`
        : 'active layer (in place)';
      const strength = (args.strength as number) ?? 5;
      const colorNoise = (args.color_noise as number) ?? 45;
      const perChannel = (args.per_channel as boolean) ?? false;
      return `Reduce Noise (strength ${strength}, color ${colorNoise}${perChannel ? ', per-channel' : ''}) applied to ${target}.`;
    },
  });
}

async function applyHighPass(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: highPassSchema,
    snippet: 'applyHighPass',
    errorPrefix: 'Error applying High Pass',
    params: (args) => ({
      radius: args.radius as number,
      applyToActiveLayer: (args.apply_to_active_layer as boolean) ?? false,
    }),
    successText: (result, args) => {
      const r = result as { target_was_copy?: boolean; target_layer_name?: string };
      const target = r.target_was_copy
        ? `new copy "${r.target_layer_name ?? '?'}"`
        : 'active layer (in place)';
      return `High Pass (radius ${args.radius as number}px) applied to ${target}.`;
    },
  });
}

async function applyRadialBlur(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  detClient: DetectionClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(radialBlurSchema, rawArgs);
    const amount = (args.amount as number) ?? 10;
    const method = (args.method as string) ?? 'spin';
    const quality = (args.quality as string) ?? 'good';
    let centerX = (args.center_x as number) ?? 0.5;
    let centerY = (args.center_y as number) ?? 0.5;
    // Grounded center: resolve a placement to a POINT + the doc dims, then normalize
    // to the filter's 0-1 center (fail-closed on gate REJECT / non-point). Wins over
    // the raw center_x/center_y.
    let grounded: { x: number; y: number } | undefined;
    if (args.center_placement) {
      const loc = await resolveGatedPlacement(connection, detClient, args.center_placement, {
        expect: 'point',
        label: 'radial-blur center',
      });
      // Normalize to 0-1, guarding a 0/NaN doc dimension (→ fall back to centre).
      centerX = loc.docW > 0 ? Math.min(1, Math.max(0, loc.geom.point.x / loc.docW)) : 0.5;
      centerY = loc.docH > 0 ? Math.min(1, Math.max(0, loc.geom.point.y / loc.docH)) : 0.5;
      grounded = { x: Math.round(loc.geom.point.x), y: Math.round(loc.geom.point.y) };
    }
    const applyToActiveLayer = (args.apply_to_active_layer as boolean) ?? false;

    const script = await snippetClient.build('applyRadialBlur', {
      amount,
      method,
      quality,
      centerX,
      centerY,
      applyToActiveLayer,
    });
    const result = await runScript(connection, script);

    const r = result as { target_was_copy?: boolean; target_layer_name?: string };
    const target = r.target_was_copy
      ? `new copy "${r.target_layer_name ?? '?'}"`
      : 'active layer (in place)';
    const groundedNote = grounded
      ? ` centered on (${grounded.x},${grounded.y}) via placement (gate PASS)`
      : '';
    const structured = result as Record<string, unknown>;
    if (grounded) {
      structured.center_placement = {
        gate: { pass: true },
        point: grounded,
        center: { x: Number(centerX.toFixed(4)), y: Number(centerY.toFixed(4)) },
      };
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: `Radial Blur (${method}, amount ${amount}) applied to ${target}${groundedNote}.`,
        },
      ],
      structuredContent: structured,
    };
  } catch (error) {
    return toolErrorResult('Error applying Radial Blur', error);
  }
}

async function applyPixelate(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: pixelateSchema,
    snippet: 'applyPixelate',
    errorPrefix: 'Error applying Pixelate',
    params: (args) => {
      const mode = args.mode as string;
      const applyToActiveLayer = (args.apply_to_active_layer as boolean) ?? false;

      const params: Record<string, unknown> = { mode, applyToActiveLayer };
      if (mode === 'mosaic' || mode === 'crystallize' || mode === 'pointillize') {
        params.cellSize = (args.cell_size as number) ?? 10;
      } else if (mode === 'color_halftone') {
        params.maxRadius = (args.max_radius as number) ?? 8;
        params.angle1 = (args.angle_1 as number) ?? 108;
        params.angle2 = (args.angle_2 as number) ?? 162;
        params.angle3 = (args.angle_3 as number) ?? 90;
        params.angle4 = (args.angle_4 as number) ?? 45;
      }
      // facet / fragment take no parameters (undefined descriptor).
      return params;
    },
    successText: (result, args) => {
      const r = result as { target_was_copy?: boolean; target_layer_name?: string };
      const target = r.target_was_copy
        ? `new copy "${r.target_layer_name ?? '?'}"`
        : 'active layer (in place)';
      return `Pixelate (${args.mode as string}) applied to ${target}.`;
    },
  });
}

async function applyDistort(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: distortSchema,
    snippet: 'applyDistort',
    errorPrefix: 'Error applying Distort',
    params: (args) => {
      const mode = args.mode as string;
      const applyToActiveLayer = (args.apply_to_active_layer as boolean) ?? false;

      const params: Record<string, unknown> = { mode, applyToActiveLayer };
      if (mode === 'twirl') {
        params.angle = (args.angle as number) ?? 90;
      } else if (mode === 'pinch') {
        params.amount = (args.amount as number) ?? 50;
      } else if (mode === 'spherize') {
        params.amount = (args.amount as number) ?? 100;
      } else if (mode === 'zigzag') {
        params.amount = (args.amount as number) ?? 10;
        params.ridges = (args.ridges as number) ?? 5;
      } else if (mode === 'ripple') {
        params.amount = (args.amount as number) ?? 100;
        params.size = (args.size as string) ?? 'medium';
      } else if (mode === 'polar') {
        params.conversion = (args.conversion as string) ?? 'rect_to_polar';
      } else if (mode === 'wave') {
        params.waveType = (args.wave_type as string) ?? 'sine';
        params.generators = (args.generators as number) ?? 5;
        params.wavelengthMin = (args.wavelength_min as number) ?? 10;
        params.wavelengthMax = (args.wavelength_max as number) ?? 120;
        params.amplitudeMin = (args.amplitude_min as number) ?? 5;
        params.amplitudeMax = (args.amplitude_max as number) ?? 35;
        params.scaleHorizontal = (args.scale_horizontal as number) ?? 100;
        params.scaleVertical = (args.scale_vertical as number) ?? 100;
        params.undefinedAreas = (args.undefined_areas as string) ?? 'repeat_edge';
        params.randomSeed = (args.random_seed as number) ?? 12345;
      }
      return params;
    },
    successText: (result, args) => {
      const r = result as { target_was_copy?: boolean; target_layer_name?: string };
      const target = r.target_was_copy
        ? `new copy "${r.target_layer_name ?? '?'}"`
        : 'active layer (in place)';
      return `Distort (${args.mode as string}) applied to ${target}.`;
    },
  });
}

async function applyStylize(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: stylizeSchema,
    snippet: 'applyStylize',
    errorPrefix: 'Error applying Stylize',
    params: (args) => {
      const mode = args.mode as string;
      const applyToActiveLayer = (args.apply_to_active_layer as boolean) ?? false;

      const params: Record<string, unknown> = { mode, applyToActiveLayer };
      if (mode === 'emboss') {
        params.angle = (args.angle as number) ?? 135;
        params.height = (args.height as number) ?? 3;
        params.amount = (args.amount as number) ?? 100;
      } else if (mode === 'wind') {
        params.method = (args.wind_method as string) ?? 'wind';
        params.direction = (args.wind_direction as string) ?? 'left';
      } else if (mode === 'trace_contour') {
        params.level = (args.level as number) ?? 128;
        params.edge = (args.edge as string) ?? 'lower';
      } else if (mode === 'tiles') {
        params.number = (args.number as number) ?? 10;
        params.offset = (args.offset as number) ?? 10;
      }
      // find_edges / solarize: parameterless.
      return params;
    },
    successText: (result, args) => {
      const r = result as { target_was_copy?: boolean; target_layer_name?: string };
      const target = r.target_was_copy
        ? `new copy "${r.target_layer_name ?? '?'}"`
        : 'active layer (in place)';
      return `Stylize (${args.mode as string}) applied to ${target}.`;
    },
  });
}

async function applyRender(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: renderSchema,
    snippet: 'applyRender',
    errorPrefix: 'Error applying Render',
    params: (args) => {
      const mode = args.mode as string;
      const applyToActiveLayer = (args.apply_to_active_layer as boolean) ?? false;

      const params: Record<string, unknown> = { mode, applyToActiveLayer };
      if (mode === 'fibers') {
        params.variance = (args.variance as number) ?? 16;
        params.strength = (args.fiber_strength as number) ?? 4;
        params.seed = (args.seed as number) ?? 12345;
      }
      // clouds / difference_clouds: parameterless (use FG/BG colors).
      return params;
    },
    successText: (result, args) => {
      const r = result as { target_was_copy?: boolean; target_layer_name?: string };
      const target = r.target_was_copy
        ? `new copy "${r.target_layer_name ?? '?'}"`
        : 'active layer (in place)';
      return `Render (${args.mode as string}) applied to ${target}.`;
    },
  });
}

async function applyOther(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: otherSchema,
    snippet: 'applyOther',
    errorPrefix: 'Error applying filter',
    params: (args) => {
      const mode = args.mode as string;
      const applyToActiveLayer = (args.apply_to_active_layer as boolean) ?? false;

      const params: Record<string, unknown> = { mode, applyToActiveLayer };
      if (mode === 'maximum' || mode === 'minimum') {
        params.radius = (args.radius as number) ?? 3;
        params.preserve = (args.preserve as string) ?? 'roundness';
      } else if (mode === 'offset') {
        params.horizontal = (args.horizontal as number) ?? 0;
        params.vertical = (args.vertical as number) ?? 0;
      }
      return params;
    },
    successText: (result, args) => {
      const r = result as { target_was_copy?: boolean; target_layer_name?: string };
      const target = r.target_was_copy
        ? `new copy "${r.target_layer_name ?? '?'}"`
        : 'active layer (in place)';
      return `Other filter (${args.mode as string}) applied to ${target}.`;
    },
  });
}

async function applyDenoise(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: denoiseSchema,
    snippet: 'applyDenoise',
    errorPrefix: 'Error applying noise reduction',
    params: (args) => {
      const mode = args.mode as string;
      const applyToActiveLayer = (args.apply_to_active_layer as boolean) ?? false;

      const params: Record<string, unknown> = { mode, applyToActiveLayer };
      if (mode === 'median') {
        params.radius = (args.radius as number) ?? 4;
      } else if (mode === 'dust_and_scratches') {
        params.radius = (args.radius as number) ?? 3;
        params.threshold = (args.threshold as number) ?? 10;
      }
      // despeckle: parameterless.
      return params;
    },
    successText: (result, args) => {
      const r = result as { target_was_copy?: boolean; target_layer_name?: string };
      const target = r.target_was_copy
        ? `new copy "${r.target_layer_name ?? '?'}"`
        : 'active layer (in place)';
      return `Noise reduction (${args.mode as string}) applied to ${target}.`;
    },
  });
}

async function applyBlurAdv(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: blurAdvSchema,
    snippet: 'applyBlurAdv',
    errorPrefix: 'Error applying blur',
    params: (args) => {
      const mode = args.mode as string;
      const applyToActiveLayer = (args.apply_to_active_layer as boolean) ?? false;

      const params: Record<string, unknown> = { mode, applyToActiveLayer };
      if (mode === 'surface_blur') {
        params.radius = (args.radius as number) ?? 15;
        params.threshold = (args.threshold as number) ?? 20;
      } else if (mode === 'box_blur') {
        params.radius = (args.radius as number) ?? 12;
      }
      // average: parameterless.
      return params;
    },
    successText: (result, args) => {
      const r = result as { target_was_copy?: boolean; target_layer_name?: string };
      const target = r.target_was_copy
        ? `new copy "${r.target_layer_name ?? '?'}"`
        : 'active layer (in place)';
      return `Blur (${args.mode as string}) applied to ${target}.`;
    },
  });
}

async function applyOilPaint(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: oilPaintSchema,
    snippet: 'applyOilPaint',
    errorPrefix: 'Error applying Oil Paint',
    params: (args) => ({
      stylization: (args.stylization as number) ?? 4,
      cleanliness: (args.cleanliness as number) ?? 2.3,
      brushScale: (args.brush_scale as number) ?? 0.8,
      bristleDetail: (args.bristle_detail as number) ?? 10,
      lightDirection: (args.light_direction as number) ?? -60,
      shine: (args.shine as number) ?? 1.3,
      lightingOn: (args.lighting_on as boolean) ?? true,
      applyToActiveLayer: (args.apply_to_active_layer as boolean) ?? false,
    }),
    successText: (result) => {
      const r = result as { target_was_copy?: boolean; target_layer_name?: string };
      const target = r.target_was_copy
        ? `new copy "${r.target_layer_name ?? '?'}"`
        : 'active layer (in place)';
      return `Oil Paint applied to ${target}.`;
    },
  });
}

async function applyDisplace(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: displaceSchema,
    snippet: 'applyDisplace',
    errorPrefix: 'Error applying Displace',
    params: (args) => ({
      mapPath: args.map_path as string,
      horizontalScale: (args.horizontal_scale as number) ?? 10,
      verticalScale: (args.vertical_scale as number) ?? 10,
      displacementMap: (args.displacement_map as string) ?? 'stretch_to_fit',
      undefinedAreas: (args.undefined_areas as string) ?? 'repeat_edge',
      applyToActiveLayer: (args.apply_to_active_layer as boolean) ?? false,
    }),
    successText: (result, args) => {
      const r = result as { target_was_copy?: boolean; target_layer_name?: string };
      const target = r.target_was_copy
        ? `new copy "${r.target_layer_name ?? '?'}"`
        : 'active layer (in place)';
      return `Displace applied to ${target} using map ${args.map_path as string}.`;
    },
  });
}
