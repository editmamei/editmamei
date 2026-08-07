import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import type { SnippetClient } from '../api/snippet-client.js';
import { runScript } from '../utils/run-script.js';
import { LAYER_BLEND_MODES } from '../utils/blend-modes.js';
import { validateArgs, type JsonSchemaObject } from '../utils/validate.js';
import { toolErrorResult, runSnippetTool } from '../utils/tool-helpers.js';

// ---------- Schema constants ----------

const emptySchema: JsonSchemaObject = {
  type: 'object',
  properties: {},
};

const convertToSmartObjectSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    mode: {
      type: 'string',
      enum: ['convert', 'new_via_copy'],
      description:
        'convert (default): wrap the active layer into a Smart Object in place. ' +
        "new_via_copy: the active layer must ALREADY be a Smart Object — make a NEW Smart Object that is an INDEPENDENT copy (its own embedded source), unlinked from the original's shared source, so editing the copy's contents does not propagate back. (Differs from ps_duplicate_layer of a Smart Object, which keeps the shared source.)",
      default: 'convert',
    },
  },
};

const setLayerOpacitySchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    opacity: {
      type: 'number',
      description: 'Layer opacity (0-100) — affects the whole layer including its styles.',
      minimum: 0,
      maximum: 100,
    },
    fill_percent: {
      type: 'number',
      description:
        'Fill opacity (0-100) — the "Fill" slider. Affects the layer\'s pixels/fill but NOT its layer styles. Distinct from opacity; used for Hard Mix and stroke-only tricks. Pass opacity and/or fill_percent.',
      minimum: 0,
      maximum: 100,
    },
  },
};

const setLayerBlendModeSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    blend_mode: {
      type: 'string',
      description:
        'Blend mode name (Photoshop ExtendScript BlendMode enum). Use COLORBLEND for the "Color" mode — Photoshop reserves the bare "COLOR" name for the SolidColor class.',
      enum: [...LAYER_BLEND_MODES],
    },
  },
  required: ['blend_mode'],
};

const setLayerVisibilitySchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    visible: {
      type: 'boolean',
      description: 'Whether the layer should be visible.',
    },
  },
  required: ['visible'],
};

const setLayerLockedSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    locked: {
      type: 'boolean',
      description: 'Whether the layer should be fully locked (allLocked).',
    },
  },
  required: ['locked'],
};

const renameLayerSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description: 'New name for the active layer.',
    },
  },
  required: ['name'],
};

const duplicateLayerSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    new_name: {
      type: 'string',
      description:
        'Optional name for the duplicated layer. If omitted, Photoshop assigns "<name> copy".',
    },
  },
};

const copyToNewLayerSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    into_active_group: {
      type: 'boolean',
      description:
        "Photoshop's CpTL (Layer via Copy) event carries no placement target, so with a GROUP active it would natively nest the new layer INSIDE that group. Default false hoists the new layer back out so it lands above the active layer/group as a sibling. Pass true to keep it nested inside the active group instead.",
      default: false,
    },
  },
};

const addLayerStyleSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    style: {
      type: 'string',
      enum: ['drop_shadow', 'stroke', 'outer_glow', 'inner_shadow', 'inner_glow', 'color_overlay'],
      description:
        'Which layer style to apply. drop_shadow/inner_shadow share angle/distance/spread/size; outer_glow/inner_glow share glow_size/glow_spread; color_overlay uses only color + opacity. inner_shadow = recessed shadow inside the layer edges (Multiply); inner_glow = glow inset from the edges (Screen); color_overlay = flat solid-color fill (Normal).',
    },
    color: {
      type: 'object',
      description:
        'Effect color RGB (0-255). Default black for drop shadow, white for glow, black for stroke.',
      properties: {
        r: { type: 'number', minimum: 0, maximum: 255 },
        g: { type: 'number', minimum: 0, maximum: 255 },
        b: { type: 'number', minimum: 0, maximum: 255 },
      },
      required: ['r', 'g', 'b'],
    },
    opacity: {
      type: 'number',
      minimum: 0,
      maximum: 100,
      description: 'Effect opacity (0-100).',
      default: 50,
    },
    angle: {
      type: 'number',
      description:
        'drop_shadow/inner_shadow: light angle in degrees. 90 = top-down (standard product shadow).',
      default: 90,
    },
    distance: {
      type: 'number',
      description: 'drop_shadow/inner_shadow: shadow offset in pixels.',
      default: 8,
    },
    spread: {
      type: 'number',
      minimum: 0,
      maximum: 100,
      description: 'drop_shadow/inner_shadow: shadow choke/spread (0-100%).',
      default: 0,
    },
    size: {
      type: 'number',
      description: 'drop_shadow/inner_shadow: shadow blur size in pixels.',
      default: 12,
    },
    stroke_size: {
      type: 'number',
      description: 'stroke only: stroke width in pixels.',
      default: 3,
    },
    stroke_position: {
      type: 'string',
      enum: ['outside', 'inside', 'center'],
      description: 'stroke only: where the stroke sits relative to the layer edge.',
      default: 'outside',
    },
    glow_size: {
      type: 'number',
      description: 'outer_glow/inner_glow: glow blur size in pixels.',
      default: 12,
    },
    glow_spread: {
      type: 'number',
      minimum: 0,
      maximum: 100,
      description: 'outer_glow/inner_glow: glow choke/spread (0-100%).',
      default: 0,
    },
  },
  required: ['style'],
};

// ---------- Consolidated schemas (Phase 1, 2026-06-20) ----------

const SET_LAYER_PROPERTIES = ['opacity', 'blend_mode', 'visibility', 'locked', 'name'] as const;

// ps_set_layer merges the five idempotent property setters. No
// field-name collisions across them; the per-property handler re-validates.
const SET_LAYER_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    property: {
      type: 'string',
      enum: [...SET_LAYER_PROPERTIES],
      description:
        'Which property to set on the active layer (idempotent absolute setters; do not change which layer is active). ' +
        'opacity: opacity (whole layer incl. styles) and/or fill_percent (pixels only — the Fill slider). ' +
        'blend_mode: how the layer composites. visibility: visible (show/hide). locked: locked (allLocked). name: rename.',
    },
    ...setLayerOpacitySchema.properties,
    ...setLayerBlendModeSchema.properties,
    ...setLayerVisibilitySchema.properties,
    ...setLayerLockedSchema.properties,
    ...renameLayerSchema.properties,
  },
  required: ['property'],
};

const MERGE_MODES = ['visible', 'stamp', 'flatten'] as const;

// ps_merge merges merge_visible_layers / stamp_visible / flatten_image.
const MERGE_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    mode: {
      type: 'string',
      enum: [...MERGE_MODES],
      description:
        'visible: collapse all visible layers into one (DESTRUCTIVE; identities lost). ' +
        'stamp: merge visible into a NEW layer on top, originals kept (Ctrl+Alt+Shift+E — non-destructive "final tweak" composite). ' +
        'flatten: flatten ALL layers into the background (DESTRUCTIVE; transparency filled with bg color).',
    },
  },
  required: ['mode'],
};

// ---------- Factory ----------

