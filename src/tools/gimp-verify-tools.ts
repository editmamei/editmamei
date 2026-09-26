import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import type { GimpBackend } from '../backends/gimp/backend.js';
import { validateArgs, type JsonSchemaObject } from '../utils/validate.js';
import { toolGimpErrorResult, unknownDiscriminator } from '../utils/tool-helpers.js';
import { loadSettings } from '../core/settings.js';
import {
  GIMP_IMAGE_PROP,
  GIMP_REGION_PROP,
  GIMP_MAX_PX_PROP,
  pickSchemaDeclaredKeys,
} from './gimp-shared.js';

/**
 * gimp_get_preview / gimp_get_histogram / gimp_compare — the verification
 * primitives (group `verify`, same as their `ps_*` counterparts).
 *
 * Every rendered file here is a path the TOOL LAYER generates inside the
 * session's own temp root (`GimpBackend.latestPreviewPath()` /
 * `.tempPath()`) — never a caller-supplied path, by design, so a caller
 * can never point a render at an arbitrary filesystem location.
 * `gimp_get_preview` always refreshes the well-known
 * `latest-preview.jpg` (the human-follows-along file) and honours
 * `privacy.send_previews_to_llm` exactly like the intended contract for the
 * `ps_*` preview tools: when it's `false`, no image bytes are returned to
 * the model, only the numeric/text result and the on-disk path.
 */

const CHANNELS = ['luminance', 'red', 'green', 'blue'] as const;

/** Injectable seam so tests never depend on the developer machine's real settings.json. */
export interface GimpVerifyToolsDeps {
  /** Defaults to reading `privacy.send_previews_to_llm` from the real settings.json. */
  previewsAllowed?: () => boolean;
}

const defaultPreviewsAllowed = (): boolean => loadSettings().settings.privacy.send_previews_to_llm;

// ---------- gimp_get_preview ----------

const previewSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    image: GIMP_IMAGE_PROP,
    max_px: GIMP_MAX_PX_PROP,
    region: {
      ...GIMP_REGION_PROP,
      description:
        GIMP_REGION_PROP.description +
        ' When given, renders a full-resolution crop of just that region (exact for spatial ' +
        'filters, unlike the default whole-image proxy).',
    },
  },
  required: ['image'],
};

async function gimpGetPreview(
  gimp: GimpBackend,
  rawArgs: Record<string, unknown>,
  previewsAllowedFn: () => boolean
): Promise<ToolResult> {
  try {
    const args = validateArgs(previewSchema, rawArgs);
    await gimp.prepare(); // a late-found install must be in place before the path helper runs
    const outPath = gimp.latestPreviewPath(); // the session's own well-known path — never caller-supplied
    const result = await gimp.call<{ width: number; height: number; proxy: boolean }>('preview', {
      image: args.image,
      max_px: args.max_px,
      region: args.region,
      out_path: outPath,
    });
    const allowed = previewsAllowedFn();
    const proxyNote = result.proxy
      ? ' (downscaled proxy render — per-pixel filters exact, spatial filters approximate)'
      : ' (full-resolution region render — exact)';
    const content: ToolResult['content'] = [];
    if (allowed) {
      const bytes = await readFile(outPath);
      content.push({
        type: 'image' as const,
        data: bytes.toString('base64'),
        mimeType: 'image/jpeg',
      });
    }
    content.push({
      type: 'text' as const,
      text:
        `Preview ${result.width}x${result.height}${proxyNote}. ` +
        (allowed
          ? `Also written to ${outPath}.`
          : `privacy.send_previews_to_llm is false — image not returned to the model; written to ${outPath}.`),
    });
    return { content, structuredContent: { ...result, path: outPath } };
  } catch (error) {
    return toolGimpErrorResult('Error rendering GIMP preview', error);
  }
}

// ---------- gimp_get_histogram ----------

const histogramSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    image: GIMP_IMAGE_PROP,
    channels: {
      type: 'array',
      items: { type: 'string', enum: [...CHANNELS] },
      description: 'Default: all four (luminance, red, green, blue) in ONE render.',
    },
    exact: {
      type: 'boolean',
      default: false,
      description:
        'false (default): computed on the 1024px proxy render (~0.3s) — good for iterating, but ' +
        'small clipped highlights can be under-counted. true: full-resolution composite (~4s on ' +
        '24MP) — the trustworthy final clipping check before export.',
    },
    region: {
      ...GIMP_REGION_PROP,
      description:
        GIMP_REGION_PROP.description +
        ' Computed on the proxy when it maps to a big-enough proxy area, else auto-falls back to a ' +
        'full-resolution crop; exact:true always forces the full-resolution crop.',
    },
  },
  required: ['image'],
};

