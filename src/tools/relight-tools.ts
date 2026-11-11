import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import type { SnippetClient } from '../api/snippet-client.js';
import { runSnippetTool, toolErrorResult } from '../utils/tool-helpers.js';
import { validateArgs, type JsonSchemaObject } from '../utils/validate.js';
import { RELIGHT_TIMEOUT_MS } from '../utils/operation-timeouts.js';
import { requestApproval } from '../core/call-approval.js';

/**
 * ps_relight: Photoshop 28's Relight (Layer > New Relight layer).
 *
 * Adds up to three lights to a photo and renders the result in Adobe's cloud as a new Relight
 * layer above the source, which Photoshop hides. Every render spends Adobe Firefly generative
 * credits from the person's Adobe account (30 per render as of Photoshop 28.0), so the tool asks
 * the person first through MCP elicitation and renders only on an explicit yes.
 *
 * The inputs are the Relight panel's own sliders, so a person who opens Edit Lighting sees the
 * same numbers. The panel-to-descriptor mapping was read back from the panel on 2026-11-11
 * (Photoshop 28.0.0, Windows): see toDescriptorLight.
 */

/** Adobe's published price of one Relight render, in Adobe Firefly generative credits. */
export const RELIGHT_ADOBE_CREDITS = 30;

export const RELIGHT_TOOL_NAME = 'ps_relight';

const lightSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    left_right: {
      type: 'number',
      description:
        "Where the light sits across the frame: 0 is far left, 100 far right (the panel's Left/Right slider).",
      default: 50,
      minimum: 0,
      maximum: 100,
    },
    low_high: {
      type: 'number',
      description:
        "How high the light sits: 0 is low (from below), 100 high (from above). The panel's Low/High slider.",
      default: 60,
      minimum: 0,
      maximum: 100,
    },
    close_far: {
      type: 'number',
      description:
        "Depth: 0 is close to the camera (front light), 100 far behind the subject (back or rim light). The panel's Close/Far slider.",
      default: 40,
      minimum: 0,
      maximum: 100,
    },
    intensity: {
      type: 'number',
      description: 'Brightness of this light, in percent.',
      default: 50,
      minimum: 0,
      maximum: 100,
    },
    diffusion: {
      type: 'number',
      description: 'Softness: low is a hard light with crisp shadows, high a soft wrapping light.',
      default: 40,
      minimum: 0,
      maximum: 100,
    },
    color_kelvin: {
      type: 'number',
      description:
        'Color temperature: about 2000 candle, 3200 tungsten, 5500 daylight (neutral), 7500+ cool blue. Ignored when color is given.',
      default: 5500,
      minimum: 1000,
      maximum: 10000,
    },
    color: {
      type: 'string',
      description:
        'Any light color as #RRGGBB, e.g. "#ff3366" for a magenta gel. Overrides color_kelvin.',
      pattern: '^#[0-9a-fA-F]{6}$',
    },
  },
};

const relightInputSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    lights: {
      type: 'array',
      description:
        "One to three lights, each placed with the Relight panel's sliders. Defaults give a soft daylight key slightly above and in front of the subject.",
      minItems: 1,
      maxItems: 3,
      items: { type: 'object', properties: lightSchema.properties },
    },
    original_lighting: {
      type: 'number',
      description:
        "How much of the photo's existing light stays, in percent. Lower it for a moodier, studio-lit look where the new lights dominate.",
      default: 80,
      minimum: 0,
      maximum: 100,
    },
    layer: {
      type: 'string',
      description: 'Name of the layer to relight. Defaults to the active layer.',
    },
    confirm_adobe_credits: {
      type: 'boolean',
      description:
        "Only for apps that can't show Editmamei's approval prompt: set true AFTER the person has said yes in the chat to spending 30 Adobe Firefly generative credits on this render. Ignored when the app can show the prompt; the prompt always decides there.",
      default: false,
    },
  },
  required: ['lights'],
};

interface DescriptorLight {
  x: number;
  y: number;
  z: number;
  r: number;
  g: number;
  b: number;
  intensity: number;
  radius: number;
}

const round = (v: number): number => Math.round(v * 10000) / 10000;

/**
 * Approximate RGB (0-1) of a color temperature, tuned to sit near Photoshop's Relight presets
 * (5500K reads 0.96/0.94/0.91, 2000K 0.94/0.66/0.21). A black-body curve (Tanner Helland's fit),
 * eased 30% toward white the way Adobe's presets are.
 */