export function createLayerPropertiesTools(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient
): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'ps_convert_to_smart_object',
        description:
          'Convert the active layer to a Smart Object, or (mode=new_via_copy) copy an existing Smart Object to an independent new one. `convert` (default) wraps the layer content so every subsequent filter becomes a Smart Filter — fully editable and non-destructive. PREREQUISITE for Camera Raw Filter, non-destructive frequency separation, and any workflow where filter parameters need to stay adjustable after the fact. Works on pixel, text, shape, and adjustment layers. Auto-promotes the background layer if needed. Wrapping an already-Smart-Object layer creates a nested Smart Object (valid in Photoshop — the inner SO is preserved as-is). `new_via_copy` requires the active layer to already be a Smart Object and yields a copy with its OWN source (unlinked). Use ps_rasterize_layer to go the other direction.',
        inputSchema: convertToSmartObjectSchema,
        outputSchema: {
          type: 'object',
          properties: {
            layer_name: { type: 'string' },
            is_smart_object: { type: 'boolean' },
            original_kind: { type: 'string' },
            was_already_smart_object: { type: 'boolean' },
            background_promoted: { type: 'boolean' },
            source_unlinked: { type: 'boolean' },
            context: { type: 'object' },
          },
        },
        annotations: {
          title: 'Convert to Smart Object',
          idempotentHint: false,
        },
      },
      handler: async (args) => convertToSmartObject(connection, snippetClient, args),
    },
    {
      tool: {
        name: 'ps_rasterize_layer',
        description:
          'Rasterize the active layer (convert text or smart object to plain pixels). Destructive — the text/smart-object source is lost. No-op if already a normal raster layer. Returns context so the caller sees the layer kind transition.',
        inputSchema: emptySchema,
        outputSchema: {
          type: 'object',
          properties: {
            rasterized: { type: 'boolean' },
            originalKind: { type: 'string' },
            newKind: { type: 'string' },
            message: { type: 'string' },
            kind: { type: 'string' },
            context: { type: 'object' },
          },
        },
        annotations: {
          title: 'Rasterize Layer (destructive)',
          destructiveHint: true,
        },
      },
      handler: async () => rasterizeLayer(connection, snippetClient),
    },
    {
      tool: {
        name: 'ps_set_layer',
        description:
          'Set a property of the active layer — chosen via `property`. Idempotent absolute setters; do not change which layer is active. `opacity`: pass opacity (whole layer incl. styles) and/or fill_percent (pixels only — Photoshop\'s separate "Fill" slider, for Hard Mix / stroke-only effects). `blend_mode`: how the layer composites below (NORMAL to reset). `visibility`: show/hide via `visible`. `locked`: allLocked via `locked`. `name`: rename via `name`. Returns context so the LLM keeps state awareness.',
        inputSchema: SET_LAYER_INPUT_SCHEMA,
        outputSchema: {
          type: 'object',
          properties: {
            // Phase 2 (2026-07): the write is independently re-resolved and
            // verified in-script (retry once, hard error on persistent
            // mismatch) — `verified` replaces the old hardcoded `updated`.
            property: { type: 'string' },
            value: { type: ['number', 'string'] },
            requested: { type: ['number', 'string', 'boolean'] },
            verified: { type: 'boolean' },
            verification_unreadable: {
              type: 'boolean',
              description:
                'visibility only: true when the write itself did not throw but the own-flag verification read failed (Action Manager error, or the layer had no readable id) — verified is false, but this is NOT proof the write failed, just that it could not be confirmed.',
            },
            fill_opacity: { type: 'number' },
            requested_fill_opacity: { type: 'number' },
            fill_opacity_verified: { type: 'boolean' },
            opacity: { type: 'number' },
            requested_opacity: { type: ['number', 'null'] },
            opacity_verified: { type: ['boolean', 'null'] },
            visible: { type: 'boolean' },
            locked: { type: 'boolean' },
            name: { type: 'string' },
            oldName: { type: 'string' },
            newName: { type: 'string' },
            layerName: { type: 'string' },
            context: { type: 'object' },
          },
        },
        annotations: {
          title: 'Set Layer Property',
          idempotentHint: true,
        },
      },
      handler: async (args) => setLayer(connection, snippetClient, args),
    },
    {
      tool: {
        name: 'ps_duplicate_layer',
        description:
          'Duplicate the active layer. The new layer becomes active. Returns context so the caller sees the new active layer. Not idempotent (each call creates another copy).',
        inputSchema: duplicateLayerSchema,
        outputSchema: {
          type: 'object',
          properties: {
            originalName: { type: 'string' },
            newName: { type: 'string' },
            parent_path: {
              type: ['array', 'null'],
              items: { type: 'string' },
              description:
                "The containing-group name chain (outermost first), empty array at the document root. layer.duplicate() is parent-preserving by DOM semantics, so this always matches the original layer's placement.",
            },
            context: { type: 'object' },
          },
        },
        annotations: {
          title: 'Duplicate Layer',
          // Each call creates another copy — emphatically not idempotent.
          // The previous annotation contradicted the description. T04
          // P1-C in the launch-readiness review.
          idempotentHint: false,
        },
      },
      handler: async (args) => duplicateLayer(connection, snippetClient, args),
    },
    {
      tool: {
        name: 'ps_copy_to_new_layer',
        description:
          'Copy the current selection into a NEW layer above the active one — Photoshop\'s "Layer via Copy" (Ctrl+J) — hoisted out of the active layer\'s group by default even though the underlying CpTL event carries no placement target and would otherwise nest the new layer INSIDE that group (pass into_active_group:true to keep that native nesting). The source layer is left untouched and the new copied layer becomes active. With an active selection only the selected pixels are lifted; with no selection it copies the whole active layer (a plain duplicate). Reach for this to isolate a region for independent transforms or filters (stretch, light rays, a local grade) without altering the source. Returns context so the caller sees the new active layer.',
        inputSchema: copyToNewLayerSchema,
        outputSchema: {
          type: 'object',
          properties: {
            copied_to_new_layer: { type: 'boolean' },
            new_layer_name: { type: 'string' },
            original_active_layer_name: { type: 'string' },
            layer_count_before: { type: 'number' },
            layer_count_after: { type: 'number' },
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
          title: 'Layer via Copy',
          // Each call lifts another copy — not idempotent.
          idempotentHint: false,
        },
      },
      handler: async (args) => layerViaCopy(connection, snippetClient, args),
    },
    {
      tool: {
        name: 'ps_merge',
        description:
          'Merge layers — choose with `mode`. `visible`: collapse all visible layers into one (DESTRUCTIVE; identities lost). `stamp`: merge visible into a NEW layer on top, leaving originals intact (Ctrl+Alt+Shift+E — the non-destructive "final tweak" composite for output sharpening/grain/contrast; prefer this when building on top rather than collapsing). `flatten`: flatten ALL layers into the background (DESTRUCTIVE; transparency filled with bg color — use sparingly, usually prefer `visible` or exporting a flattened copy). Returns context.',
        inputSchema: MERGE_INPUT_SCHEMA,
        outputSchema: {
          type: 'object',
          properties: {
            merged: { type: 'boolean' },
            stamped: { type: 'boolean' },
            flattened: { type: 'boolean' },
            new_layer_name: { type: 'string' },
            original_active_layer_name: { type: 'string' },
            layer_count_before: { type: 'number' },
            layer_count_after: { type: 'number' },
            context: { type: 'object' },
          },
        },
        annotations: {
          title: 'Merge Layers',
          destructiveHint: true,
        },
      },
      handler: async (args) => mergeLayers(connection, snippetClient, args),
    },
    {
      tool: {
        name: 'ps_bake_layer',
        description:
          'Flatten the active layer\'s CURRENT APPEARANCE — the layer plus any adjustment layers clipped to it plus its layer styles — into a NEW pixel layer named "<name> (baked)". Non-destructive: the originals are left intact. This is how you get real baked pixels out of a non-destructive stack: clip a Hue/Saturation (saturation -100) or an Invert adjustment to a layer, then bake to get a desaturated / inverted PIXEL layer for techniques that need actual pixels (line art, blurred-layer blends). Also works on a lone layer with nothing clipped to it — it rasterizes that layer\'s own appearance (layer styles, smart-object or text content) into a flat pixel copy. The active layer must be top-level (not inside a group).',
        inputSchema: emptySchema,
        outputSchema: {
          type: 'object',
          properties: {
            baked: { type: 'boolean' },
            baked_layer_name: { type: 'string' },
            source_layer_name: { type: 'string' },
            clipped_layers_baked: { type: 'number' },
            context: { type: 'object' },
          },
        },
        annotations: {
          title: 'Bake Layer (flatten appearance to pixels)',
          idempotentHint: false,
        },
      },
      handler: async () => bakeLayer(connection, snippetClient),
    },
    {
      tool: {
        name: 'ps_add_layer_style',
        description:
          'Apply a layer style (drop shadow, stroke, outer glow, inner shadow, inner glow, or color overlay) to the active layer. Non-destructive and editable. For PHOTO workflows: `stroke` = print-style border around the image (apply to the flattened photo on a transparent canvas, or to a duplicated background); `outer_glow` = atmospheric lift on highlights (halo around the sun, glow around a window or lamp); `drop_shadow` = depth on text overlays and layered composites. Drop shadow uses Multiply blend; outer glow uses Screen; stroke uses Normal. Cannot be applied to a background layer (duplicate or convert it first). Returns context — applying a style changes what exists on the layer (the Lefx descriptor).',
        inputSchema: addLayerStyleSchema,
        outputSchema: {
          type: 'object',
          properties: {
            applied: { type: 'boolean' },
            style: { type: 'string' },
            layerName: { type: 'string' },
            context: { type: 'object' },
          },
        },
        annotations: {
          title: 'Add Layer Style (non-destructive)',
          idempotentHint: true,
        },
      },
      handler: async (args) => addLayerStyle(connection, snippetClient, args),
    },
  ];
}

