import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import type { GimpBackend } from '../backends/gimp/backend.js';
import { validateArgs, type JsonSchemaObject, type JsonSchemaProperty } from '../utils/validate.js';
import { toolGimpErrorResult, unknownDiscriminator } from '../utils/tool-helpers.js';
import { GIMP_IMAGE_PROP, runGimpTool, pickSchemaDeclaredKeys } from './gimp-shared.js';

/**
 * gimp_crop_document / gimp_resize_image / gimp_transform_canvas.
 *
 * Order matters (see gimp_overview / gimp_add_adjustment's description):
 * straighten / flip / resize FIRST, then crop, then add any MASKED
 * adjustment. Rotate, flip, and resize all REFUSE outright
 * (`invalid_argument`, naming the filters) when the image already has a
 * masked filter, or a filter with no ledger record (one whose mask can't be
 * checked, e.g. added in the GIMP GUI) — GIMP has no way to keep a filter's own baked-in mask
 * confinement aligned with those transforms (verified live: the filter's
 * confinement stays pinned to the PRE-transform pixel positions, silently
 * misaligned, or for resize appears to have no effect at all —
 * `bridge/ops.py`'s geometry-section comment). Crop is the one exception:
 * it verified correct and never refuses for this reason.
 */

const cropSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    image: GIMP_IMAGE_PROP,
    left: { type: 'number', description: 'Left edge of the new canvas, in document pixels.' },
    top: { type: 'number', description: 'Top edge of the new canvas, in document pixels.' },
    width: { type: 'number', minimum: 1, description: 'New canvas width, in pixels.' },
    height: { type: 'number', minimum: 1, description: 'New canvas height, in pixels.' },
  },
  required: ['image', 'left', 'top', 'width', 'height'],
};

const resizeSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    image: GIMP_IMAGE_PROP,
    width: {
      type: 'integer',
      minimum: 1,
      maximum: 30000,
      description:
        'Target width, px. With height, stretches to exactly that box. Alone, height is derived ' +
        "to keep aspect. Capped at 30000 px/side and 250 MP total (the bridge's DoS floor).",
    },
    height: {
      type: 'integer',
      minimum: 1,
      maximum: 30000,
      description: 'Target height, px. See width.',
    },
    long_edge: {
      type: 'integer',
      minimum: 1,
      maximum: 30000,
      description:
        'Scale so the longer side lands here, preserving aspect. Use this OR width/height.',
    },
  },
  required: ['image'],
};

/** Names of effect filters whose geometry-tracking update failed partway through this
 * rotate/flip/resize (bridge/ops.py's `_apply_planned_effect_transform`): a live GEGL config
 * update raised, so that filter's OLD params were kept in the ledger instead of the new ones, and
 * the bridge tried (best effort) to restore the same OLD params to the live render too -- present
 * only when non-empty. Covers BOTH kinds of tracked filter: position/direction-dependent ones
 * under flip/rotate/resize (a center, an angle, an offset vector), and size-dependent ones under
 * resize alone (a blur radius scaled by the resize factor) — both go through the same
 * failure-and-restore path. Described generically (not naming a tool by name) since the leak
 * guard scans every community tool's own schema text for a dev/none-tier tool name — describing
 * this in terms of WHICHEVER tool made the filter, rather than the one that currently does, means
 * this text never needs to change if that changes. A plain array of strings, not a nullable/oneOf
 * type: `runGimpTool`/`gimpTransformCanvas` simply omit the key from the result when there is
 * nothing to report, rather than encoding "empty" as a schema-level null variant. */
const EFFECT_UPDATE_FAILURES_PROP: JsonSchemaProperty = {
  type: 'array',
  items: { type: 'string' },
  description:
    'Names of effect filters (position/direction/size-dependent ones tracked through geometry ' +
    'changes — a center, an angle, an offset, or a size-dependent blur radius under resize) ' +
    'whose own params could not be updated for this transform (a live update failure) -- they ' +
    "were restored to their OLD values in gimp_filter's own ledger (guaranteed), and the bridge " +
    'also tried to restore those same OLD values to the live render (best effort — it can, ' +
    'rarely, also fail). Omitted when every filter updated cleanly.',
};

const transformCanvasSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    image: GIMP_IMAGE_PROP,
    op: {
      type: 'string',
      enum: ['rotate', 'flip'],
      description:
        "'rotate' takes an arbitrary `degrees` (straighten) + `expand`. 'flip' takes `orientation`.",
    },
    degrees: {
      type: 'number',
      description:
        'rotate only. Arbitrary angle (straighten), not limited to 90° multiples. Positive rotates clockwise.',
    },
    expand: {
      type: 'boolean',
      default: false,
      description:
        "rotate only. Resize the canvas to the rotated content's new bounds (like Photoshop's " +
        '"reveal all"). Without it, rotated content can fall outside the original canvas and be cropped.',
    },
    orientation: {
      type: 'string',
      enum: ['horizontal', 'vertical'],
      description: 'flip only.',
    },
  },
  required: ['image', 'op'],
};

/** Appended to a rotate/flip/resize result's text when the bridge reports `effect_update_failures`
 * -- a live GEGL update that failed partway through applying the geometry transform to one of
 * gimp_add_effect's filters. The filter's OWN params are kept at their OLD position/angle/offset/
 * size in the ledger (guaranteed, bridge/ops.py's `_apply_planned_effect_transform`), and the
 * bridge also tries to restore those same OLD values to the live render (best effort -- it just
 * didn't move with the rest of the image, though rarely even that restore can fail too). */
function effectUpdateFailuresNote(failures: string[] | undefined): string {
  if (!failures || failures.length === 0) return '';
  const plural = failures.length > 1;
  const it = plural ? 'them' : 'it';
  return (
    ` WARNING: ${failures.join(', ')} could not be updated for this transform and ` +
    `${plural ? 'were' : 'was'} left at ${plural ? 'their' : 'its'} old position/angle/offset/size ` +
    `instead -- delete ${it} (gimp_filter op=delete) and re-create ${it} if ${plural ? 'they need' : 'it needs'} ` +
    `to track the content (re-applying THIS SAME transform again would move ${it} a second time, ` +
    `misaligning ${it} the other way).`
  );
}