export function kelvinToRgb(kelvin: number): [number, number, number] {
  const t = Math.min(40000, Math.max(1000, kelvin)) / 100;
  const clamp = (v: number) => Math.min(255, Math.max(0, v)) / 255;
  const r = t <= 66 ? 1 : clamp(329.698727446 * Math.pow(t - 60, -0.1332047592));
  const g =
    t <= 66
      ? clamp(99.4708025861 * Math.log(t) - 161.1195681661)
      : clamp(288.1221695283 * Math.pow(t - 60, -0.0755148492));
  const b = t >= 66 ? 1 : t <= 19 ? 0 : clamp(138.5177312231 * Math.log(t - 10) - 305.0447927307);
  const ease = (c: number) => round(0.96 * (0.7 * c + 0.3));
  return [ease(r), ease(g), ease(b)];
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [round(((n >> 16) & 255) / 255), round(((n >> 8) & 255) / 255), round((n & 255) / 255)];
}

/**
 * Panel sliders to descriptor units, as read back from the panel (2026-11-11):
 *   Left/Right u  -> X = 2u - 1        Close/Far u -> Y = 2u - 1 (Y is DEPTH, not height)
 *   Low/High u    -> z = 0.1 + 1.9u    Intensity p -> (p/100)^1.6
 *   Diffusion p   -> radius = 0.7 * p/100
 */
export function toDescriptorLight(light: Record<string, unknown>): DescriptorLight {
  const pct = (k: string) => (light[k] as number) / 100;
  const [r, g, b] =
    typeof light.color === 'string'
      ? hexToRgb(light.color)
      : kelvinToRgb(light.color_kelvin as number);
  return {
    x: round(2 * pct('left_right') - 1),
    y: round(2 * pct('close_far') - 1),
    z: round(0.1 + 1.9 * pct('low_high')),
    r,
    g,
    b,
    intensity: round(Math.pow(pct('intensity'), 1.6)),
    radius: round(0.7 * pct('diffusion')),
  };
}

function approvalMessage(lightCount: number, layer: string | undefined): string {
  const target = layer ? `the layer "${layer}"` : 'the active layer';
  const lights = lightCount === 1 ? '1 light' : `${lightCount} lights`;
  return (
    `Relight ${target} in Photoshop with ${lights}?\n\n` +
    `This uses ${RELIGHT_ADOBE_CREDITS} Adobe Firefly generative credits from your Adobe account ` +
    `(not Editmamei credits). Photoshop renders it in Adobe's cloud and saves the result as a new ` +
    `Relight layer, leaving your original layer untouched underneath.`
  );
}

function notRendered(text: string, reason: string): ToolResult {
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: { relit: false, reason, adobe_credits_used: 0 },
  };
}