// ---------- Consolidated dispatchers (Phase 1, 2026-06-20) ----------

// ps_set_layer → per-property setter. `property` is stripped so the
// delegate validates only its own params.
async function setLayer(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  const property = rawArgs.property;
  const { property: _omit, ...rest } = rawArgs;
  switch (property) {
    case 'opacity':
      return setLayerOpacity(connection, snippetClient, rest);
    case 'blend_mode':
      return setLayerBlendMode(connection, snippetClient, rest);
    case 'visibility':
      return setLayerVisibility(connection, snippetClient, rest);
    case 'locked':
      return setLayerLocked(connection, snippetClient, rest);
    case 'name':
      return renameLayer(connection, snippetClient, rest);
    default:
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: unknown layer property "${String(property)}". Allowed: ${SET_LAYER_PROPERTIES.join(', ')}.`,
          },
        ],
        isError: true,
      };
  }
}

// ps_merge → per-mode merge handler (all param-free).
async function mergeLayers(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  switch (rawArgs.mode) {
    case 'visible':
      return mergeVisibleLayers(connection, snippetClient);
    case 'stamp':
      return stampVisible(connection, snippetClient);
    case 'flatten':
      return flattenImage(connection, snippetClient);
    default:
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: unknown merge mode "${String(rawArgs.mode)}". Allowed: ${MERGE_MODES.join(', ')}.`,
          },
        ],
        isError: true,
      };
  }
}

