/**
 * Community tools — selection-driven destructive retouch surface.
 *
 * Three tools: apply_content_aware_fill, apply_patch, apply_content_aware_move.
 * Classified 'community' in src/core/tool-tiers.ts as of the 2026-06-16 tier
 * rollout (previously 'pro', in retouch-tools-pro.ts). Content-aware retouch is
 * a core photo-editing capability, so it ships in CE; the file therefore lives
 * outside the *-pro.ts stub set and registers via the shared CE factory list
 * in server.ts. The matching go-core emitters moved out of the //go:build pro
 * tag in the same change.
 *
 * Each reads the document's active selection at execute-time and bakes
 * pixels into the active layer. All follow the auto-duplicate-
 * first pattern — original layer preserved by default; the operation
 * runs against a freshly-named copy. Callers that want the historical
 * bake-into-active-layer behavior pass `apply_to_active_layer: true`.
 *
 * All three tools throw with a clear error message if no selection is
 * active. Without this guard, Content-Aware Fill would silently fill
 * the whole layer; Patch / Content-Aware Move would error from PS at
 * the descriptor level with a less-actionable message.
 *
 * Specs: src/spec/ps27/retouch/{content-aware-fill,patch,content-aware-move}.ts
 */
import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import type { SnippetClient } from '../api/snippet-client.js';
import { runScript } from '../utils/run-script.js';
import { validateArgs, type JsonSchemaObject } from '../utils/validate.js';
import { toolErrorResult, runSnippetTool, applyToActiveLayerProp } from '../utils/tool-helpers.js';
import { resolveExpectedPlacement, PLACEMENT_SCHEMA } from '../perception/grounding-locate.js';
import { OnnxDetectionClient, type DetectionClient } from '../detection/detection-client.js';

/**
 * Ground a move/patch offset: resolve a placement to a gated POINT, read the current
 * selection's center (getSelectionState — read-only), and return the delta that lands
 * the selection center on that point. So the caller NAMES the destination/source
 * ("move it onto the resolved spot", "patch from the clean region") instead of
 * guessing a raw offset_x/offset_y.
 */
async function groundedOffset(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  detClient: DetectionClient,
  placement: unknown,
  label: string
): Promise<{
  offsetX: number;
  offsetY: number;
  point: { x: number; y: number };
  center: { x: number; y: number };
}> {
  const rp = await resolveExpectedPlacement(connection, detClient, placement, 'point', label);
  const sel = (await runScript(connection, await snippetClient.build('getSelectionState'))) as {
    has_selection?: boolean;
    bounds?: { left: number; top: number; right: number; bottom: number };
  };
  if (!sel.has_selection || !sel.bounds)
    throw new Error(
      `${label} needs an active selection to move relative to — none found. Make the selection first.`
    );
  const center = {
    x: (sel.bounds.left + sel.bounds.right) / 2,
    y: (sel.bounds.top + sel.bounds.bottom) / 2,
  };
  return {
    offsetX: Math.round(rp.point.x - center.x),
    offsetY: Math.round(rp.point.y - center.y),
    point: rp.point,
    center: { x: Math.round(center.x), y: Math.round(center.y) },
  };
}

// ---------- Content-Aware Fill ----------

const CAF_BLEND_MODES = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'soft_light',
  'hard_light',
  'darken',
  'lighten',
  'difference',
  'color_burn',
  'color_dodge',
  'linear_burn',
  'linear_dodge',
] as const;

const contentAwareFillSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    color_adaptation: {
      type: 'boolean',
      description:
        "When true (default), PS adjusts the synthesized fill to match the surrounding region's color. Turn off only when matching color would compromise structure.",
      default: true,
    },
    rotate: {
      type: 'boolean',
      description:
        'Allow PS to rotate sampled patches when synthesizing. Default false (Photoshop default).',
      default: false,
    },
    scale: {
      type: 'boolean',
      description: 'Allow PS to rescale sampled patches when synthesizing. Default false.',
      default: false,
    },
    mirror: {
      type: 'boolean',
      description: 'Allow PS to mirror sampled patches when synthesizing. Default false.',
      default: false,
    },
    opacity: {
      type: 'integer',
      description: 'Fill opacity 1-100%. Default 100.',
      minimum: 1,
      maximum: 100,
      default: 100,
    },
    blend_mode: {
      type: 'string',
      description:
        'Blend mode for the fill. Default `normal`. Use `multiply` or `darken` when filling around hair to keep darker edges; `lighten` for highlights.',
      enum: [...CAF_BLEND_MODES],
      default: 'normal',
    },
    apply_to_active_layer: applyToActiveLayerProp('the retouch op'),
  },
};

