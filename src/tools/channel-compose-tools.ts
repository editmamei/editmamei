import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import type { SnippetClient } from '../api/snippet-client.js';
import { runScript } from '../utils/run-script.js';
import { validateArgs, type JsonSchemaObject } from '../utils/validate.js';
import { toolErrorResult, applyToActiveLayerProp } from '../utils/tool-helpers.js';

/**
 * Channel-compose tools (m4a Tier-2) — `ps_apply_image` and `ps_calculations`.
 * Both blend image sources via Photoshop's "calculation" engine (the AM Clcl
 * object), sharing the channel+layer reference builder in go-core. AM-only —
 * Photoshop exposes no DOM API for either.
 */

// Calculation blend modes (the Clcn enum). Core set verified live against real PS
// before community promotion; Multiply + Difference are capture-confirmed.
const BLEND_MODES = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'soft_light',
  'hard_light',
  'difference',
  'exclusion',
  'subtract',
  'add',
] as const;

const blendFragment = {
  type: 'string' as const,
  enum: [...BLEND_MODES],
  description:
    'Calculation blend mode: how the source combines with the target. multiply (darken/texture), screen (lighten), overlay/soft_light/hard_light (contrast), difference/exclusion/subtract/add (channel math for masks).',
};

const applyImageSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    source_layer: {
      type: 'string',
      description:
        "Which layer to pull the source from: 'merged' (the flattened composite, default) or an exact layer name.",
      default: 'merged',
    },
    source_channel: {
      type: 'string',
      enum: ['rgb', 'red', 'green', 'blue', 'alpha'],
      description:
        "Source channel: 'rgb' (the composite, default), a single 'red'/'green'/'blue' channel, or 'alpha' (then set source_alpha_name).",
      default: 'rgb',
    },
    source_alpha_name: {
      type: 'string',
      description: "Required when source_channel='alpha': the name of the alpha channel to read.",
    },
    blend: blendFragment,
    opacity: {
      type: 'integer',
      description: 'Blend opacity 0-100. Default 100 (full strength).',
      minimum: 0,
      maximum: 100,
      default: 100,
    },
    apply_to_active_layer: applyToActiveLayerProp('the composite'),
  },
  required: ['blend'],
};

const calculationsSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    source1_layer: {
      type: 'string',
      description: "Source 1 layer: 'merged' (default) or an exact layer name.",
      default: 'merged',
    },
    source1_channel: {
      type: 'string',
      enum: ['red', 'green', 'blue', 'alpha'],
      description: "Source 1 channel: a single 'red'/'green'/'blue' channel, or 'alpha' (+ name).",
      default: 'red',
    },
    source1_alpha_name: {
      type: 'string',
      description: "Required when source1_channel='alpha'.",
    },
    source2_layer: {
      type: 'string',
      description: "Source 2 layer: 'merged' (default) or an exact layer name.",
      default: 'merged',
    },
    source2_channel: {
      type: 'string',
      enum: ['red', 'green', 'blue', 'alpha'],
      description: "Source 2 channel: a single 'red'/'green'/'blue' channel, or 'alpha' (+ name).",
      default: 'red',
    },
    source2_alpha_name: {
      type: 'string',
      description: "Required when source2_channel='alpha'.",
    },
    blend: blendFragment,
    opacity: {
      type: 'integer',
      description: 'Blend opacity 0-100. Default 100.',
      minimum: 0,
      maximum: 100,
      default: 100,
    },
  },
  required: ['blend'],
};