// ---------- Handlers ----------

async function convertToSmartObject(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(convertToSmartObjectSchema, rawArgs);
    const mode = (args.mode as string) ?? 'convert';
    const snippet = mode === 'new_via_copy' ? 'newSmartObjectViaCopy' : 'convertToSmartObject';

    const script = await snippetClient.build(snippet);
    const result = await runScript(connection, script);
    const verb =
      mode === 'new_via_copy'
        ? 'New independent Smart Object created via copy'
        : 'Layer converted to Smart Object';
    return {
      content: [
        {
          type: 'text' as const,
          text: `${verb}.\nResult: ${JSON.stringify(result)}`,
        },
      ],
      structuredContent: result as Record<string, unknown>,
    };
  } catch (error) {
    return toolErrorResult('Error converting to Smart Object', error);
  }
}

async function rasterizeLayer(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs: {},
    schema: emptySchema,
    snippet: 'rasterizeLayer',
    errorPrefix: 'Error rasterizing layer',
    successText: (result) => `Layer rasterized\nResult: ${JSON.stringify(result)}`,
  });
}

async function setLayerOpacity(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: setLayerOpacitySchema,
    snippet: 'setLayerOpacity',
    errorPrefix: 'Error setting layer opacity',
    params: (args) => {
      const opacity = args.opacity as number | undefined;
      const fillPercent = args.fill_percent as number | undefined;

      if (opacity === undefined && fillPercent === undefined) {
        throw new Error('set_layer_opacity requires opacity and/or fill_percent.');
      }

      let buildParams: Record<string, unknown>;
      if (fillPercent !== undefined) {
        buildParams = { fillOpacity: fillPercent };
        if (opacity !== undefined) buildParams.opacity = opacity;
      } else {
        buildParams = { opacity };
      }
      return buildParams;
    },
    // Fix 4 (Phase 2): render the verified ACTUAL value(s), not the
    // request argument — the snippet throws before returning if a write
    // didn't verify, so by the time we're here these are confirmed landed.
    // The two snippets behind this tool return DIFFERENT shapes, and the
    // opacity value lives under a different key in each. setLayerOpacity
    // (opacity only) returns it as `value`; setLayerOpacityFull (the fill
    // path) returns it as `opacity`. On the fill path `opacity` is present
    // even when the caller never asked for it — it's a fresh read of what
    // was already there — so only report it when requested_opacity is
    // non-null, or a plain fill_percent call would claim an opacity the
    // caller never set.
    successText: (result) => {
      const r = result as {
        value?: number;
        opacity?: number;
        requested_opacity?: number | null;
        fill_opacity?: number;
      };
      const parts: string[] = [];
      const opacityActual = r.value ?? (r.requested_opacity != null ? r.opacity : undefined);
      if (opacityActual !== undefined) parts.push(`opacity ${opacityActual}%`);
      if (r.fill_opacity !== undefined) parts.push(`fill ${r.fill_opacity}%`);
      const label = parts.length > 0 ? parts.join(' + ') : 'opacity';
      return `Layer ${label} set`;
    },
  });
}

