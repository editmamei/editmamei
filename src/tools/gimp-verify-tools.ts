import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { basename } from 'node:path';
import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import type { GimpBackend } from '../backends/gimp/backend.js';
import { validateArgs, type JsonSchemaObject } from '../utils/validate.js';
import { toolGimpErrorResult, unknownDiscriminator } from '../utils/tool-helpers.js';
import { loadSettings } from '../core/settings.js';
import { Logger } from '../utils/logger.js';
import { GimpError } from '../backends/gimp/errors.js';
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
 * session's own temp root (`GimpBackend.tempPath()`) — never a
 * caller-supplied path, by design, so a caller can never point a render at
 * an arbitrary filesystem location. `gimp_get_preview` renders to its own
 * per-call file, reads those bytes, then publishes them to the well-known
 * `latest-preview.jpg` (the human-follows-along file) with an atomic copy —
 * the shared file is never handed to GIMP to write in place, so two sessions
 * for one user can't return each other's pixels. It honours
 * `privacy.send_previews_to_llm` itself (the server also withholds images from
 * every tool's result, see core/preview-privacy.ts): when it's `false`, no
 * image bytes are returned to the model. Paths go back to the model as
 * basenames only (a full path carries the username).
 */

const logger = new Logger('GimpVerifyTools');

const CHANNELS = ['luminance', 'red', 'green', 'blue'] as const;

/**
 * Read a render GIMP was asked to write. A missing file becomes a plain `gimp_op_failed`: Node's
 * own error would name the temp path, which sits under the user's home folder.
 */
async function readRender(path: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch {
    throw new GimpError('gimp_op_failed', 'GIMP reported success but the render was not written');
  }
}

/** `lib.channel_stats`'s histogram: one bin per 8-bit level, index = the 0-255 value. */
export const HISTOGRAM_BIN_COUNT = 256;

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
    // A per-call file the session generates — never caller-supplied, and never the shared
    // latest-preview.jpg itself (see the file doc comment).
    const renderPath = gimp.tempPath(`preview-${randomUUID()}.jpg`);
    try {
      const result = await gimp.call<{
        width: number;
        height: number;
        proxy: boolean;
        unmirrored_filters?: string[];
      }>('preview', {
        image: args.image,
        max_px: args.max_px,
        region: args.region,
        out_path: renderPath,
      });
      const bytes = await readRender(renderPath);
      // Publishing the human-follows-along copy is best effort: the render itself succeeded, and
      // a failed rename (a viewer holding the file open on Windows, another session publishing at
      // the same moment) must not turn that into an error.
      const latestName = basename(gimp.latestPreviewPath());
      let published = true;
      try {
        gimp.copyToLatestPreview(renderPath);
      } catch (err) {
        published = false;
        logger.debug('could not refresh latest-preview.jpg', err);
      }
      const fileNote = published
        ? `written to ${latestName} in the session folder`
        : `${latestName} in the session folder could not be refreshed this time`;
      const allowed = previewsAllowedFn();
      const proxyNote = result.proxy
        ? ' (downscaled proxy render — per-pixel filters exact, spatial filters approximate)'
        : ' (full-resolution region render — exact)';
      const unmirroredNote =
        result.unmirrored_filters && result.unmirrored_filters.length > 0
          ? ` WARNING: ${result.unmirrored_filters.join(', ')} could not be rendered on this proxy and ${result.unmirrored_filters.length === 1 ? 'is' : 'are'} missing from it — check with gimp_get_preview at a full-resolution region, or gimp_export, before trusting this render.`
          : '';
      const content: ToolResult['content'] = [];
      if (allowed) {
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
            ? `Also ${fileNote}.`
            : `privacy.send_previews_to_llm is false — image not returned to the model; ${fileNote}.`) +
          unmirroredNote,
      });
      return { content, structuredContent: { ...result, path: published ? latestName : null } };
    } finally {
      await rm(renderPath, { force: true }).catch(() => undefined);
    }
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
        '24MP) — the trustworthy final clipping check before export. On a very large document ' +
        'true can take much longer; if it times out the GIMP session restarts and unsaved work is ' +
        'lost, so save (gimp_save_xcf) first.',
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
      unmirrored_filters?: string[];
    }>('histogram', pickSchemaDeclaredKeys(histogramSchema, args));
    const summary = Object.entries(result.channels)
      .map(
        ([ch, s]) =>
          `${ch}: mean=${s.mean.toFixed(1)} median=${s.median} p1=${s.p1} p5=${s.p5} p95=${s.p95} p99=${s.p99}`
      )
      .join(', ');
    const unmirroredNote =
      result.unmirrored_filters && result.unmirrored_filters.length > 0
        ? ` WARNING: ${result.unmirrored_filters.join(', ')} could not be rendered on this proxy — these stats are missing that filter's effect entirely. Pass exact: true for a trustworthy reading.`
        : '';
    return {
      content: [
        {
          type: 'text' as const,
          text: `Histogram (${result.exact ? 'exact' : 'proxy'}, ${result.pixels.toLocaleString()} px): ${summary}${unmirroredNote}`,
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
        unmirrored_filters?: string[];
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
      const unmirroredNote =
        result.unmirrored_filters && result.unmirrored_filters.length > 0
          ? ` WARNING: ${result.unmirrored_filters.join(', ')} could not be rendered on the "after" proxy — this delta is missing that filter's effect entirely.`
          : '';
      // The bridge echoes the before/after render paths; they are temp files removed below, and a
      // full path carries the username, so neither goes back to the model.
      const { before_path: _beforePath, after_path: _afterPath, ...reported } = result;
      const content: ToolResult['content'] = [];
      const previewsWithheld = Boolean(args.include_previews) && !wantsPreviews;
      if (wantsPreviews && beforePath && afterPath) {
        const [beforeBytes, afterBytes] = await Promise.all([
          readRender(beforePath),
          readRender(afterPath),
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
            : '') +
          unmirroredNote,
      });
      return { content, structuredContent: reported as unknown as Record<string, unknown> };
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
          'Headless GIMP: render the image with live filters applied and return it as a JPEG so ' +
          'you can look at it — fast (~0.25-0.45s at 1024px). Also always refreshes the ' +
          'latest-preview.jpg file in the session folder (the headless session has no visible ' +
          'window; this is how a human follows along). Previews are ~96% of returned bytes — ' +
          'prefer gimp_get_histogram for a parametric check (did the tone actually move?) and ' +
          'reach for this one for spatial questions. `region` renders a full-resolution crop ' +
          'instead of the whole-image proxy — exact for spatial filters rather than approximate. ' +
          'Respects privacy.send_previews_to_llm: when disabled, no image bytes are returned, only ' +
          'the dimensions and the preview file name.',
        inputSchema: previewSchema,
        outputSchema: {
          type: 'object',
          properties: {
            width: { type: 'number' },
            height: { type: 'number' },
            proxy: { type: 'boolean' },
            path: { type: ['string', 'null'] },
            unmirrored_filters: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Names of live filters GIMP refused to re-attach non-destructively on this proxy ' +
                'render — missing from this render entirely, not just approximated. Empty on a ' +
                'normal render, and always absent on a full-resolution region render ' +
                '(proxy: false), which never mirrors filters at all.',
            },
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
          'Headless GIMP: statistics for several channels from ONE render: mean, median, ' +
          `1st/5th/95th/99th percentiles, and a ${HISTOGRAM_BIN_COUNT}-bin histogram per channel ` +
          "(`bins[v]` = pixel count at value v, 0-255). luminance uses babl's D50 perceptual " +
          'weights. Default is fast (~0.3s, the 1024px proxy render) — good for iterating, but ' +
          'small clipped highlights can be under-counted; pass exact: true (~4s on 24MP) as the ' +
          'final clipping check before gimp_export.',
        inputSchema: histogramSchema,
        outputSchema: {
          type: 'object',
          properties: {
            exact: { type: 'boolean' },
            width: { type: 'number' },
            height: { type: 'number' },
            pixels: { type: 'number' },
            channels: {
              type: 'object',
              description: 'Keyed by channel name (luminance, red, green, blue).',
              additionalProperties: {
                type: 'object',
                properties: {
                  mean: { type: 'number' },
                  median: { type: 'number' },
                  p1: { type: 'number' },
                  p5: { type: 'number' },
                  p95: { type: 'number' },
                  p99: { type: 'number' },
                  bins: {
                    type: 'array',
                    items: { type: 'integer' },
                    minItems: HISTOGRAM_BIN_COUNT,
                    maxItems: HISTOGRAM_BIN_COUNT,
                    description: 'Pixel count per 8-bit value: bins[v] for v = 0..255.',
                  },
                },
              },
            },
            unmirrored_filters: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Names of live filters GIMP refused to re-attach on this proxy render — absent ' +
                'from these stats entirely. Present whenever histogram actually used the ' +
                '(mirrored) preview proxy: the default whole-image path, OR a `region` large ' +
                'enough to be sampled from the proxy rather than falling back to a full-' +
                'resolution crop. Absent when exact: true, or when a region is too small and ' +
                'falls back to that full-resolution crop — neither path mirrors filters at all.',
            },
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
          "Headless GIMP: mode='before_after': proxy base (no filters) vs proxy+filters — whole image or a " +
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
            unmirrored_filters: {
              type: 'array',
              items: { type: 'string' },
              description:
                'before_after only. Names of live filters GIMP refused to re-attach on the ' +
                '"after" proxy render — the delta above is missing that filter\'s effect entirely.',
            },
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
