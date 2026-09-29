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
 * gimp_add_effect — the sibling of gimp_add_adjustment for a small allow-listed set of GEGL
 * EFFECT filters (vignette, black_white, motion_blur, lens_blur, add_noise, drop_shadow), rather
 * than a new op on gimp_filter: tier 'dev' (`tool-tiers.ts` classifies per TOOL, not per op, so
 * an `apply` op grafted onto gimp_filter, already 'community', would ship live immediately with
 * no dev-tier gate at all). `type` picks the GEGL operation (`bridge/lib.py`'s
 * `EFFECT_OPERATIONS`), the same discriminated-tool shape gimp_add_adjustment uses for its own
 * `type`. Dispatches through the bridge's `effect` op (`bridge/ops.py`'s `op_effect`), which
 * reuses the SAME `_apply_filter` machinery `op_adjust` does — ledger, mask confinement,
 * merge-on-re-edit, geometry refusals, and proxy mirroring all come free, unchanged.
 * `gimp_filter` (list / set_visibility / delete) manages the resulting stack exactly as it does
 * for gimp_add_adjustment's own filters.
 *
 * ## Why most numeric fields below have NO schema `default`
 *
 * A re-edit (`filter_id` given) MERGES: the bridge keeps every field the caller doesn't mention
 * at the EXISTING filter's own value, not the type's creation default (`op_effect`'s docstring;
 * `resolve_field` in `bridge/lib.py`) — the exact same contract gimp_add_adjustment documents for
 * its own fields, and for the exact same reason.
 *
 * ## Field-name collisions across `type`s (a real bridge-side fact, not a schema bug, the same
 * situation gimp_add_adjustment documents for its own fields): `radius` is used by vignette
 * (0..3, proportional — see the `radius` field's own description), lens_blur (0..150 px,
 * full-resolution — a much lower cap than the other two, measured live: 'lens' mode blur is
 * expensive, ~35s for a full-res 24 MP export at radius 300) and drop_shadow (0..1500 px). A
 * flat JSON Schema can only declare ONE bound per property name, so it is widened here to the
 * UNION (0..1500) — the bridge still enforces the PRECISE per-effect bound and reports
 * `invalid_argument` naming it when a value is in the union but out of range for the `type`
 * actually given.
 *
 * `color` (vignette's tint, drop_shadow's shadow color) is NOT exposed as a schema field —
 * left at GEGL's own default (black) — the same posture as the unexposed `shape` fields below.
 */

const EFFECT_TYPES = [
  'vignette',
  'black_white',
  'motion_blur',
  'lens_blur',
  'add_noise',
  'drop_shadow',
] as const;

const effectSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    image: GIMP_IMAGE_PROP,
    type: {
      type: 'string',
      enum: [...EFFECT_TYPES],
      description:
        'Which effect to create/re-edit — see the per-field descriptions below for which ' +
        'fields apply to which effect.',
    },
    filter_id: {
      type: 'integer',
      description:
        "Re-edit this existing filter IN PLACE instead of adding a new one (must match `type`'s " +
        'operation). Any per-effect field you omit keeps the value it already had — this is a ' +
        'MERGE, not a reset. The values gimp_filter op=list reports for it are in these same ' +
        'field names and units, so they can be passed straight back. The mask is fixed at ' +
        'creation and cannot change on a re-edit. Only filters Editmamei created can be ' +
        're-edited (gimp_filter op=list shows source: "editmamei"); re-editing any other filter ' +
        '(for example one added in the GIMP GUI) is refused, because its current values cannot ' +
        'be read back exactly — delete it and re-create it instead.',
    },
    layer: {
      ...GIMP_LAYER_PROP,
      description:
        GIMP_LAYER_PROP.description +
        ' The filter applies to that ONE layer, not to the flattened image, so on a ' +
        'multi-layer document name the layer you mean. A layer inside a layer group can be ' +
        'named directly.',
    },
    layer_id: GIMP_LAYER_ID_PROP,
    mask: {
      type: 'string',
      description:
        'Name of a mask channel from gimp_create_mask, confining a NEW filter to it. Only valid ' +
        "when creating (no filter_id) — a filter's mask is fixed at creation. ORDER MATTERS: " +
        'straighten / flip / resize the canvas first (gimp_transform_canvas, gimp_resize_image), ' +
        'then crop, THEN add masked effects — rotate, flip, and resize all refuse outright once ' +
        'any masked filter exists on the image, or any filter not created by Editmamei, since ' +
        'they cannot keep a mask aligned through those transforms. Cropping afterward is always ' +
        'safe.',
    },
    name: {
      type: 'string',
      description: 'Label for a new filter, e.g. "Corner darken". Made unique automatically.',
    },
    // ---- vignette ----
    radius: {
      type: 'number',
      minimum: 0,
      maximum: 1500,
      description:
        'vignette: how far the darkened corners reach in, 0..3, relative to the LAYER (not ' +
        'absolute pixels — the same value looks visually equivalent at any resolution, and ' +
        'consistent with center_x/center_y below). Default ' +
        '(when creating): 1.2. lens_blur: blur radius in pixels at full resolution, 0..150 ' +
        '(default 25 when creating) — capped much lower than the other two effects here (measured ' +
        'live: expensive at full resolution). drop_shadow: blur radius in pixels at full ' +
        'resolution, 0..1500 (default 10 when creating), clipped to the layer bounds rather than ' +
        'growing it. Both lens_blur and drop_shadow are SPATIAL (radius-scaled on the proxy ' +
        'preview, see gimp_overview). The bridge enforces the precise range for whichever ' +
        '`type` you gave.',
    },
    softness: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description:
        'vignette only. How gradual the falloff is; 0 is a hard edge. Default (when creating): 0.8.',
    },
    gamma: {
      type: 'number',
      minimum: 0.1,
      maximum: 10,
      description: 'vignette only. Falloff curve shape. Default (when creating): 2.0.',
    },
    center_x: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description:
        "vignette only. Vignette center, as a fraction of the LAYER's own width (not the whole " +
        'canvas — 0 = left edge, 1 = right edge). Default (when creating): 0.5. Cropping ' +
        're-centres the vignette on the new, smaller frame (the same fraction now means a ' +
        'different point) — the intended behaviour, like a post-crop vignette in Lightroom, not ' +
        'something to correct for.',
    },
    center_y: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description:
        "vignette only. Vignette center, as a fraction of the LAYER's own height (not the whole " +
        'canvas — 0 = top edge, 1 = bottom edge). Default (when creating): 0.5. The vignette ' +
        'color is black and not configurable yet.',
    },
    // ---- black_white ----
    red_weight: {
      type: 'number',
      minimum: -5,
      maximum: 5,
      description:
        'black_white only. How much the red channel contributes to the resulting gray. Default ' +
        '(when creating): 0.333.',
    },
    green_weight: {
      type: 'number',
      minimum: -5,
      maximum: 5,
      description: 'black_white only. Default (when creating): 0.333.',
    },
    blue_weight: {
      type: 'number',
      minimum: -5,
      maximum: 5,
      description: 'black_white only. Default (when creating): 0.333.',
    },
    preserve_luminosity: {
      type: 'boolean',
      description: 'black_white only. Default (when creating): false.',
    },
    // ---- motion_blur ----
    length: {
      type: 'number',
      minimum: 0,
      maximum: 1000,
      description:
        'motion_blur only. Blur length in pixels at full resolution, 0..1000. Default (when ' +
        'creating): 10. SPATIAL (scaled on the proxy preview, see gimp_overview).',
    },
    angle: {
      type: 'number',
      minimum: -180,
      maximum: 180,
      description:
        'motion_blur only. Direction of the streak, in degrees: 0 is horizontal, positive angles ' +
        'rotate clockwise (90 is vertical). Default (when creating): 0.',
    },
    // ---- lens_blur ----
    highlight_factor: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description:
        'lens_blur only. Boosts bright out-of-focus highlights (bokeh) above this threshold. ' +
        'Default (when creating): 0 (no boost). lens_blur applies uniformly across the whole ' +
        'layer (a soft-focus effect), not a depth-of-field falloff — mask it (see `mask`) to ' +
        'confine it to part of the image instead.',
    },
    // ---- add_noise ----
    noise_amount: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description:
        'add_noise only. THE amount control — sets red/green/blue uniformly (grayscale-leaning ' +
        'noise, not a color-tinted one). Default (when creating): 0.2.',
    },
    alpha: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description:
        'add_noise only. Noise added to the alpha channel too. Default (when creating): 0.',
    },
    seed: {
      type: 'integer',
      minimum: 0,
      maximum: 4294967295,
      description:
        'add_noise only. RNG seed — the same seed reproduces the identical noise pattern (useful ' +
        'for an exact re-edit round trip). Default (when creating): 0.',
    },
    // ---- drop_shadow ----
    offset_x: {
      type: 'number',
      minimum: -500,
      maximum: 500,
      description:
        'drop_shadow only. Horizontal shadow offset in pixels at full resolution. Default (when ' +
        'creating): 20. SPATIAL (scaled on the proxy preview, see gimp_overview). Only meaningful ' +
        'on a layer with an alpha channel — a shadow is cast from what is transparent around the ' +
        'opaque content.',
    },
    offset_y: {
      type: 'number',
      minimum: -500,
      maximum: 500,
      description:
        'drop_shadow only. Vertical shadow offset in pixels at full resolution. Default (when ' +
        'creating): 20. SPATIAL (scaled on the proxy preview, see gimp_overview).',
    },
    opacity: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description:
        'drop_shadow only. Default (when creating): 0.5. The shadow color is black and not ' +
        'configurable yet.',
    },
  },
  required: ['image', 'type'],
};

