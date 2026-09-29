import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import type { GimpBackend } from '../backends/gimp/backend.js';
import { validateArgs, type JsonSchemaObject } from '../utils/validate.js';
import { toolGimpErrorResult } from '../utils/tool-helpers.js';
import {
  GIMP_IMAGE_PROP,
  GIMP_LAYER_ID_PROP,
  GIMP_LAYER_PROP,
  pickSchemaDeclaredKeys,
} from './gimp-shared.js';

/**
 * gimp_add_adjustment — the single discriminated non-destructive adjustment
 * tool (altitude rule: one verb "append/update a filter", one object, one
 * output shape, one safety class). `type` picks the GEGL/GIMP operation
 * (`bridge/lib.py`'s `ADJUST_OPERATIONS`); curves/levels keep their own
 * richer shapes (a points list; per-side 0-255 levels) but dispatch through
 * the SAME bridge op (`adjust` — `bridge/ops.py`'s `op_adjust` routes
 * internally by `type`).
 *
 * ## Why most numeric fields below have NO schema `default`
 *
 * A re-edit (`filter_id` given) MERGES: the bridge keeps every field the
 * caller doesn't mention at the EXISTING filter's own value, not the
 * type's creation default (`op_adjust`'s docstring; `resolve_field` in
 * `bridge/lib.py`). If this schema declared a numeric `default` for, say,
 * `exposure`, `validateArgs` would silently inject that value into every
 * re-edit call that omits it — indistinguishable, bridge-side, from the
 * caller explicitly asking to RESET exposure to 0. That would defeat the
 * merge-not-reset behavior a re-edit depends on. So per-type numeric
 * fields intentionally omit `default:` here (the create-time default is
 * documented in each field's own description instead) — the one deliberate
 * exception to the "always declare default" convention in `docs/engineering/tool-design.md`,
 * because the convention's own premise (an omitted field always resolves to
 * ONE fixed value) is false for this tool.
 *
 * ## Field-name collisions across `type`s (a real bridge-side fact, not a
 * schema bug): `bridge/lib.py`'s builders read a few identically-NAMED
 * fields with different bounds depending on `type` — `range` (hue_saturation
 * uses the hue-range enum; color_balance uses the shadows/midtones/
 * highlights enum), `saturation` (hue_saturation: -100..100 percent;
 * vibrance: 0..10 scale), and `radius` (shadows_highlights: 0.1..1500;
 * sharpen, where it maps to `std-dev`, and gaussian_blur, where it maps to
 * `std-dev-x`/`std-dev-y`: 0..1500). A flat JSON Schema can only
 * declare ONE bound per property name, so each of these three is widened to
 * the UNION of its per-type bounds here — the bridge still enforces the
 * PRECISE per-type bound and reports an `invalid_argument` naming it when a
 * value is in the union but out of range for the `type` actually given.
 */

const ADJUST_TYPES = [
  'curves',
  'levels',
  'exposure',
  'brightness_contrast',
  'hue_saturation',
  'color_balance',
  'color_temperature',
  'shadows_highlights',
  'saturation',
  'vibrance',
  'sharpen',
  'noise_reduction',
  'gaussian_blur',
] as const;

/** No `default` here for the re-edit-merge reason in the file doc comment above. */
const curvesLevelsChannelProp = {
  type: 'string' as const,
  enum: ['value', 'red', 'green', 'blue'],
  description:
    "curves/levels only. 'value' adjusts all channels together (tone); red/green/blue adjusts " +
    'ONE channel (color) — a filter carries only one channel, so shifting color needs separate ' +
    'filters for red and blue. Default (when creating): value. Omitted on a re-edit keeps the ' +
    "existing filter's own channel.",
};

const adjustSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    image: GIMP_IMAGE_PROP,
    layer: {
      ...GIMP_LAYER_PROP,
      description:
        GIMP_LAYER_PROP.description +
        ' The filter applies to that ONE layer, not to the flattened image, so on a multi-layer ' +
        'document name the layer you mean. A layer inside a layer group can be named directly.',
    },
    layer_id: GIMP_LAYER_ID_PROP,
    type: {
      type: 'string',
      enum: [...ADJUST_TYPES],
      description:
        'Which adjustment to apply/re-edit. Each type maps to exactly one GEGL/GIMP operation; ' +
        'see the per-field descriptions below for which fields apply to which type.',
    },
    filter_id: {
      type: 'integer',
      description:
        "Re-edit this existing filter IN PLACE instead of adding a new one (must match `type`'s " +
        'operation). Any per-type field you omit keeps the value it already had — this is a ' +
        'MERGE, not a reset. The values gimp_filter op=list reports for it are in these same ' +
        'field names and units, so they can be passed straight back. The mask is fixed at ' +
        'creation and cannot change on a re-edit. Only filters Editmamei created can be re-edited ' +
        '(gimp_filter op=list shows source: "editmamei"); re-editing any other filter (for example ' +
        'one added in the GIMP GUI) is refused, because its current values cannot be read back ' +
        'exactly — delete it and re-create it instead. A re-edit keeps the filter on its own ' +
        'layer; `layer` and `layer_id` are ignored.',
    },
    mask: {
      type: 'string',
      description:
        'Name of a mask channel from gimp_create_mask, confining a NEW filter to it. Only valid ' +
        "when creating (no filter_id) — a filter's mask is fixed at creation. ORDER MATTERS: " +
        'straighten / flip / resize the canvas first (gimp_transform_canvas, gimp_resize_image), ' +
        'then crop, THEN add masked adjustments — rotate, flip, and resize all refuse outright ' +
        'once any masked adjustment filter exists on the image, or any filter not created by ' +
        'Editmamei (for example one added in the GIMP GUI), since they cannot keep a mask aligned ' +
        'through those transforms. Cropping afterward is always safe.',
    },
    name: {
      type: 'string',
      description: 'Label for a new filter, e.g. "Lift shadows". Made unique automatically.',
    },
    // ---- curves ----
    channel: curvesLevelsChannelProp,
    points: {
      type: 'array',
      minItems: 2,
      description:
        'curves only. [input, output] pairs, 0-255 each, ascending input — include the endpoints, ' +
        'e.g. [[0,0],[64,90],[255,255]] lifts shadows. Required when creating (no filter_id); ' +
        'omitted on a re-edit keeps the existing curve.',
      items: {
        type: 'array',
        items: { type: 'number', minimum: 0, maximum: 255 },
        minItems: 2,
        maxItems: 2,
      },
    },
    // ---- levels ----
    in_low: {
      type: 'number',
      minimum: 0,
      maximum: 255,
      description:
        'levels only. Input black point; must stay below in_high (an empty or inverted input ' +
        'range is refused). Default (when creating): 0.',
    },
    in_high: {
      type: 'number',
      minimum: 0,
      maximum: 255,
      description:
        'levels only. Input white point; must stay above in_low. Default (when creating): 255.',
    },
    gamma: {
      type: 'number',
      minimum: 0.1,
      maximum: 10,
      description:
        'levels only. Midtone gamma, 0.1..10 — >1 brightens midtones, <1 darkens. Default (when ' +
        'creating): 1.0.',
    },
    out_low: {
      type: 'number',
      minimum: 0,
      maximum: 255,
      description: 'levels only. Output black. Default (when creating): 0.',
    },
    out_high: {
      type: 'number',
      minimum: 0,
      maximum: 255,
      description: 'levels only. Output white. Default (when creating): 255.',
    },
    // ---- exposure ----
    exposure: {
      type: 'number',
      minimum: -10,
      maximum: 10,
      description: 'exposure only. Stops. Default (when creating): 0.',
    },
    black_level: {
      type: 'number',
      minimum: -0.1,
      maximum: 0.1,
      description: 'exposure only. Shadow black-point shift. Default (when creating): 0.0.',
    },
    // ---- brightness_contrast ----
    brightness: {
      type: 'number',
      minimum: -100,
      maximum: 100,
      description: 'brightness_contrast only. Default (when creating): 0.',
    },
    contrast: {
      type: 'number',
      minimum: -100,
      maximum: 100,
      description: 'brightness_contrast only. Default (when creating): 0.',
    },
    // ---- hue_saturation / color_balance (both use `range`; see file doc comment) ----
    range: {
      type: 'string',
      enum: [
        'all',
        'red',
        'yellow',
        'green',
        'cyan',
        'blue',
        'magenta',
        'shadows',
        'midtones',
        'highlights',
      ],
      description:
        "hue_saturation: one of all/red/yellow/green/cyan/blue/magenta (default 'all'). " +
        "color_balance: one of shadows/midtones/highlights (default 'midtones'). ONE range per " +
        'filter: adjusting reds and blues, or shadows and highlights, takes one filter per range ' +
        "(the same rule as one curves filter per channel). Passing a value from the other type's " +
        'set is rejected by the bridge naming the real allowed set for the `type` you gave.',
    },
    hue: {
      type: 'number',
      minimum: -180,
      maximum: 180,
      description: 'hue_saturation only. Degrees. Default (when creating): 0.',
    },
    saturation: {
      type: 'number',
      minimum: -100,
      maximum: 100,
      description:
        'hue_saturation: -100..100 percent (default 0 when creating), the field that actually ' +
        'adjusts saturation for that type. vibrance: a SEPARATE, plain saturation multiplier ' +
        'layered on top of the vibrance field below — 1.0 = unchanged (default when creating), ' +
        '0..10 scale. It is NOT the vibrance knob; normally leave it alone and use `vibrance` ' +
        'instead. The bridge enforces the precise range for whichever `type` you gave.',
    },
    lightness: {
      type: 'number',
      minimum: -100,
      maximum: 100,
      description: 'hue_saturation only. Default (when creating): 0.',
    },
    // ---- color_balance ----
    cyan_red: {
      type: 'number',
      minimum: -100,
      maximum: 100,
      description: 'color_balance only. Default (when creating): 0.',
    },
    magenta_green: {
      type: 'number',
      minimum: -100,
      maximum: 100,
      description: 'color_balance only. Default (when creating): 0.',
    },
    yellow_blue: {
      type: 'number',
      minimum: -100,
      maximum: 100,
      description: 'color_balance only. Default (when creating): 0.',
    },
    preserve_luminosity: {
      type: 'boolean',
      description: 'color_balance only. Default (when creating): true.',
    },
    // ---- color_temperature ----
    from_kelvin: {
      type: 'number',
      minimum: 1000,
      maximum: 12000,
      description:
        'color_temperature only. The temperature the photo currently looks shot under. Default ' +
        '(when creating): 6500.',
    },
    to_kelvin: {
      type: 'number',
      minimum: 1000,
      maximum: 12000,
      description:
        'color_temperature only. The corrected target temperature. COUNTER-INTUITIVE DIRECTION: ' +
        'RAISING to_kelvin WARMS the image (it means "render as if shot under this light" — a ' +
        'higher assumed light temperature reads as a warmer correction). Example: from_kelvin 6500, ' +
        'to_kelvin 8000 renders WARMER, not cooler. Default (when creating): 6500.',
    },
    // ---- shadows_highlights ----
    shadows: {
      type: 'number',
      minimum: -100,
      maximum: 100,
      description: 'shadows_highlights only. Default (when creating): 0.',
    },
    highlights: {
      type: 'number',
      minimum: -100,
      maximum: 100,
      description: 'shadows_highlights only. Default (when creating): 0.',
    },
    whitepoint: {
      type: 'number',
      minimum: -10,
      maximum: 10,
      description:
        'shadows_highlights only. Shifts the white point: positive brightens the top end, ' +
        'negative pulls it down. Default (when creating): 0.',
    },
    radius: {
      type: 'number',
      minimum: 0,
      maximum: 1500,
      description:
        'shadows_highlights: spatial falloff radius, 0.1..1500 (default 100 when creating). ' +
        'sharpen: unsharp-mask std-dev, 0..1500 (default 3.0 when creating). gaussian_blur: blur ' +
        'radius (std-dev) in pixels at full resolution, 0..1500 (default 1.5 when creating). All ' +
        'three are SPATIAL (radius-scaled on the proxy preview, see gimp_overview).',
    },
    compress: {
      type: 'number',
      minimum: 0,
      maximum: 100,
      description:
        'shadows_highlights only. How far the shadows/highlights effect reaches toward the ' +
        'midtones: higher confines it to the darkest and brightest tones. Default (when creating): 50.',
    },
    shadows_ccorrect: {
      type: 'number',
      minimum: 0,
      maximum: 100,
      description:
        'shadows_highlights only. Colour saturation kept in the lifted shadows (0 = none, 100 = ' +
        'full). Default (when creating): 100.',
    },
    highlights_ccorrect: {
      type: 'number',
      minimum: 0,
      maximum: 100,
      description:
        'shadows_highlights only. Colour saturation kept in the recovered highlights (0 = none, ' +
        '100 = full). Default (when creating): 50.',
    },
    // ---- saturation (type) ----
    scale: {
      type: 'number',
      minimum: 0,
      maximum: 10,
      description: 'saturation only. 1.0 = unchanged. Default (when creating): 1.0.',
    },
    // ---- vibrance (type) ----
    vibrance: {
      type: 'number',
      minimum: -100,
      maximum: 100,
      description:
        'vibrance only. THE vibrance control — a vibrance adjustment must set this field, not ' +
        '`saturation` (a separate, plain multiplier for this type that normally stays at its ' +
        'default). Positive values boost muted/less-saturated colours more than already-saturated ' +
        'ones (skin tones move less than a bright sky); negative desaturates the same way in ' +
        'reverse. Default (when creating): 0.',
    },
    // ---- sharpen ----
    amount: {
      type: 'number',
      minimum: 0,
      maximum: 300,
      description:
        "sharpen only. GEGL's unsharp-mask strength MULTIPLIER, not a percent: 0.5 is the " +
        'default, 1.0 is strong, and values above ~3 are extreme. Default (when creating): 0.5.',
    },
    threshold: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: 'sharpen only. Default (when creating): 0.',
    },
    // ---- noise_reduction ----
    strength: {
      type: 'integer',
      minimum: 1,
      maximum: 32,
      description: 'noise_reduction only. Neighbourhood size. Default (when creating): 4.',
    },
  },
  required: ['image', 'type'],
};

