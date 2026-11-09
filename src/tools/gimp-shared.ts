/**
 * Shared schema fragments + the dispatch stereotype for every `gimp_*` tool
 * file — the GIMP-backend sibling of `tool-helpers.ts`'s `runSnippetTool`.
 *
 * Common input types shared across the gimp_* surface: `image` (an integer
 * id from `gimp_open_document`), `layer` (optional name, defaulting to
 * selected/top — `ops.py`'s `_layer`), and `region` (`{x,y,width,height}` in
 * document pixels, bounds-checked by the bridge, not here).
 */

import { readFile } from 'node:fs/promises';
import type { GimpBackend } from '../backends/gimp/backend.js';
import type { ToolResult } from '../core/tool-registry.js';
import { loadSettings } from '../core/settings.js';
import { GimpError } from '../backends/gimp/errors.js';
import { validateArgs, type JsonSchemaObject, type JsonSchemaProperty } from '../utils/validate.js';
import { toolGimpErrorResult } from '../utils/tool-helpers.js';

/** Every image-scoped op's required `image` id — the id `gimp_open_document` returns. */
export const GIMP_IMAGE_PROP: JsonSchemaProperty = {
  type: 'integer',
  description: 'Image id, as returned by gimp_open_document.',
};

/** Optional target layer — defaults to the selected layer, or the topmost layer if none is selected. */
export const GIMP_LAYER_PROP: JsonSchemaProperty = {
  type: 'string',
  description:
    'Layer name. Defaults to the selected layer, or the topmost layer if none is selected.',
};

/** The canonical layer handle layer-creating results and gimp_inspect report. Declared wherever
 * GIMP_LAYER_PROP is: an undeclared key is dropped before it reaches the bridge, which would
 * silently retarget the call at the selected layer. The description names only community-tier
 * tools (the CE leak guard reads it). */
export const GIMP_LAYER_ID_PROP: JsonSchemaProperty = {
  type: 'integer',
  minimum: 1,
  maximum: 2_147_483_647,
  description:
    'Layer id, as gimp_inspect (and any tool that creates a layer) reports it. Takes priority ' +
    'over `layer`, and is the only way to address one of two layers that share a name.',
};

/** A document-pixel rectangle — the bridge refuses one that lies partly or fully outside the image. */
export const GIMP_REGION_PROP: JsonSchemaProperty = {
  type: 'object',
  description:
    'A rectangle in document pixels: {x, y, width, height}. Must lie entirely within the image ' +
    '— a region partly or fully outside it is refused rather than silently clamped.',
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
    width: { type: 'number' },
    height: { type: 'number' },
  },
  required: ['x', 'y', 'width', 'height'],
};

/** An image's color space, as gimp_open_document, gimp_inspect and gimp_export report it. */
export interface GimpColorProfile {
  space: string;
  name: string | null;
  wide_gamut: boolean;
  /** gimp_export only: whether the written file carries the profile. */
  embedded?: boolean;
  /** gimp_export only: the space the copy was converted from, or null when it was not converted. */
  converted_from?: string | null;
}

/** An outputSchema fragment (not an input property: it uses nullable types). */
export const GIMP_COLOR_PROFILE_SCHEMA = {
  type: 'object',
  description:
    "The image's color space: space is srgb, display-p3, dci-p3, adobe-rgb, prophoto-rgb, rec2020, " +
    "gray or other; name is the profile's own name (null for plain sRGB); wide_gamut is true " +
    'when the space holds colors sRGB cannot show.',
  properties: {
    space: { type: 'string' },
    name: { type: ['string', 'null'] },
    wide_gamut: { type: 'boolean' },
    embedded: { type: 'boolean' },
    converted_from: { type: ['string', 'null'] },
  },
};

const SPACE_LABELS: Record<string, string> = {
  srgb: 'sRGB',
  'display-p3': 'Display P3',
  'dci-p3': 'DCI-P3',
  'adobe-rgb': 'Adobe RGB',
  'prophoto-rgb': 'ProPhoto RGB',
  rec2020: 'Rec. 2020',
  gray: 'grayscale',
  other: 'a custom color profile',
};

export function colorSpaceLabel(space: string): string {
  return SPACE_LABELS[space] ?? space;
}

/** "Display P3 (wider than sRGB)" — the open/inspect summary's color clause. */
export function colorProfileText(profile: GimpColorProfile | undefined): string {
  if (!profile) return '';
  const label =
    profile.space === 'other' && profile.name
      ? `"${profile.name}"`
      : colorSpaceLabel(profile.space);
  return profile.wide_gamut ? `${label} (wider than sRGB)` : label;
}

/** The export result's color sentence. */
export function exportedProfileText(profile: GimpColorProfile | undefined): string {
  if (!profile) return '';
  const label = colorProfileText(profile);
  const from = profile.converted_from
    ? `Converted from ${colorSpaceLabel(profile.converted_from)} to ${label}; `
    : `Color: ${label}; `;
  return (
    from +
    (profile.embedded
      ? 'the profile is embedded so viewers show the colors as edited.'
      : profile.space === 'gray'
        ? 'written with no profile, which viewers read as standard gray.'
        : 'written as plain sRGB with no profile, which every viewer assumes.')
  );
}