async function gimpAddEffect(
  gimp: GimpBackend,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(effectSchema, rawArgs);
    const result = await gimp.call<{
      filter_id: number;
      name: string;
      type: string;
      mask: string | null;
    }>('effect', pickSchemaDeclaredKeys(effectSchema, args));
    return {
      content: [
        {
          type: 'text' as const,
          text:
            `${rawArgs.filter_id !== undefined ? 'Updated' : 'Added'} ` +
            `${result.type} filter "${result.name}" (id ${result.filter_id})` +
            (result.mask ? ` confined to mask "${result.mask}".` : '.'),
        },
      ],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  } catch (error) {
    return toolGimpErrorResult('Error applying GIMP effect filter', error);
  }
}

export function createGimpEffectTools(gimp: GimpBackend): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'gimp_add_effect',
        description:
          'Headless GIMP: append (or, with filter_id, re-edit in place) one of a small ' +
          'allow-listed set of GEGL effect filters — vignette, black_white, motion_blur, ' +
          'lens_blur, add_noise, drop_shadow — the same non-destructive, re-editable, maskable ' +
          "filter mechanism gimp_add_adjustment uses, sharing the SAME stack: gimp_filter's " +
          "op=list/set_visibility/delete manage this tool's filters exactly as it manages " +
          "gimp_add_adjustment's. `type` picks the effect; a field another effect uses is " +
          "refused, naming this type's own fields. A filter applies to ONE layer (`layer_id` " +
          'or `layer`, else the selected or top layer), not to the flattened image. A re-edit ' +
          "(filter_id) MERGES: any field you omit keeps the filter's existing value. Only " +
          'filters Editmamei created can be re-edited; one added in the GIMP GUI is refused ' +
          '(delete and re-create it). `mask` (a channel name from gimp_create_mask) confines a ' +
          'NEW filter — fixed at creation, cannot change on a re-edit. ORDER MATTERS: straighten ' +
          '/ flip / resize the canvas first, then crop, THEN add any masked effect — rotate, ' +
          'flip, and resize all refuse outright once a masked filter exists, or any filter not ' +
          'created by Editmamei. vignette, motion_blur, and drop_shadow stay locked to the ' +
          'content through flip, resize, and an exact 90/180/270-degree rotate (their center/' +
          'angle/offset fields are updated automatically, and gimp_filter op=list reflects the ' +
          'new values afterward) — rotating by any OTHER angle is refused while one of these ' +
          'three is present, rather than letting it drift out of alignment. lens_blur is a ' +
          'uniform soft-focus blur, not a depth-of-field falloff. For a plain blur with no bokeh ' +
          'highlight boost, use gimp_add_adjustment type=gaussian_blur instead. Check the stack ' +
          'afterward with gimp_filter (op=list).',
        inputSchema: effectSchema,
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
          title: 'Add/Update GIMP Effect Filter',
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      handler: async (args) => gimpAddEffect(gimp, args),
    },
  ];
}

/** Exported for the schema-bounds drift test — see tests/tools/gimp-effect-tools.test.ts. */
export const EFFECT_SCHEMA_FOR_TESTS = effectSchema;