export function createChannelComposeTools(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient
): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'ps_apply_image',
        description:
          'Composite a source layer + channel onto the ACTIVE layer using a calculation blend mode (Image ▸ Apply Image). **Reach for this** for luminosity blends, frequency-separation re-blends, texture overlays, or pulling one channel into another. Source = a layer (merged or named) and a channel (rgb/red/green/blue/alpha). Bakes into pixels, so by default it runs on a DUPLICATE of the active layer (set apply_to_active_layer=true to bake in place). The active layer must be a normal pixel layer. (AM-only; verified live on PS 27.2.0.)',
        inputSchema: applyImageSchema,
        outputSchema: {
          type: 'object',
          properties: {
            applied: { type: 'boolean' },
            source_channel: { type: 'string' },
            source_layer: { type: 'string' },
            blend: { type: 'string' },
            opacity: { type: 'number' },
            target_was_copy: { type: 'boolean' },
            target_layer_name: { type: 'string' },
            context: { type: 'object' },
          },
        },
        annotations: {
          title: 'Apply Image',
          destructiveHint: true,
          idempotentHint: false,
        },
      },
      handler: async (args) => applyImage(connection, snippetClient, args),
    },
    {
      tool: {
        name: 'ps_calculations',
        description:
          'Blend TWO sources (each a layer + single channel) into a NEW alpha channel via a calculation blend mode (Image ▸ Calculations). **Reach for this** to build advanced selections/masks from channel math — e.g. difference of two channels to isolate edges, or multiply two channels for a luminosity mask. Non-destructive: adds a new channel (delete it to revert); the result is loadable as a selection via ps_selection_channel op=load. (AM-only; verified live on PS 27.2.0.)',
        inputSchema: calculationsSchema,
        outputSchema: {
          type: 'object',
          properties: {
            calculated: { type: 'boolean' },
            new_channel_name: { type: 'string' },
            channel_count: { type: 'number' },
            blend: { type: 'string' },
            opacity: { type: 'number' },
            context: { type: 'object' },
          },
        },
        annotations: {
          title: 'Calculations',
          destructiveHint: false,
          idempotentHint: false,
        },
      },
      handler: async (args) => calculations(connection, snippetClient, args),
    },
  ];
}

async function applyImage(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(applyImageSchema, rawArgs);
    const params: Record<string, unknown> = {
      sourceLayer: (args.source_layer as string) ?? 'merged',
      sourceChannel: (args.source_channel as string) ?? 'rgb',
      blend: args.blend as string,
      opacity: (args.opacity as number) ?? 100,
      applyToActiveLayer: (args.apply_to_active_layer as boolean) ?? false,
    };
    if (args.source_alpha_name !== undefined) params.sourceAlphaName = args.source_alpha_name;
    if (params.sourceChannel === 'alpha' && !params.sourceAlphaName) {
      throw new Error("source_channel='alpha' requires source_alpha_name");
    }

    const script = await snippetClient.build('applyImage', params);
    const result = (await runScript(connection, script)) as Record<string, unknown>;
    // The go-core return echoes the AM channel charID ("RGB "/"Grn "); surface the
    // caller-facing value (the enum, or the alpha channel name) instead.
    result.source_channel =
      params.sourceChannel === 'alpha' ? params.sourceAlphaName : params.sourceChannel;
    result.blend = params.blend;

    return {
      content: [
        {
          type: 'text' as const,
          text: `Apply Image: ${String(result.source_channel ?? '')} of "${String(result.source_layer ?? '')}" (${String(result.blend ?? '')} @ ${String(result.opacity ?? '')}%) onto "${String(result.target_layer_name ?? '')}".`,
        },
      ],
      structuredContent: result,
    };
  } catch (error) {
    return toolErrorResult('Error in ps_apply_image', error);
  }
}

async function calculations(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(calculationsSchema, rawArgs);
    const params: Record<string, unknown> = {
      source1Layer: (args.source1_layer as string) ?? 'merged',
      source1Channel: (args.source1_channel as string) ?? 'red',
      source2Layer: (args.source2_layer as string) ?? 'merged',
      source2Channel: (args.source2_channel as string) ?? 'red',
      blend: args.blend as string,
      opacity: (args.opacity as number) ?? 100,
    };
    if (args.source1_alpha_name !== undefined) params.source1AlphaName = args.source1_alpha_name;
    if (args.source2_alpha_name !== undefined) params.source2AlphaName = args.source2_alpha_name;
    if (params.source1Channel === 'alpha' && !params.source1AlphaName) {
      throw new Error("source1_channel='alpha' requires source1_alpha_name");
    }
    if (params.source2Channel === 'alpha' && !params.source2AlphaName) {
      throw new Error("source2_channel='alpha' requires source2_alpha_name");
    }

    const script = await snippetClient.build('calculations', params);
    const result = (await runScript(connection, script)) as Record<string, unknown>;
    // Surface the caller-facing blend enum rather than the AM charID the snippet echoes.
    result.blend = params.blend;

    return {
      content: [
        {
          type: 'text' as const,
          text: `Calculations → new channel "${String(result.new_channel_name ?? '')}" (${String(result.blend ?? '')} @ ${String(result.opacity ?? '')}%).`,
        },
      ],
      structuredContent: result,
    };
  } catch (error) {
    return toolErrorResult('Error in ps_calculations', error);
  }
}