async function gimpGetHistogram(
  gimp: GimpBackend,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(histogramSchema, rawArgs);
    const result = await gimp.call<{
      exact: boolean;
      width: number;
      height: number;
      pixels: number;
      channels: Record<
        string,
        { mean: number; median: number; p1: number; p5: number; p95: number; p99: number }
      >;
    }>('histogram', pickSchemaDeclaredKeys(histogramSchema, args));
    const summary = Object.entries(result.channels)
      .map(
        ([ch, s]) =>
          `${ch}: mean=${s.mean.toFixed(1)} median=${s.median} p1=${s.p1} p5=${s.p5} p95=${s.p95} p99=${s.p99}`
      )
      .join(', ');
    return {
      content: [
        {
          type: 'text' as const,
          text: `Histogram (${result.exact ? 'exact' : 'proxy'}, ${result.pixels.toLocaleString()} px): ${summary}`,
        },
      ],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  } catch (error) {
    return toolGimpErrorResult('Error reading GIMP histogram', error);
  }
}

// ---------- gimp_compare ----------

const compareSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    image: GIMP_IMAGE_PROP,
    mode: {
      type: 'string',
      enum: ['before_after', 'regions'],
      description:
        "'before_after': proxy base (no filters) vs proxy+filters, whole-image or `region` — " +
        "per-channel stat deltas. 'regions': two rects on the SAME (filtered) image, stats for " +
        'each, no delta (compare them yourself).',
    },
    channels: {
      type: 'array',
      items: { type: 'string', enum: [...CHANNELS] },
      description: 'Default: all four.',
    },
    region: {
      ...GIMP_REGION_PROP,
      description:
        'before_after only. Restricts the comparison to this rectangle; default whole image.',
    },
    max_px: {
      ...GIMP_MAX_PX_PROP,
      description: 'before_after only. ' + (GIMP_MAX_PX_PROP.description ?? ''),
    },
    include_previews: {
      type: 'boolean',
      default: false,
      description:
        'before_after only. Also return paired before/after preview images (subject to ' +
        'privacy.send_previews_to_llm, same as gimp_get_preview).',
    },
    region_a: { ...GIMP_REGION_PROP, description: 'regions only. First rectangle.' },
    region_b: { ...GIMP_REGION_PROP, description: 'regions only. Second rectangle.' },
  },
  required: ['image', 'mode'],
};

async function gimpCompare(
  gimp: GimpBackend,
  rawArgs: Record<string, unknown>,
  previewsAllowedFn: () => boolean
): Promise<ToolResult> {
  try {
    const args = validateArgs(compareSchema, rawArgs);
    const mode = args.mode as string;
    // Unreachable while the schema's own enum stands (validateArgs already
    // refused anything outside it) — kept as defense-in-depth, the same
    // posture every other consolidated ps_* dispatcher takes.
    if (mode !== 'before_after' && mode !== 'regions') {
      return unknownDiscriminator('mode', mode, ['before_after', 'regions']);
    }

    if (mode === 'regions') {
      const result = await gimp.call<{ region_a: unknown; region_b: unknown; proxy: boolean }>(
        'compare',
        {
          image: args.image,
          mode,
          channels: args.channels,
          region_a: args.region_a,
          region_b: args.region_b,
        }
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Compared region_a vs region_b (full-resolution, exact).',
          },
        ],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }

    const wantsPreviews = Boolean(args.include_previews) && previewsAllowedFn();
    if (wantsPreviews) await gimp.prepare();
    const beforePath = wantsPreviews
      ? gimp.tempPath(`compare-before-${randomUUID()}.jpg`)
      : undefined;
    const afterPath = wantsPreviews
      ? gimp.tempPath(`compare-after-${randomUUID()}.jpg`)
      : undefined;
    try {
      const result = await gimp.call<{
        before: Record<string, { mean: number }>;
        after: Record<string, { mean: number }>;
        delta: Record<string, { mean: number }>;
        proxy: boolean;
        before_path?: string;
        after_path?: string;
      }>('compare', {
        image: args.image,
        mode,
        channels: args.channels,
        region: args.region,
        max_px: args.max_px,
        before_path: beforePath,
        after_path: afterPath,
      });
      const deltaSummary = Object.entries(result.delta)
        .map(([ch, d]) => `${ch} Δmean=${d.mean >= 0 ? '+' : ''}${d.mean}`)
        .join(', ');
      const content: ToolResult['content'] = [];
      const previewsWithheld = Boolean(args.include_previews) && !wantsPreviews;
      if (wantsPreviews && beforePath && afterPath) {
        const [beforeBytes, afterBytes] = await Promise.all([
          readFile(beforePath),
          readFile(afterPath),
        ]);
        content.push({
          type: 'image' as const,
          data: beforeBytes.toString('base64'),
          mimeType: 'image/jpeg',
        });
        content.push({
          type: 'image' as const,
          data: afterBytes.toString('base64'),
          mimeType: 'image/jpeg',
        });
      }
      content.push({
        type: 'text' as const,
        text:
          `Before/after deltas: ${deltaSummary}` +
          (previewsWithheld
            ? ' (include_previews was requested but privacy.send_previews_to_llm is false — no image returned.)'
            : ''),
      });
      return { content, structuredContent: result as unknown as Record<string, unknown> };
    } finally {
      if (beforePath) await rm(beforePath, { force: true }).catch(() => undefined);
      if (afterPath) await rm(afterPath, { force: true }).catch(() => undefined);
    }
  } catch (error) {
    return toolGimpErrorResult('Error comparing GIMP regions', error);
  }
}

