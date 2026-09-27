import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import type { GimpBackend } from '../backends/gimp/backend.js';
import { validateArgs, type JsonSchemaObject } from '../utils/validate.js';
import { toolGimpErrorResult, unknownDiscriminator } from '../utils/tool-helpers.js';
import { GIMP_IMAGE_PROP, GIMP_LAYER_PROP, pickSchemaDeclaredKeys } from './gimp-shared.js';

/**
 * gimp_filter — the GIMP twin of ps_filter's stack-management ops, PLUS (as of `apply`) a small
 * allow-listed set of GEGL effect filters: creating or re-editing one of these is now this tool's
 * job too, not just gimp_add_adjustment's. Deliberately NO `reorder`: `Gimp.DrawableFilter`
 * exposes only delete/set_visible/update and the PDB has no raise/lower-filter procedure
 * (verified live, GIMP 3.2.6). Emulating reorder would mean deleting and re-appending every
 * filter above the moved one, changing their ids and losing any mask a filter this bridge didn't
 * create was confined to.
 *
 * `apply` reuses gimp_add_adjustment's own conventions rather than inventing new ones: `filter_id`
 * re-edits IN PLACE and MERGES (an omitted field keeps its existing value, never resets to the
 * effect's creation default — `bridge/lib.py`'s `resolve_field`); `mask` (a channel name from
 * gimp_create_mask) confines a NEW filter and is fixed at creation; per-type numeric fields
 * intentionally have NO schema `default` for the same reason gimp_add_adjustment's don't — see
 * that file's own doc comment for why declaring one would defeat the merge.
 *
 * Field-name collisions across effects (a real bridge-side fact, not a schema bug, the same
 * situation gimp_add_adjustment documents for its own fields): `radius` is used by vignette
 * (0..3, a fraction of the image's own half-diagonal, scale-invariant), lens_blur (0..1500 px,
 * full-resolution) and drop_shadow (0..1500 px). A flat JSON Schema can only declare ONE bound
 * per property name, so it is widened here to the UNION (0..1500) — the bridge still enforces
 * the PRECISE per-effect bound and reports `invalid_argument` naming it when a value is in the
 * union but out of range for the `filter` actually given.
 */

const FILTER_EFFECTS = [
  'vignette',
  'black_white',
  'motion_blur',
  'lens_blur',
  'add_noise',
  'drop_shadow',
] as const;

const filterSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    image: GIMP_IMAGE_PROP,
    op: {
      type: 'string',
      enum: ['list', 'set_visibility', 'delete', 'apply'],
      description:
        "'list' returns every filter on the image (including filters on layers inside groups), " +
        'top of stack first, with id/name/operation/visible/mask/source and params. source ' +
        '"editmamei" = exact ledger record, with params in gimp_add_adjustment\'s own field names ' +
        'and units, so they can be passed straight back on a re-edit. source "readback" = a filter ' +
        "Editmamei did not create; its params are GIMP's raw GEGL property names and units (not " +
        'gimp_add_adjustment fields), lossy for per-channel curves after a reload, and such a ' +
        "filter cannot be re-edited. 'set_visibility' toggles one filter without deleting it. " +
        "'delete' removes one. 'apply' creates (or, with filter_id, re-edits in place) an " +
        'allow-listed GEGL effect filter: vignette, black_white, motion_blur, lens_blur, ' +
        'add_noise, drop_shadow — the same non-destructive, re-editable, maskable filter stack ' +
        'gimp_add_adjustment manages, just a different family of effects. There is no ' +
        "'reorder' — GIMP has no API for it; delete and re-create the filters in the desired " +
        'order instead.',
    },
    filter_id: {
      type: 'integer',
      description:
        'Required for set_visibility / delete. For apply, re-edit this existing filter IN PLACE ' +
        "instead of adding a new one (must match `filter`'s operation) — any per-effect field you " +
        "omit keeps the value it already had (a MERGE, not a reset). The values this tool's own " +
        'op=list reports for it are in these same field names and units, so they can be passed ' +
        'straight back. The mask is fixed at creation and cannot change on a re-edit. Only ' +
        'filters Editmamei created can be re-edited (op=list shows source: "editmamei"); ' +
        're-editing any other filter (for example one added in the GIMP GUI) is refused, because ' +
        'its current values cannot be read back exactly — delete it and re-create it instead.',
    },
    visible: {
      type: 'boolean',
      description: 'Required for set_visibility.',
    },
    // ---- apply ----
    filter: {
      type: 'string',
      enum: [...FILTER_EFFECTS],
      description:
        'Required for apply. Which effect to create/re-edit — see the per-field descriptions ' +
        'below for which fields apply to which effect.',
    },
    layer: {
      ...GIMP_LAYER_PROP,
      description:
        GIMP_LAYER_PROP.description +
        ' apply only. The filter applies to that ONE layer, not to the flattened image, so on a ' +
        'multi-layer document name the layer you mean. A layer inside a layer group can be named ' +
        'directly.',
    },
    mask: {
      type: 'string',
      description:
        'apply only. Name of a mask channel from gimp_create_mask, confining a NEW filter to it. ' +
        "Only valid when creating (no filter_id) — a filter's mask is fixed at creation. ORDER " +
        'MATTERS: straighten / flip / resize the canvas first (gimp_transform_canvas, ' +
        'gimp_resize_image), then crop, THEN add masked effects — rotate, flip, and resize all ' +
        'refuse outright once any masked filter exists on the image, or any filter not created by ' +
        'Editmamei, since they cannot keep a mask aligned through those transforms. Cropping ' +
        'afterward is always safe.',
    },
    name: {
      type: 'string',
      description:
        'apply only. Label for a new filter, e.g. "Corner darken". Made unique automatically.',
    },
    // ---- vignette ----
    radius: {
      type: 'number',
      minimum: 0,
      maximum: 1500,
      description:
        "vignette: how far the darkened corners reach in, 0..3 as a fraction of the image's own " +
        'half-diagonal (scale-invariant — the same value looks right at any resolution). Default ' +
        '(when creating): 1.2. lens_blur: blur radius in pixels at full resolution, 0..1500 ' +
        '(default 25 when creating). drop_shadow: blur radius in pixels at full resolution, ' +
        '0..1500 (default 10 when creating). Both are SPATIAL (radius-scaled on the proxy ' +
        'preview, see gimp_overview). The bridge enforces the precise range for whichever ' +
        '`filter` you gave.',
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
        'vignette only. Vignette center, as a fraction of image width (0 = left edge, 1 = right ' +
        'edge). Default (when creating): 0.5.',
    },
    center_y: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description:
        'vignette only. Vignette center, as a fraction of image height (0 = top edge, 1 = bottom ' +
        'edge). Default (when creating): 0.5.',
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
        'motion_blur only. Direction of the streak, in degrees. Default (when creating): 0.',
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
      description: 'drop_shadow only. Default (when creating): 0.5.',
    },
  },
  required: ['image', 'op'],
};

