import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import type { GimpBackend } from '../backends/gimp/backend.js';
import type { JsonSchemaObject } from '../utils/validate.js';
import {
  GIMP_IMAGE_PROP,
  GIMP_LAYER_ID_PROP,
  GIMP_LAYER_PROP,
  runGimpTool,
} from './gimp-shared.js';

/**
 * gimp_match_layer — pull a pasted layer's colour and tone toward its surroundings
 * (`bridge/ops.py`'s `op_match_layer`). It measures the layer's visible pixels against a
 * reference region of the composite beneath it and writes the Reinhard-style linear map that
 * moves the layer's per-channel mean and spread toward the reference as `gimp:curves` filters,
 * so the result stays live and is edited or removed through gimp_filter like any adjustment.
 */

const matchSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    image: GIMP_IMAGE_PROP,
    layer: {
      ...GIMP_LAYER_PROP,
      description:
        'Name of the pasted layer to match. Defaults to the selected layer, or the topmost layer ' +
        'if none is selected. A layer inside a layer group can be named directly.',
    },
    layer_id: GIMP_LAYER_ID_PROP,
    match: {
      type: 'string',
      enum: ['both', 'color', 'tone'],
      default: 'both',
      description:
        "'color' and 'both' write one curves filter each for red, green and blue (matching each " +
        "channel's mean and spread also matches overall tone, so 'both' adds no separate value " +
        "curve). 'tone' writes ONE value curve only, which moves brightness and contrast without " +
        'shifting the colour balance.',
    },
    strength: {
      type: 'number',
      minimum: 0,
      maximum: 100,
      default: 70,
      description:
        'How far to move toward the reference, 0-100. 0 changes nothing (identity curves); 100 ' +
        'matches the reference mean and spread (contrast gain is limited to 0.5-2x).',
    },
    reference: {
      type: 'string',
      enum: ['surround', 'below'],
      default: 'surround',
      description:
        "'surround': a ring of the composite beneath, just outside the layer's visible edge " +
        "(the light the subject sits in). 'below': the whole composite beneath the layer's box.",
    },
    surround_px: {
      type: 'integer',
      minimum: 1,
      maximum: 400,
      description:
        "reference 'surround' only. Ring width in pixels. Default about 12% of the layer's " +
        'longer side, clamped to 16-400.',
    },
    edge_contract_px: {
      type: 'integer',
      minimum: 0,
      maximum: 20,
      default: 0,
      description:
        "Pull the layer's visible edge in by this many pixels, through its layer mask (one is " +
        'made from its alpha if it has none) to hide a cut-out fringe. 0 leaves the edge alone.',
    },
    edge_feather_px: {
      type: 'integer',
      minimum: 0,
      maximum: 50,
      default: 0,
      description:
        "Soften the layer's visible edge by this many pixels through its layer mask, after any " +
        "contraction. 0 leaves the edge alone. The layer's own alpha is never changed.",
    },
  },
  required: ['image'],
};

interface MatchChannelReport {
  before: { mean: number; std: number };
  after: { mean: number; std: number };
  reference: { mean: number; std: number };
  gain: number;
}

interface MatchResult {
  layer: string;
  match: string;
  reference: string;
  strength: number;
  filters: Array<{ filter_id: number; name: string; channel: string }>;
  replaced_filter_ids: number[];
  measured: { layer_pixels: number; reference_pixels: number };
  channels: Record<string, MatchChannelReport>;
  edge: { contract_px: number; feather_px: number; mask_created: boolean } | null;
}

export function createGimpMatchTools(gimp: GimpBackend): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'gimp_match_layer',
        description:
          'Headless GIMP: make a pasted or composited layer sit in its scene by pulling its colour ' +
          "and tone toward the surrounding pixels. Measures the layer's visible pixels (alpha and " +
          'layer mask) against a reference region of everything below it, then adds LIVE curves ' +
          'filters named "Match red/green/blue" (match: both or color) or "Match value" (match: ' +
          "tone) that move the layer's per-channel mean and spread toward the reference by " +
          '`strength`. The filters are ordinary ones: list, hide, re-edit or delete them with ' +
          'gimp_filter and gimp_add_adjustment (filter_id); nothing bakes until gimp_export. ' +
          'Calling it again REPLACES the previous match filters on that layer instead of stacking ' +
          'them. The layer is measured as it renders with its other filters, so run it after the ' +
          'layer is placed, cut out and transformed. Optional edge_contract_px / edge_feather_px ' +
          'refine the layer mask to hide a cut-out fringe. Refuses a layer group, a text layer ' +
          '(bake it first), a locked layer, a layer with no visible layers beneath it, and a ' +
          'region with fewer than 500 pixels. The result reports the filters made, each ' +
          "channel's before/after mean and std (0-255; `after` is the map's expected value) and " +
          'the pixel counts measured.',
        inputSchema: matchSchema,
        outputSchema: {
          type: 'object',
          properties: {
            layer: { type: 'string' },
            layer_id: { type: 'number' },
            match: { type: 'string' },
            reference: { type: 'string' },
            strength: { type: 'number' },
            surround_px: { type: ['number', 'null'] },
            filters: { type: 'array' },
            replaced_filter_ids: { type: 'array' },
            measured: { type: 'object' },
            channels: { type: 'object' },
            edge: { type: ['object', 'null'] },
          },
        },
        annotations: {
          title: 'Match GIMP Layer To Scene',
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      handler: async (args): Promise<ToolResult> =>
        runGimpTool({
          gimp,
          rawArgs: args,
          schema: matchSchema,
          op: 'match_layer',
          errorPrefix: 'Error matching GIMP layer',
          successText: (result) => {
            const r = result as unknown as MatchResult;
            const moved = Object.entries(r.channels)
              .map(
                ([channel, c]) =>
                  `${channel} ${c.before.mean.toFixed(0)} -> ${c.after.mean.toFixed(0)} ` +
                  `(reference ${c.reference.mean.toFixed(0)})`
              )
              .join(', ');
            return (
              `Matched "${r.layer}" to its ${r.reference} at ${r.strength}% (${r.match}): ` +
              `${r.filters.length} curves filter(s)` +
              (r.replaced_filter_ids.length
                ? `, replacing ${r.replaced_filter_ids.length} earlier`
                : '') +
              `. Means ${moved}.` +
              (r.edge
                ? ` Edge: contracted ${r.edge.contract_px} px, feathered ${r.edge.feather_px} px via the layer mask.`
                : '')
            );
          },
        }),
    },
  ];
}

/** Exported for the schema-bounds drift test — see tests/tools/gimp-match-tools.test.ts. */
export const MATCH_SCHEMA_FOR_TESTS = matchSchema;
