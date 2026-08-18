import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import type { SnippetClient } from '../api/snippet-client.js';
import { runSnippetTool } from '../utils/tool-helpers.js';
import { type JsonSchemaObject } from '../utils/validate.js';
import { SKY_REPLACEMENT_TIMEOUT_MS } from '../utils/operation-timeouts.js';

/**
 * ps_replace_sky — Photoshop's Sky Replacement (Adobe Sensei).
 *
 * Not a selection tool: the event emits a "Sky Replacement Group" holding the
 * sky layer, an edge-lighting group, a foreground-lighting layer and a
 * foreground-colour curves layer. Its masks are LAYER masks on those layers —
 * `doc.channels` is untouched, so there is nothing to read via the alpha-channel
 * path (verified live against PS 27.2.0, 2026-08-15).
 *
 * The sky asset is driven by an absolute FILE PATH. Photoshop honours that path
 * even when the accompanying preset GUID matches nothing installed (verified the
 * same day with a deliberately fabricated GUID), so any image on disk works as a
 * sky — not just Photoshop's registered presets.
 */

/**
 * NOT exposed as a parameter, deliberately. Photoshop's descriptor carries a
 * `lightingMode` field and its dialog appears to offer Screen/Multiply, but the
 * field is ignored: proven live 2026-08-16 that `Scrn` and `Mltp` with all other
 * values identical produce byte-identical renders, and the resulting Foreground
 * Lighting layer was SCREEN/32 either way. Photoshop derives that blend from the
 * sky content (MULTIPLY/60 at defaults, SCREEN/32 at extremes — tracking neither
 * request). The fragment sends the captured value; surfacing it as a control
 * would ship a knob that silently does nothing.
 */

/**
 * Filler for the descriptor's `Idnt` (preset GUID) field.
 *
 * `Idnt` does NOT choose the sky — the `File` path does, and a fabricated GUID
 * composites happily from an arbitrary image (verified live 2026-08-15). We
 * still send a well-formed value rather than an empty string purely because
 * both verified-working calls carried one; whether an empty `Idnt` is actually
 * rejected is UNTESTED, so this matches the only shape observed to work instead
 * of relying on a guess. All-zero is deliberately not a real GUID, so it never
 * claims to identify a preset we do not have.
 */
const PLACEHOLDER_SKY_ID = '00000000-0000-0000-0000-000000000000';

const replaceSkyInputSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    sky_file: {
      type: 'string',
      description:
        'ABSOLUTE path to the image to use as the sky. Any image Photoshop can open works — it does not need to be a registered Photoshop sky preset. The built-in skies live as .jpg files under the Sky_Presets folder inside your Photoshop settings directory, and their paths can be passed here directly.',
    },
    sky_name: {
      type: 'string',
      description:
        'Label recorded on the operation. Cosmetic — it does not select the sky, sky_file does.',
      default: 'Custom Sky',
    },
    shift_edge: {
      type: 'number',
      description:
        'Moves the sky/foreground boundary inward (negative) or outward (positive). Use it when the horizon leaves a halo or eats into the foreground.',
      default: 0,
      minimum: -100,
      maximum: 100,
    },
    border_smoothness: {
      type: 'number',
      description: 'Softens the boundary between sky and foreground. 0 is a hard cut.',
      default: 50,
      minimum: 0,
      maximum: 100,
    },
    brightness: {
      type: 'number',
      description: 'Brightness of the replaced sky itself.',
      default: 0,
      minimum: -100,
      maximum: 100,
    },
    temperature: {
      type: 'number',
      description: 'Warms (positive) or cools (negative) the replaced sky.',
      default: 0,
      minimum: -100,
      maximum: 100,
    },
    harmonization_opacity: {
      type: 'number',
      description:
        'How strongly the foreground is colour-graded to match the new sky. This is what sells the composite — 0 leaves the foreground untouched and usually reads as pasted-on.',
      default: 35,
      minimum: 0,
      maximum: 100,
    },
    foreground_lighting_opacity: {
      type: 'number',
      description:
        'Strength of the relighting applied to the foreground so it appears lit by the new sky.',
      default: 78,
      minimum: 0,
      maximum: 100,
    },
    edge_lighting_opacity: {
      type: 'number',
      description: 'Strength of the light wrap along the foreground edge where it meets the sky.',
      default: 70,
      minimum: 0,
      maximum: 100,
    },
  },
  required: ['sky_file'],
};

async function replaceSky(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: replaceSkyInputSchema,
    snippet: 'replaceSky',
    errorPrefix: 'Error running Sky Replacement',
    timeoutMs: SKY_REPLACEMENT_TIMEOUT_MS,
    params: (args) => ({
      skyPath: args.sky_file as string,
      skyName: (args.sky_name as string) ?? 'Custom Sky',
      // See PLACEHOLDER_SKY_ID — the sky_file path drives the composite, not this.
      skyId: PLACEHOLDER_SKY_ID,
      shiftEdge: (args.shift_edge as number) ?? 0,
      borderSmoothness: (args.border_smoothness as number) ?? 50,
      brightness: (args.brightness as number) ?? 0,
      temperature: (args.temperature as number) ?? 0,
      harmonizationOpacity: (args.harmonization_opacity as number) ?? 35,
      foregroundLightingOpacity: (args.foreground_lighting_opacity as number) ?? 78,
      edgeLightingOpacity: (args.edge_lighting_opacity as number) ?? 70,
    }),
    successText: (_result, args) => `Sky replaced using ${String(args.sky_file)}`,
  });
}

export function createSkyTools(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient
): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'ps_replace_sky',
        description:
          'Run Photoshop\'s Sky Replacement (Adobe Sensei): detect the sky, composite a replacement, and relight/colour-grade the foreground to match. Non-destructive — everything lands in a "Sky Replacement Group" of editable layers above the original, so the result can be tuned or deleted afterwards. sky_file takes an ABSOLUTE path to ANY image on disk, not only Photoshop\'s built-in presets. Reach for harmonization_opacity and foreground_lighting_opacity when the composite reads as pasted-on; those two carry most of the believability. Fails cleanly when the image has no detectable sky (indoor or closed compositions).',
        inputSchema: replaceSkyInputSchema,
        outputSchema: {
          type: 'object',
          properties: {
            replaced: { type: 'boolean' },
            strategy_used: { type: 'string' },
            group_name: {
              type: 'string',
              description: 'Name of the layer group Photoshop created.',
            },
            group_layers: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Layers inside the group, top to bottom — typically the sky layer, an edge-lighting group, a foreground-lighting layer and a foreground-colour curves layer.',
            },
            sky_file: { type: 'string' },
            sky_name: { type: 'string' },
            context: { type: 'object' },
          },
        },
        annotations: {
          title: 'Replace Sky (Sensei)',
          idempotentHint: false,
        },
      },
      handler: async (args) => replaceSky(connection, snippetClient, args),
    },
  ];
}