async function gimpAddAdjustment(
  gimp: GimpBackend,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(adjustSchema, rawArgs);
    const result = await gimp.call<{
      filter_id: number;
      name: string;
      type: string;
      mask: string | null;
    }>('adjust', pickSchemaDeclaredKeys(adjustSchema, args));
    // A NEW vibrance filter with no `vibrance` given is the mistake this
    // tool's own schema wording tries to head off (see the `vibrance` field
    // doc comment) — `saturation` alone does nothing to it. Flagged in the
    // text rather than silently accepted, without touching the merge-not-
    // reset contract (nothing here changes what's sent to the bridge).
    const isNewVibranceWithNoVibrance =
      rawArgs.filter_id === undefined &&
      rawArgs.type === 'vibrance' &&
      rawArgs.vibrance === undefined;
    return {
      content: [
        {
          type: 'text' as const,
          text:
            `${result.filter_id !== undefined && rawArgs.filter_id !== undefined ? 'Updated' : 'Added'} ` +
            `${result.type} filter "${result.name}" (id ${result.filter_id})` +
            (result.mask ? ` confined to mask "${result.mask}".` : '.') +
            (isNewVibranceWithNoVibrance
              ? ' vibrance defaulted to 0 — only saturation changed; set `vibrance` to actually boost muted colours.'
              : ''),
        },
      ],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  } catch (error) {
    return toolGimpErrorResult('Error applying GIMP adjustment', error);
  }
}