async function gimpFilter(
  gimp: GimpBackend,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(filterSchema, rawArgs);
    const op = args.op as string;
    // Unreachable while the schema's own enum stands (validateArgs already
    // refused anything outside it) — kept as defense-in-depth, the same
    // posture every other consolidated dispatcher takes.
    if (op !== 'list' && op !== 'set_visibility' && op !== 'delete' && op !== 'apply') {
      return unknownDiscriminator('op', op, ['list', 'set_visibility', 'delete', 'apply']);
    }
    const result = await gimp.call<Record<string, unknown>>(
      'filter',
      pickSchemaDeclaredKeys(filterSchema, args)
    );
    let text: string;
    if (op === 'list') {
      const filters = (result.filters as unknown[] | undefined) ?? [];
      text = `${filters.length} filter(s) on image ${args.image}.`;
    } else if (op === 'set_visibility') {
      text = `Filter ${result.filter_id} visibility set to ${result.visible}.`;
    } else if (op === 'delete') {
      text = `Deleted filter ${result.filter_id} ("${result.name as string}").`;
    } else {
      const r = result as { filter_id: number; name: string; type: string; mask: string | null };
      text =
        `${rawArgs.filter_id !== undefined ? 'Updated' : 'Added'} ` +
        `${r.type} filter "${r.name}" (id ${r.filter_id})` +
        (r.mask ? ` confined to mask "${r.mask}".` : '.');
    }
    return {
      content: [{ type: 'text' as const, text }],
      structuredContent: result,
    };
  } catch (error) {
    return toolGimpErrorResult('Error managing GIMP filter stack', error);
  }
}

export function createGimpFilterTools(gimp: GimpBackend): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'gimp_filter',
        description:
          'Headless GIMP: manage the live filter stack — op list | set_visibility | delete | ' +
          'apply. `apply` creates (or, with filter_id, re-edits in place) an allow-listed GEGL ' +
          'effect filter: vignette, black_white, motion_blur, lens_blur, add_noise, drop_shadow — ' +
          "non-destructive and re-editable exactly like gimp_add_adjustment's filters, sharing " +
          "the same stack, ledger, mask and geometry-refusal rules (see that tool's description " +
          'for the shared conventions: mask fixed at creation, re-edit is a MERGE, order matters ' +
          'before adding a masked filter). `delete` permanently removes any filter (there is no ' +
          'undo). `list` is the way to check what a stack of apply/gimp_add_adjustment calls ' +
          "actually produced, and to find a filter's id for a re-edit. No `reorder` (GIMP has no " +
          'API for it) — delete and re-create in the desired order instead.',
        inputSchema: filterSchema,
        outputSchema: {
          type: 'object',
          properties: {
            filters: { type: 'array', items: { type: 'object' } },
            filter_id: { type: 'number' },
            visible: { type: 'boolean' },
            name: { type: 'string' },
            deleted: { type: 'boolean' },
            type: { type: 'string' },
            mask: { type: ['string', 'null'] },
          },
        },
        annotations: {
          title: 'Manage GIMP Filter Stack',
          readOnlyHint: false,
          destructiveHint: true, // op=delete removes a filter with no undo
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      handler: async (args) => gimpFilter(gimp, args),
    },
  ];
}

/** Exported for the schema-bounds drift test — see tests/tools/gimp-filter-tools.test.ts. */
export const FILTER_SCHEMA_FOR_TESTS = filterSchema;