async function relight(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  let args: Record<string, unknown>;
  let lights: DescriptorLight[];
  try {
    args = validateArgs(relightInputSchema, rawArgs);
    const raw = args.lights as unknown[];
    if (raw.length < 1 || raw.length > 3) {
      throw new Error(`lights takes one to three lights, got ${raw.length}.`);
    }
    lights = raw.map((l, i) => {
      if (typeof l !== 'object' || l === null || Array.isArray(l)) {
        throw new Error(`lights[${i}] must be an object of slider values.`);
      }
      return toDescriptorLight(validateArgs(lightSchema, l as Record<string, unknown>));
    });
  } catch (error) {
    return toolErrorResult('Error relighting', error);
  }
  const layer = typeof args.layer === 'string' && args.layer.trim() !== '' ? args.layer : undefined;

  // Validation first, then the person: nobody is asked about a render that would be refused.
  const outcome = await requestApproval({
    tool: RELIGHT_TOOL_NAME,
    key: 'adobe_credits',
    message: approvalMessage(lights.length, layer),
    checkboxTitle: `Use ${RELIGHT_ADOBE_CREDITS} Adobe Firefly credits`,
  });
  if (outcome === 'pending') {
    // 2026-07-28: the question went back with the result; the server returns it and the client
    // retries this call with the answer. This text is never sent.
    return notRendered('Waiting for the person to approve the Adobe Firefly credits.', 'pending');
  }
  if (outcome === 'declined') {
    return notRendered(
      `Not relit: the person did not approve spending ${RELIGHT_ADOBE_CREDITS} Adobe Firefly generative credits. Nothing changed and no credits were used. Ask before trying again.`,
      'declined'
    );
  }
  if (outcome === 'nested') {
    return notRendered(
      `Not relit: ${RELIGHT_TOOL_NAME} has to be called on its own, not from inside another tool such as ps_sequence, because each render needs the person's own approval. Nothing was rendered and no credits were used.`,
      'nested'
    );
  }
  if (outcome === 'failed') {
    return notRendered(
      "Not relit: Editmamei couldn't show the approval prompt, so nothing was rendered and no credits were used.",
      'prompt_failed'
    );
  }
  if (outcome === 'unsupported' && args.confirm_adobe_credits !== true) {
    return notRendered(
      `Not relit yet: this app can't show Editmamei's approval prompt. Ask the person in the chat whether to spend ${RELIGHT_ADOBE_CREDITS} Adobe Firefly generative credits from their Adobe account on this render, and only if they say yes, call ps_relight again with confirm_adobe_credits: true.`,
      'needs_confirmation'
    );
  }

  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs: args,
    schema: relightInputSchema,
    snippet: 'relight',
    errorPrefix: 'Error running Relight',
    timeoutMs: RELIGHT_TIMEOUT_MS,
    params: () => ({
      layerName: layer ?? '',
      lights,
      ambient: round(((args.original_lighting as number) ?? 80) / 100),
    }),
    successText: (result) => {
      const r = result as { layer_name?: string; source_layer?: string };
      return `Relit "${r.source_layer ?? 'the layer'}" into a new layer "${r.layer_name ?? 'Relight Layer'}" (${RELIGHT_ADOBE_CREDITS} Adobe Firefly generative credits used). The original is hidden underneath; check the result with ps_get_preview.`;
    },
  }).then((result) =>
    result.isError
      ? result
      : {
          ...result,
          structuredContent: {
            ...(result.structuredContent ?? {}),
            adobe_credits_used: RELIGHT_ADOBE_CREDITS,
          },
        }
  );
}

export function createRelightTools(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient
): ToolDefinition[] {
  return [
    {
      tool: {
        name: RELIGHT_TOOL_NAME,
        description:
          "Run Photoshop's Relight (Photoshop 2027 / 28.0+): add one to three lights to a photo, such as a warm key from the left, a rim light behind the subject or a colored gel, rendered as a new Relight layer above the original, which stays hidden underneath. Generative and paid: each call is ONE cloud render that spends 30 Adobe Firefly generative credits from the person's Adobe account, and the person approves every render. Use it ONLY when the person asks for Relight (or Photoshop's relighting) by name, or said yes after you offered it. For requests like 'golden hour', 'studio lighting' or 'more dramatic light', edit with the normal tools first (curves, dodge and burn, gradients, color grading); you may mention Relight once as an optional extra that costs Adobe credits, without pushing it. Plan the lights before calling; never iterate renders to explore. Lower original_lighting for a moody studio look. It adds and shapes light; it doesn't remove a shadow cast by another object. Needs Photoshop signed in and online.",
        inputSchema: relightInputSchema,
        outputSchema: {
          type: 'object',
          properties: {
            relit: { type: 'boolean' },
            reason: {
              type: 'string',
              description:
                "Why nothing rendered: 'declined', 'needs_confirmation', 'nested', 'prompt_failed' or 'pending'.",
            },
            adobe_credits_used: {
              type: 'number',
              description:
                'Adobe Firefly generative credits this call spent (0 when nothing rendered).',
            },
            layer_name: { type: 'string', description: 'The new Relight layer.' },
            source_layer: { type: 'string', description: 'The layer that was relit.' },
            source_hidden: {
              type: 'boolean',
              description: 'Whether Photoshop hid the source layer, as it does by default.',
            },
            source_found: {
              type: 'boolean',
              description: 'Whether the source layer was still there after the render.',
            },
            light_count: { type: 'number' },
            original_lighting: {
              type: 'number',
              description: 'The original-lighting share sent, 0-1.',
            },
            strategy_used: { type: 'string' },
            context: { type: 'object' },
          },
        },
        annotations: {
          title: 'Relight (Adobe Firefly credits)',
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      spendsAdobeCredits: true,
      handler: async (args) => relight(connection, snippetClient, args),
    },
  ];
}