async function setLayerBlendMode(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: setLayerBlendModeSchema,
    snippet: 'setLayerBlendMode',
    errorPrefix: 'Error setting blend mode',
    params: (args) => ({ blendMode: args.blend_mode as string }),
    // Fix 4 (Phase 2): render the verified ACTUAL blend mode, not the
    // request argument.
    successText: (result) => {
      const r = result as { value?: string };
      return r.value !== undefined ? `Layer blend mode set to ${r.value}` : 'Layer blend mode set';
    },
  });
}

async function setLayerVisibility(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: setLayerVisibilitySchema,
    snippet: 'setLayerVisibility',
    errorPrefix: 'Error setting layer visibility',
    params: (args) => ({ visible: args.visible as boolean }),
    // Fix 4 (Phase 2): render the verified ACTUAL visibility, not the
    // request argument.
    successText: (result) => {
      const r = result as { visible?: boolean };
      return r.visible !== undefined
        ? `Layer ${r.visible ? 'shown' : 'hidden'}`
        : 'Layer visibility set';
    },
  });
}

async function setLayerLocked(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: setLayerLockedSchema,
    snippet: 'setLayerLocked',
    errorPrefix: 'Error locking/unlocking layer',
    params: (args) => ({ locked: args.locked as boolean }),
    // Fix 4 (Phase 2): render the verified ACTUAL lock state, not the
    // request argument.
    successText: (result) => {
      const r = result as { locked?: boolean };
      return r.locked !== undefined
        ? `Layer ${r.locked ? 'locked' : 'unlocked'}`
        : 'Layer lock state set';
    },
  });
}