/** `gimp_get_preview` / `gimp_compare`'s proxy render size — bounded so the in-GIMP proxy cache stays small. */
export const GIMP_MAX_PX_PROP: JsonSchemaProperty = {
  type: 'integer',
  enum: [512, 1024, 2048],
  default: 1024,
  description: 'Long-edge cap for the proxy render, in pixels.',
};

/**
 * The `validate → call the bridge → return` stereotype every simple gimp_*
 * handler follows — the sibling of `runSnippetTool` for ps_* tools. Handlers
 * that dispatch more than one op, or post-process the result beyond text
 * formatting, keep their own body and call `toolGimpErrorResult` directly
 * (same split `runSnippetTool` / `toolErrorResult` draw on the ps_* side).
 */
export interface GimpToolSpec {
  gimp: GimpBackend;
  rawArgs: Record<string, unknown>;
  schema: JsonSchemaObject;
  /** bridge op name (see `bridge/ops.py`'s `OPS` table) passed to `gimp.call`. */
  op: string;
  /** Error-text prefix, e.g. `"Error opening GIMP document"`. */
  errorPrefix: string;
  /** Map validated args to bridge args. Defaults to passing the validated args through unchanged. */
  params?: (args: Record<string, unknown>) => Record<string, unknown>;
  /** Human-readable text block for the success result. */
  successText: (result: unknown, args: Record<string, unknown>) => string;
}

/**
 * `validateArgs` deliberately passes through any key NOT named in the
 * schema's own `properties` — its own doc comment explains why (an MCP
 * client may attach metadata that isn't the tool's business to validate).
 * That's the right call for a Photoshop tool whose handler reads only the
 * fields it names, but `runGimpTool`'s DEFAULT (no `params` mapper) forwards
 * whatever `validateArgs` returns straight to the bridge as-is — so without
 * this filter, an undeclared key would ride along into `gimp.call()`
 * unfiltered. Keeps only the keys the schema actually declares.
 */
export function pickSchemaDeclaredKeys(
  schema: JsonSchemaObject,
  args: Record<string, unknown>
): Record<string, unknown> {
  const declared = new Set(Object.keys(schema.properties ?? {}));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (declared.has(key)) out[key] = value;
  }
  return out;
}

/**
 * Read a render GIMP was asked to write. A missing file becomes a plain `gimp_op_failed`: Node's
 * own error would name the temp path, which sits under the user's home folder. Shared by every
 * gimp_* tool that renders to its own per-call temp file (gimp_get_preview, gimp_compare,
 * gimp_get_selection_preview) rather than each re-wrapping `readFile` the same way.
 */
export async function readRender(path: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch {
    throw new GimpError('gimp_op_failed', 'GIMP reported success but the render was not written');
  }
}

/** Injectable seam so tests never depend on the developer machine's real settings.json — shared
 * by every gimp_* tool that returns image bytes and must honour `privacy.send_previews_to_llm`. */
export interface GimpPreviewDeps {
  /** Defaults to reading `privacy.send_previews_to_llm` from the real settings.json. */
  previewsAllowed?: () => boolean;
}

export const defaultPreviewsAllowed = (): boolean =>
  loadSettings().settings.privacy.send_previews_to_llm;

/** Appended to a rotate/flip/resize result's text when the bridge reports `effect_update_failures`
 * -- a live GEGL update that failed partway through applying the geometry transform to one of
 * gimp_add_effect's filters. The filter's OWN params are kept at their OLD position/angle/offset/
 * size in the ledger (guaranteed, bridge/ops.py's `_apply_planned_effect_transform`), and the
 * bridge also tries to restore those same OLD values to the live render (best effort -- it just
 * didn't move with the rest of the image, though rarely even that restore can fail too). */
export function effectUpdateFailuresNote(failures: string[] | undefined): string {
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

/**
 * A client may show only `structuredContent` when a result has it, so a warning the model must act
 * on goes there too. Takes the warning itself, not text around it: a layer name can say anything.
 */
export function withWarning<T extends object>(
  structured: T,
  note: string
): T & { warning?: string } {
  const warning = note.trim();
  return warning ? { ...structured, warning } : structured;
}

export async function runGimpTool(spec: GimpToolSpec): Promise<ToolResult> {
  try {
    const args = validateArgs(spec.schema, spec.rawArgs);
    const bridgeArgs = spec.params ? spec.params(args) : pickSchemaDeclaredKeys(spec.schema, args);
    const result = await spec.gimp.call<Record<string, unknown>>(spec.op, bridgeArgs);
    return {
      content: [{ type: 'text' as const, text: spec.successText(result, args) }],
      structuredContent: withWarning(
        result,
        effectUpdateFailuresNote(result.effect_update_failures as string[] | undefined)
      ),
    };
  } catch (error) {
    return toolGimpErrorResult(spec.errorPrefix, error);
  }
}