export function createGimpVerifyTools(
  gimp: GimpBackend,
  deps: GimpVerifyToolsDeps = {}
): ToolDefinition[] {
  const previewsAllowedFn = deps.previewsAllowed ?? defaultPreviewsAllowed;
  return [
    {
      tool: {
        name: 'gimp_get_preview',
        description:
          'Render the image with live filters applied and return it as a JPEG so you can look at ' +
          'it — fast (~0.25-0.45s at 1024px). Also always refreshes the well-known ' +
          'latest-preview.jpg file (the headless session has no visible window; this is how a ' +
          'human follows along). Previews are ~96% of returned bytes — prefer gimp_get_histogram ' +
          'for a parametric check (did the tone actually move?) and reach for this one for spatial ' +
          'questions. `region` renders a full-resolution crop instead of the whole-image proxy — ' +
          'exact for spatial filters rather than approximate. Respects privacy.send_previews_to_llm: ' +
          'when disabled, no image bytes are returned, only the render path + dimensions.',
        inputSchema: previewSchema,
        outputSchema: {
          type: 'object',
          properties: {
            width: { type: 'number' },
            height: { type: 'number' },
            proxy: { type: 'boolean' },
            path: { type: 'string' },
          },
        },
        annotations: {
          title: 'Render GIMP Preview',
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      handler: async (args) => gimpGetPreview(gimp, args, previewsAllowedFn),
    },
    {
      tool: {
        name: 'gimp_get_histogram',
        description:
          'Statistics for several channels from ONE render: mean, median, 1st/5th/95th/99th ' +
          "percentiles, and a 16-bucket histogram per channel, 0-255 scale. luminance uses babl's " +
          'D50 perceptual weights. Default is fast (~0.3s, the 1024px proxy render) — good for ' +
          'iterating, but small clipped highlights can be under-counted; pass exact: true (~4s on ' +
          '24MP) as the final clipping check before gimp_export.',
        inputSchema: histogramSchema,
        outputSchema: {
          type: 'object',
          properties: {
            exact: { type: 'boolean' },
            width: { type: 'number' },
            height: { type: 'number' },
            pixels: { type: 'number' },
            channels: { type: 'object' },
          },
        },
        annotations: {
          title: 'Get GIMP Histogram',
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      handler: async (args) => gimpGetHistogram(gimp, args),
    },
    {
      tool: {
        name: 'gimp_compare',
        description:
          "mode='before_after': proxy base (no filters) vs proxy+filters — whole image or a " +
          '`region` — per-channel mean/percentile deltas, optionally with paired before/after ' +
          'preview images (include_previews). Previews are subject to privacy.send_previews_to_llm ' +
          "— when it's false, no image is returned even with include_previews:true, and the " +
          "result text says so explicitly. mode='regions': stats for two named rectangles on " +
          'the current (filtered) image — the gimp_* twin of ps_compare_regions.',
        inputSchema: compareSchema,
        outputSchema: {
          type: 'object',
          properties: {
            before: { type: 'object' },
            after: { type: 'object' },
            delta: { type: 'object' },
            region_a: { type: 'object' },
            region_b: { type: 'object' },
            proxy: { type: 'boolean' },
          },
        },
        annotations: {
          title: 'Compare GIMP Regions',
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      handler: async (args) => gimpCompare(gimp, args, previewsAllowedFn),
    },
  ];
}