async function gimpTransformCanvas(
  gimp: GimpBackend,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(transformCanvasSchema, rawArgs);
    const op = args.op as string;
    // Unreachable while the schema's own enum stands (validateArgs already
    // refused anything outside it) — kept as defense-in-depth, the same
    // posture every other consolidated ps_* dispatcher takes (e.g. ps_select
    // in selection-tools.ts) for the day the enum is ever loosened.
    if (op !== 'rotate' && op !== 'flip') {
      return unknownDiscriminator('op', op, ['rotate', 'flip']);
    }
    const result = await gimp.call<{
      width: number;
      height: number;
      degrees?: number;
      effect_update_failures?: string[];
    }>(op, pickSchemaDeclaredKeys(transformCanvasSchema, args));
    const text =
      (op === 'rotate'
        ? `Rotated ${result.degrees}°. New canvas ${result.width}x${result.height}.`
        : `Flipped ${args.orientation as string}. Canvas ${result.width}x${result.height}.`) +
      effectUpdateFailuresNote(result.effect_update_failures);
    return {
      content: [{ type: 'text' as const, text }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  } catch (error) {
    return toolGimpErrorResult('Error transforming GIMP canvas', error);
  }
}

export function createGimpGeometryTools(gimp: GimpBackend): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'gimp_crop_document',
        description:
          'Headless GIMP: crop the canvas to an explicit rectangle (left, top, width, height in ' +
          'document pixels) — not a scale (that is gimp_resize_image). IRREVERSIBLE in this ' +
          'session: there is no undo, so gimp_checkpoint (or gimp_save_xcf) first when in doubt. Every live filter, ' +
          'mask channel, and the filter ledger survive a crop — verified live; it is the one ' +
          'geometry op that never refuses for masked-filter safety.',
        inputSchema: cropSchema,
        outputSchema: {
          type: 'object',
          properties: { width: { type: 'number' }, height: { type: 'number' } },
        },
        annotations: {
          title: 'Crop GIMP Document',
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      handler: async (args) =>
        runGimpTool({
          gimp,
          rawArgs: args,
          schema: cropSchema,
          op: 'crop',
          errorPrefix: 'Error cropping GIMP document',
          successText: (result) => {
            const r = result as { width: number; height: number };
            return `Cropped to ${r.width}x${r.height}.`;
          },
        }),
    },
    {
      tool: {
        name: 'gimp_resize_image',
        description:
          'Headless GIMP: scale the whole image up or down — not a crop (that is ' +
          'gimp_crop_document). Give width+height to stretch to an exact box, one alone to keep ' +
          'aspect, or long_edge to scale by the longer side. IRREVERSIBLE in this session: there ' +
          'is no undo, so gimp_checkpoint (or gimp_save_xcf) first when in doubt. REFUSES outright when the image has a ' +
          'masked filter, or any filter not created by Editmamei (for example one added ' +
          'in the GIMP GUI) — resize before adding any masked filter, not after. A large target (the ' +
          'bridge allows up to 250 megapixels / 30000px per side) can take tens of seconds; if it ' +
          'times out, the GIMP session restarts and any unsaved work — filters, masks, and any ' +
          'other open image — is lost, so make a checkpoint (gimp_checkpoint) before an aggressive resize.',
        inputSchema: resizeSchema,
        outputSchema: {
          type: 'object',
          properties: {
            width: { type: 'number' },
            height: { type: 'number' },
            effect_update_failures: EFFECT_UPDATE_FAILURES_PROP,
          },
        },
        annotations: {
          title: 'Resize GIMP Image',
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      handler: async (args) =>
        runGimpTool({
          gimp,
          rawArgs: args,
          schema: resizeSchema,
          op: 'resize',
          errorPrefix: 'Error resizing GIMP image',
          successText: (result) => {
            const r = result as {
              width: number;
              height: number;
              effect_update_failures?: string[];
            };
            return (
              `Resized to ${r.width}x${r.height}.` +
              effectUpdateFailuresNote(r.effect_update_failures)
            );
          },
        }),
    },
    {
      tool: {
        name: 'gimp_transform_canvas',
        description:
          "Headless GIMP: op 'rotate' (arbitrary `degrees` — straighten — plus `expand`) | 'flip' " +
          '(`orientation` horizontal/vertical). IRREVERSIBLE in this session: there is no undo, so ' +
          'gimp_checkpoint (or gimp_save_xcf) first when in doubt. REFUSES outright when the image has a masked ' +
          'filter, or any filter not created by Editmamei (for example one added in the ' +
          'GIMP GUI) — straighten/flip before adding any masked filter, not after (crop is the ' +
          'one geometry op that is always safe afterward). A rotate to anything other than an ' +
          'exact 0/90/180/270 degrees is also refused while a position/direction-dependent ' +
          'filter is present, since only a right angle keeps such a filter locked to the content ' +
          '— rotate at a right angle instead, or delete it (gimp_filter op=delete) and re-add it ' +
          'afterwards. Rotating a very large image can take tens of seconds; ' +
          'if it times out, the GIMP session restarts and any unsaved work — filters, masks, and ' +
          'any other open image — is lost, so make a checkpoint (gimp_checkpoint) before rotating a large canvas.',
        inputSchema: transformCanvasSchema,
        outputSchema: {
          type: 'object',
          properties: {
            width: { type: 'number' },
            height: { type: 'number' },
            degrees: { type: 'number' },
            effect_update_failures: EFFECT_UPDATE_FAILURES_PROP,
          },
        },
        annotations: {
          title: 'Transform GIMP Canvas',
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      handler: async (args) => gimpTransformCanvas(gimp, args),
    },
  ];
}