// ---------- Patch ----------

const patchSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    source_placement: {
      ...PLACEMENT_SCHEMA,
      description:
        'Grounded alternative to offset_x/offset_y: NAME the patch SOURCE (resolves to a POINT via the grounding resolver + objective gate — e.g. an extremum for the cleanest nearby skin, a grid intersection). The offset from the selection center to that point is computed for you. Wins over offset_x/offset_y. Provide THIS or offset_x + offset_y.',
    },
    offset_x: {
      type: 'number',
      description:
        'Horizontal pixel offset from the selection to the patch source. Positive = source is to the right. Required unless source_placement is given.',
    },
    offset_y: {
      type: 'number',
      description:
        'Vertical pixel offset from the selection to the patch source. Positive = source is below. Required unless source_placement is given.',
    },
    patch_structure: {
      type: 'integer',
      description:
        'Options bar > Structure slider (1-7). Higher values preserve structure more aggressively. Default 5.',
      minimum: 1,
      maximum: 7,
      default: 5,
    },
    patch_color: {
      type: 'integer',
      description:
        'Options bar > Color slider (0-10). Higher values blend color more aggressively. Default 5. Note: PS internally remaps the UI slider value; the captured integer may differ by ±1 from the dialog value.',
      minimum: 0,
      maximum: 10,
      default: 5,
    },
    heal_smooth_factor: {
      type: 'integer',
      description: 'Internal smoothing factor (0-10). Default 5.',
      minimum: 0,
      maximum: 10,
      default: 5,
    },
    sample_all_layers: {
      type: 'boolean',
      description: 'Sample from all visible layers when synthesizing the patch. Default false.',
      default: false,
    },
    transparent: {
      type: 'boolean',
      description: 'Respect layer transparency when patching. Default false.',
      default: false,
    },
    use_source: {
      type: 'boolean',
      description:
        'When true (default), the user-drawn selection is the patch source — the natural "patch this region" semantic. False inverts to destination-mode patching.',
      default: true,
    },
    apply_to_active_layer: applyToActiveLayerProp('the retouch op'),
  },
  // offset_x/offset_y OR source_placement — enforced in the handler.
};

// ---------- Content-Aware Move ----------

const contentAwareMoveSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    destination_placement: {
      ...PLACEMENT_SCHEMA,
      description:
        'Grounded alternative to offset_x/offset_y: NAME where to move the selection (resolves to a POINT via the grounding resolver + objective gate — a grid intersection, an object centroid, an extremum). The selection center is moved ONTO that point; the offset is computed for you. Wins over offset_x/offset_y. Provide THIS or offset_x + offset_y.',
    },
    offset_x: {
      type: 'number',
      description:
        'Horizontal pixel delta to move the selected content. Positive = right. Required unless destination_placement is given.',
    },
    offset_y: {
      type: 'number',
      description:
        'Vertical pixel delta to move the selected content. Positive = down. Required unless destination_placement is given.',
    },
    patch_structure: {
      type: 'integer',
      description: 'Options bar > Structure slider (1-7). Default 4 (CAM default).',
      minimum: 1,
      maximum: 7,
      default: 4,
    },
    patch_color: {
      type: 'integer',
      description: 'Options bar > Color slider (0-10). Default 5.',
      minimum: 0,
      maximum: 10,
      default: 5,
    },
    heal_smooth_factor: {
      type: 'integer',
      description: 'Internal smoothing factor (0-10). Default 5.',
      minimum: 0,
      maximum: 10,
      default: 5,
    },
    sample_all_layers: {
      type: 'boolean',
      description: 'Sample from all visible layers. Default false.',
      default: false,
    },
    transparent: {
      type: 'boolean',
      description: 'Respect layer transparency. Default false.',
      default: false,
    },
    reshuffle: {
      type: 'boolean',
      description:
        'Allow PS to recompose the moved content from non-contiguous source pixels. Default true (Photoshop default for CAM).',
      default: true,
    },
    apply_to_active_layer: applyToActiveLayerProp('the retouch op'),
  },
  // offset_x/offset_y OR destination_placement — enforced in the handler.
};

// ---------- Output schema (shared) ----------

const RETOUCH_OUTPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    retouch: { type: 'string' as const },
    target_was_copy: { type: 'boolean' as const },
    target_layer_name: { type: 'string' as const },
    original_layer_name: { type: 'string' as const },
    context: { type: 'object' as const },
  },
};

// ---------- Handlers ----------

