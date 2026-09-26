/**
 * Shared schema fragments + the dispatch stereotype for every `gimp_*` tool
 * file — the GIMP-backend sibling of `tool-helpers.ts`'s `runSnippetTool`.
 *
 * Common input types shared across the gimp_* surface: `image` (an integer
 * id from `gimp_open_document`), `layer` (optional name, defaulting to
 * selected/top — `ops.py`'s `_layer`), and `region` (`{x,y,width,height}` in
 * document pixels, bounds-checked by the bridge, not here).
 */

import type { GimpBackend } from '../backends/gimp/backend.js';
import type { ToolResult } from '../core/tool-registry.js';
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

export async function runGimpTool(spec: GimpToolSpec): Promise<ToolResult> {
  try {
    const args = validateArgs(spec.schema, spec.rawArgs);
    const bridgeArgs = spec.params ? spec.params(args) : pickSchemaDeclaredKeys(spec.schema, args);
    const result = await spec.gimp.call<Record<string, unknown>>(spec.op, bridgeArgs);
    return {
      content: [{ type: 'text' as const, text: spec.successText(result, args) }],
      structuredContent: result,
    };
  } catch (error) {
    return toolGimpErrorResult(spec.errorPrefix, error);
  }
}