async function renameLayer(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: renameLayerSchema,
    snippet: 'renameLayer',
    errorPrefix: 'Error renaming layer',
    params: (args) => ({ newName: args.name as string }),
    // Fix 4 (Phase 2): render the verified ACTUAL new name, not the
    // request argument.
    successText: (result) => {
      const r = result as { newName?: string };
      return r.newName !== undefined
        ? `Layer renamed to: ${r.newName}\nResult: ${JSON.stringify(result)}`
        : `Layer renamed\nResult: ${JSON.stringify(result)}`;
    },
  });
}

async function duplicateLayer(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: duplicateLayerSchema,
    snippet: 'duplicateLayer',
    errorPrefix: 'Error duplicating layer',
    params: (args) => {
      const newName = args.new_name as string | undefined;
      const params: Record<string, unknown> = {};
      if (newName !== undefined) params.newName = newName;
      return params;
    },
    successText: (result) => `Layer duplicated\nResult: ${JSON.stringify(result)}`,
  });
}

async function layerViaCopy(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: copyToNewLayerSchema,
    snippet: 'layerViaCopy',
    errorPrefix: 'Error in Layer via Copy',
    params: (args) => ({
      into_active_group: (args.into_active_group as boolean) ?? false,
    }),
    successText: (result) =>
      `Copied selection into new layer "${(result as { new_layer_name?: string }).new_layer_name ?? '?'}"`,
  });
}

async function mergeVisibleLayers(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs: {},
    schema: emptySchema,
    snippet: 'mergeVisibleLayers',
    errorPrefix: 'Error merging visible layers',
    successText: () => 'All visible layers merged',
  });
}

async function stampVisible(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs: {},
    schema: emptySchema,
    snippet: 'stampVisible',
    errorPrefix: 'Error stamping visible',
    successText: (result) =>
      `Stamped visible composite into new layer "${(result as { stamped?: boolean; new_layer_name?: string }).new_layer_name ?? '?'}"`,
  });
}

async function bakeLayer(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs: {},
    schema: emptySchema,
    snippet: 'bakeLayer',
    errorPrefix: 'Error baking layer',
    successText: (result) => {
      const r = result as { baked_layer_name?: string; clipped_layers_baked?: number };
      return `Baked "${r.baked_layer_name ?? '?'}" (${r.clipped_layers_baked ?? 0} clipped adjustment(s) flattened in).`;
    },
  });
}

async function flattenImage(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs: {},
    schema: emptySchema,
    snippet: 'flattenImage',
    errorPrefix: 'Error flattening image',
    successText: () => 'Image flattened (all layers merged to background)',
  });
}

async function addLayerStyle(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: addLayerStyleSchema,
    snippet: 'addLayerStyle',
    errorPrefix: 'Error applying layer style',
    params: (args) => {
      const style = args.style as string;
      const color = args.color as { r: number; g: number; b: number } | undefined;

      const params: Record<string, unknown> = { styleType: style };
      if (color) params.color = color;
      if (args.opacity !== undefined) params.opacity = args.opacity as number;
      if (args.angle !== undefined) params.angle = args.angle as number;
      if (args.distance !== undefined) params.distance = args.distance as number;
      if (args.spread !== undefined) params.spread = args.spread as number;
      if (args.size !== undefined) params.size = args.size as number;
      if (args.stroke_size !== undefined) params.stroke_size = args.stroke_size as number;
      if (args.stroke_position !== undefined)
        params.stroke_position = args.stroke_position as string;
      if (args.glow_size !== undefined) params.glow_size = args.glow_size as number;
      if (args.glow_spread !== undefined) params.glow_spread = args.glow_spread as number;
      return params;
    },
    successText: (result) => `Layer style applied:\n${JSON.stringify(result, null, 2)}`,
  });
}