async function applyContentAwareFill(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: contentAwareFillSchema,
    snippet: 'applyContentAwareFill',
    errorPrefix: 'Error applying Content-Aware Fill',
    params: (args) => ({
      colorAdaptation: (args.color_adaptation as boolean) ?? true,
      rotate: (args.rotate as boolean) ?? false,
      scale: (args.scale as boolean) ?? false,
      mirror: (args.mirror as boolean) ?? false,
      opacity: (args.opacity as number) ?? 100,
      blendMode: (args.blend_mode as string) ?? 'normal',
      applyToActiveLayer: (args.apply_to_active_layer as boolean) ?? false,
    }),
    successText: (result, args) => {
      const r = result as { target_was_copy?: boolean; target_layer_name?: string };
      const target = r.target_was_copy
        ? `new copy "${r.target_layer_name ?? '?'}"`
        : 'active layer (in place)';
      const opacity = (args.opacity as number) ?? 100;
      const blendMode = (args.blend_mode as string) ?? 'normal';
      return `Content-Aware Fill applied to ${target} at ${opacity}% opacity, blend ${blendMode}.`;
    },
  });
}

async function applyPatch(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  detClient: DetectionClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(patchSchema, rawArgs);
    let offsetX = args.offset_x as number | undefined;
    let offsetY = args.offset_y as number | undefined;
    let grounded: { point: { x: number; y: number }; center: { x: number; y: number } } | undefined;
    if (args.source_placement) {
      const g = await groundedOffset(
        connection,
        snippetClient,
        detClient,
        args.source_placement,
        'patch source'
      );
      offsetX = g.offsetX;
      offsetY = g.offsetY;
      grounded = { point: g.point, center: g.center };
    } else if (offsetX === undefined || offsetY === undefined) {
      throw new Error(
        'provide offset_x + offset_y, or source_placement to NAME the patch source region.'
      );
    }
    const patchStructure = (args.patch_structure as number) ?? 5;
    const patchColor = (args.patch_color as number) ?? 5;
    const healSmoothFactor = (args.heal_smooth_factor as number) ?? 5;
    const sampleAllLayers = (args.sample_all_layers as boolean) ?? false;
    const transparent = (args.transparent as boolean) ?? false;
    const useSource = (args.use_source as boolean) ?? true;
    const applyToActiveLayer = (args.apply_to_active_layer as boolean) ?? false;

    const script = await snippetClient.build('applyPatch', {
      offsetX,
      offsetY,
      patchStructure,
      patchColor,
      healSmoothFactor,
      sampleAllLayers,
      transparent,
      useSource,
      applyToActiveLayer,
    });
    const result = await runScript(connection, script);

    const r = result as { target_was_copy?: boolean; target_layer_name?: string };
    const target = r.target_was_copy
      ? `new copy "${r.target_layer_name ?? '?'}"`
      : 'active layer (in place)';
    const groundedNote = grounded
      ? ` — source at (${Math.round(grounded.point.x)},${Math.round(grounded.point.y)}) via placement (gate PASS)`
      : '';
    const structured = result as Record<string, unknown>;
    if (grounded) {
      structured.source_placement = {
        gate: { pass: true },
        point: { x: Math.round(grounded.point.x), y: Math.round(grounded.point.y) },
        selection_center: grounded.center,
        offset: { x: offsetX, y: offsetY },
      };
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: `Patch applied to ${target} (offset ${offsetX}, ${offsetY}; structure ${patchStructure}, color ${patchColor})${groundedNote}.`,
        },
      ],
      structuredContent: structured,
    };
  } catch (error) {
    return toolErrorResult('Error applying Patch', error);
  }
}