export function createGimpAdjustmentTools(gimp: GimpBackend): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'gimp_add_adjustment',
        description:
          'Headless GIMP: append (or, with filter_id, re-edit in place) a NON-DESTRUCTIVE ' +
          'adjustment filter — stays live and re-editable; nothing bakes into pixels until ' +
          'gimp_export, and gimp_filter op=delete removes it again. `type` picks the adjustment: ' +
          'curves, levels, exposure, brightness_contrast, hue_saturation, color_balance, ' +
          'color_temperature, shadows_highlights, saturation, vibrance, sharpen, noise_reduction, ' +
          "gaussian_blur. A field another type uses is refused, naming this type's own fields. A " +
          'filter applies to ONE layer (`layer_id` or `layer`, else the selected or top layer), ' +
          'not to the flattened image — on a multi-layer document, say which layer. For type ' +
          'vibrance, the knob is the `vibrance` field — `saturation` on that type is a separate ' +
          'plain multiplier that normally stays untouched. curves: ONE filter per channel — add ' +
          'separate filters for red and blue rather than one filter for both; points are [input, ' +
          'output] 0-255 pairs including the endpoints. hue_saturation and color_balance likewise ' +
          'carry ONE `range` per filter. gaussian_blur: radius in pixels at full resolution; ' +
          'combine with a mask from gimp_create_mask for soft-focus or background-blur effects. A ' +
          "re-edit (filter_id) MERGES: any field you omit keeps the filter's existing value, so " +
          "re-editing {contrast: 50} on a brightness_contrast filter doesn't reset brightness. Only " +
          'filters Editmamei created can be re-edited; one added in the GIMP GUI is refused (delete ' +
          'and re-create it). `mask` (a channel name from gimp_create_mask) confines a NEW filter ' +
          '— fixed at creation, cannot change on a re-edit. ORDER MATTERS: straighten / flip / ' +
          'resize the canvas first, then crop, THEN add any masked adjustment — rotate, flip, and ' +
          'resize all refuse outright once a masked adjustment filter exists, or any filter not ' +
          'created by Editmamei (for example one added in the GIMP GUI). ' +
          "color_temperature's direction is " +
          'counter-intuitive: raising to_kelvin WARMS the image. Check the stack afterward with ' +
          'gimp_filter (op=list).',
        inputSchema: adjustSchema,
        outputSchema: {
          type: 'object',
          properties: {
            filter_id: { type: 'number' },
            name: { type: 'string' },
            type: { type: 'string' },
            mask: { type: ['string', 'null'] },
          },
        },
        annotations: {
          title: 'Add/Update GIMP Adjustment',
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      handler: async (args) => gimpAddAdjustment(gimp, args),
    },
  ];
}

/** Exported for the schema-bounds drift test — see tests/tools/gimp-adjustment-tools.test.ts. */
export const ADJUST_SCHEMA_FOR_TESTS = adjustSchema;
