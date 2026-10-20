import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import type { SnippetClient } from '../api/snippet-client.js';
import { runSnippetTool } from '../utils/tool-helpers.js';
import { requireLocalPath } from '../utils/local-path.js';
import { type JsonSchemaObject } from '../utils/validate.js';
import { SKY_REPLACEMENT_TIMEOUT_MS } from '../utils/operation-timeouts.js';
import {
  defaultSkyPreset,
  loadSkyPresets,
  matchSkyPreset,
  type SkyPreset,
} from '../utils/sky-presets.js';

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
 * sky — not just Photoshop's registered presets. A built-in sky is named with
 * `sky` and resolved to its file here (see sky-presets.ts).
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
    sky: {
      type: 'string',
      description:
        'Name of one of Photoshop\'s built-in skies, e.g. "Blue Sky 002", "Spectacular 004" or "Sunset Sky 003" (skies the user saved in Photoshop work too). The server finds the image itself, so no file or folder access is needed. Pass "list" to get the installed skies\' names without changing the document. Omit both sky and sky_file to use Photoshop\'s Blue Sky 001 (or the first installed sky).',
    },
    sky_file: {
      type: 'string',
      description:
        'ABSOLUTE path to any image to use as the sky instead of a built-in one; it does not need to be a Photoshop sky preset. Takes precedence over sky.',
    },
    sky_name: {
      type: 'string',
      description:
        'Label recorded on the operation. Cosmetic — it does not select the sky. Defaults to the built-in sky\'s name, or "Custom Sky" for sky_file.',
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
};

interface ResolvedSky {
  kind: 'file' | 'preset';
  path: string;
  label: string;
}

/**
 * The image the composite uses: `sky_file` when given (local-path checked), else the built-in sky
 * `sky` names, else the default (see defaultSkyPreset). Throws with the installed sky names when `sky`
 * matches none, and with a sky_file hint when this machine has no sky presets at all.
 */
function resolveSky(args: Record<string, unknown>, presets: () => SkyPreset[]): ResolvedSky {
  if (args.sky_file !== undefined) {
    return {
      kind: 'file',
      path: requireLocalPath('sky_file', args.sky_file),
      label: 'Custom Sky',
    };
  }
  const installed = presets();
  if (installed.length === 0) {
    throw new Error(
      "Photoshop's built-in skies were not found on this computer (the Sky_Presets folder in Photoshop's settings). Pass sky_file with the absolute path to any image to use as the sky."
    );
  }
  // A blank name means no name: the default, not a failed lookup.
  const query = typeof args.sky === 'string' && args.sky.trim() !== '' ? args.sky : undefined;
  const preset =
    query === undefined ? defaultSkyPreset(installed) : matchSkyPreset(installed, query);
  if (!preset) {
    throw new Error(
      `No built-in sky matches "${query}". Installed skies: ${installed.map((p) => p.name).join('; ')}.`
    );
  }
  return { kind: 'preset', path: preset.file, label: preset.name };
}

async function replaceSky(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>,
  presets: () => SkyPreset[]
): Promise<ToolResult> {
  // `sky: "list"` answers what a model otherwise finds out by passing a name it knows is wrong:
  // which skies are installed. Nothing is built or run.
  if (
    rawArgs.sky_file === undefined &&
    typeof rawArgs.sky === 'string' &&
    rawArgs.sky.trim().toLowerCase() === 'list'
  ) {
    const names = presets().map((p) => p.name);
    return {
      content: [
        {
          type: 'text' as const,
          text: names.length
            ? `Installed skies: ${names.join('; ')}.`
            : "Photoshop's built-in skies were not found on this computer. Pass sky_file with the absolute path to any image to use as the sky.",
        },
      ],
      structuredContent: { replaced: false, skies: names },
    };
  }
  let sky: ResolvedSky | undefined;
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: replaceSkyInputSchema,
    snippet: 'replaceSky',
    errorPrefix: 'Error running Sky Replacement',
    timeoutMs: SKY_REPLACEMENT_TIMEOUT_MS,
    params: (args) => {
      sky = resolveSky(args, presets);
      return {
        skyPath: sky.path,
        skyName: (args.sky_name as string) ?? sky.label,
        // See PLACEHOLDER_SKY_ID — the sky file path drives the composite, not this.
        skyId: PLACEHOLDER_SKY_ID,
        shiftEdge: (args.shift_edge as number) ?? 0,
        borderSmoothness: (args.border_smoothness as number) ?? 50,
        brightness: (args.brightness as number) ?? 0,
        temperature: (args.temperature as number) ?? 0,
        harmonizationOpacity: (args.harmonization_opacity as number) ?? 35,
        foregroundLightingOpacity: (args.foreground_lighting_opacity as number) ?? 78,
        edgeLightingOpacity: (args.edge_lighting_opacity as number) ?? 70,
      };
    },
    successText: () =>
      sky?.kind === 'preset'
        ? `Sky replaced using Photoshop's built-in sky "${sky.label}"`
        : `Sky replaced using ${sky?.path ?? 'the given file'}`,
  });
}

export interface SkyToolOptions {
  /** Where built-in skies come from; tests pass a fixed list. */
  presets?: () => SkyPreset[];
}

export function createSkyTools(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  options: SkyToolOptions = {}
): ToolDefinition[] {
  const presets = options.presets ?? (() => loadSkyPresets());
  return [
    {
      tool: {
        name: 'ps_replace_sky',
        description:
          "Run Photoshop's Sky Replacement (Adobe Sensei): detect the sky, composite a replacement, and relight/colour-grade the foreground to match. Non-destructive — everything lands in a \"Sky Replacement Group\" of editable layers above the original, so the result can be tuned or deleted afterwards. Pick one of Photoshop's built-in skies by name with sky (no path needed), or pass sky_file with an ABSOLUTE path to ANY image on disk; with neither, Photoshop's Blue Sky 001 is used (or the first installed sky). Reach for harmonization_opacity and foreground_lighting_opacity when the composite reads as pasted-on; those two carry most of the believability. Fails cleanly when the image has no detectable sky (indoor or closed compositions).",
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
            skies: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Installed sky names; returned instead of a composite when sky is "list".',
            },
            context: { type: 'object' },
          },
        },
        annotations: {
          title: 'Replace Sky (Sensei)',
          idempotentHint: false,
        },
      },
      handler: async (args) => replaceSky(connection, snippetClient, args, presets),
    },
  ];
}