async function applyContentAwareMove(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  detClient: DetectionClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(contentAwareMoveSchema, rawArgs);
    let offsetX = args.offset_x as number | undefined;
    let offsetY = args.offset_y as number | undefined;
    let grounded: { point: { x: number; y: number }; center: { x: number; y: number } } | undefined;
    if (args.destination_placement) {
      const g = await groundedOffset(
        connection,
        snippetClient,
        detClient,
        args.destination_placement,
        'content-aware move'
      );
      offsetX = g.offsetX;
      offsetY = g.offsetY;
      grounded = { point: g.point, center: g.center };
    } else if (offsetX === undefined || offsetY === undefined) {
      throw new Error(
        'provide offset_x + offset_y, or destination_placement to NAME where to move the selection.'
      );
    }
    const patchStructure = (args.patch_structure as number) ?? 4;
    const patchColor = (args.patch_color as number) ?? 5;
    const healSmoothFactor = (args.heal_smooth_factor as number) ?? 5;
    const sampleAllLayers = (args.sample_all_layers as boolean) ?? false;
    const transparent = (args.transparent as boolean) ?? false;
    const reshuffle = (args.reshuffle as boolean) ?? true;
    const applyToActiveLayer = (args.apply_to_active_layer as boolean) ?? false;

    const script = await snippetClient.build('applyContentAwareMove', {
      offsetX,
      offsetY,
      patchStructure,
      patchColor,
      healSmoothFactor,
      sampleAllLayers,
      transparent,
      reshuffle,
      applyToActiveLayer,
    });
    const result = await runScript(connection, script);

    const r = result as { target_was_copy?: boolean; target_layer_name?: string };
    const target = r.target_was_copy
      ? `new copy "${r.target_layer_name ?? '?'}"`
      : 'active layer (in place)';
    const groundedNote = grounded
      ? ` — moved onto (${Math.round(grounded.point.x)},${Math.round(grounded.point.y)}) via placement (gate PASS)`
      : '';
    const structured = result as Record<string, unknown>;
    if (grounded) {
      structured.destination_placement = {
        gate: { pass: true },
        point: { x: Math.round(grounded.point.x), y: Math.round(grounded.point.y) },
        selection_center: grounded.center,
        offset: { x: offsetX, y: offsetY },
      };
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: `Content-Aware Move applied to ${target} (delta ${offsetX}, ${offsetY})${groundedNote}.`,
        },
      ],
      structuredContent: structured,
    };
  } catch (error) {
    return toolErrorResult('Error applying Content-Aware Move', error);
  }
}

// ---------- Factory ----------

const RETOUCH_METHODS = ['content_aware_fill', 'patch', 'content_aware_move'] as const;

// Consolidated input schema for ps_retouch (Phase 1, 2026-06-20).
// Merges the three per-method schemas. Shared offset_x/offset_y and the
// adaptation sliders collide harmlessly (same meaning); per-method defaults
// (e.g. patch_structure 5 vs CAM 4) are applied by the per-method handler,
// which re-validates against its exact schema. Only `method` is required at
// this level — patch/content_aware_move enforce their own required offsets.
const RETOUCH_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    method: {
      type: 'string',
      enum: [...RETOUCH_METHODS],
      description:
        'Retouch technique (all require an active selection). ' +
        'content_aware_fill: synthesize a fill from surrounding content (color_adaptation, opacity, blend_mode, rotate/scale/mirror). ' +
        'patch: sample replacement pixels — offset_x + offset_y, OR source_placement to NAME the clean source region (patch_structure 1-7, patch_color 0-10, use_source). ' +
        'content_aware_move: relocate the selection and fill the source — offset_x + offset_y, OR destination_placement to NAME where to move it (patch_structure, reshuffle).',
    },
    ...contentAwareFillSchema.properties,
    ...patchSchema.properties,
    ...contentAwareMoveSchema.properties,
  },
  required: ['method'],
};

export function createRetouchTools(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  detClient: DetectionClient = new OnnxDetectionClient()
): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'ps_retouch',
        description:
          'Selection-driven content-aware retouch — choose the technique with `method`. Requires an active selection (throws if none, so Content-Aware Fill never silently fills the whole layer). Auto-duplicates the active layer by default so the original is preserved (auto-duplicate-first); pass `apply_to_active_layer: true` to bake into the original. `content_aware_fill` synthesizes a fill from surroundings (remove wires/objects/blemishes); `patch` samples replacement pixels from a chosen offset — or NAME the source region with `source_placement` (grounded + gated); `content_aware_move` relocates the selection and fills the source — offset, or NAME where with `destination_placement`.',
        inputSchema: RETOUCH_INPUT_SCHEMA,
        outputSchema: RETOUCH_OUTPUT_SCHEMA,
        annotations: {
          title: 'Content-Aware Retouch',
          destructiveHint: true,
          idempotentHint: false,
        },
      },
      handler: async (args) => retouch(connection, snippetClient, detClient, args),
    },
  ];
}

// Dispatch the consolidated tool to the per-method handler. `method` is stripped
// so the delegate validates only its own params against its per-method schema.
async function retouch(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  detClient: DetectionClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  const method = rawArgs.method;
  const { method: _omit, ...rest } = rawArgs;
  switch (method) {
    case 'content_aware_fill':
      return applyContentAwareFill(connection, snippetClient, rest);
    case 'patch':
      return applyPatch(connection, snippetClient, detClient, rest);
    case 'content_aware_move':
      return applyContentAwareMove(connection, snippetClient, detClient, rest);
    default:
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: unknown retouch method "${String(method)}". Allowed: ${RETOUCH_METHODS.join(', ')}.`,
          },
        ],
        isError: true,
      };
  }
}
