import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import type { SnippetClient } from '../api/snippet-client.js';
import { SUPPORTED_BRUSH_TOOLS } from '../api/brush-tool-names.js';
import { runScript } from '../utils/run-script.js';
import { validateArgs, type JsonSchemaObject } from '../utils/validate.js';
import { toolErrorResult, applyToActiveLayerProp } from '../utils/tool-helpers.js';
import { type DetectionClient } from '../detection/detection-client.js';
import { OnnxLandmarkDetectionClient } from '../detection/landmark-detection-client.js';
import { resolveExpectedPlacement, PLACEMENT_SCHEMA } from '../perception/grounding-locate.js';

/**
 * ps_path — the path-interchange surface. One op-discriminated tool
 * (mirrors ps_select / ps_layer_mask) covering the round-trip
 * between selections and real editable PS vector paths, plus the path
 * consumers (stroke / fill / clip).
 *
 * All ops but `save` are backed by documented DOM PathItem methods, verifiable
 * by live-smoke. `save` uses the canonical "make named path from work path" AM
 * idiom whose descriptor is not yet ScriptListener-capture-verified — the whole
 * tool is dev-tier until live-verified against a real Photoshop.
 */

const PATH_OPS = [
  'create_from_selection',
  'create_from_placement',
  'save',
  'list',
  'delete',
  'load_as_selection',
  'stroke',
  'fill',
  'set_clipping',
] as const;

const SELECTION_TYPE_ENUM = ['replace', 'add', 'subtract', 'intersect'] as const;
const FILL_MODE_ENUM = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten'] as const;

const pathInputSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    op: {
      type: 'string',
      enum: [...PATH_OPS],
      description:
        'create_from_selection: convert the active selection into a work path (tolerance = crude↔detailed dial; CLEARS the selection). ' +
        'create_from_placement: NAME a curve (placement → a path relation: `along` a traced edge / landmark curve, or a `segment` between anchors) and get an editable, saved vector path following it — the grounded pen; needs `name` (+ optional `closed`). ' +
        'save: persist the current work path under a name (required for stroke/clip-by-name and to survive the next create). ' +
        'list: inventory all paths (name, kind, subpath + anchor counts) — read-only. ' +
        'delete: remove a path (name → that saved path; omit name → the current work path). ' +
        'load_as_selection: convert a path back into a selection (name → that saved path; omit → current work path; +feather, anti_alias, operation). ' +
        'stroke: paint along a path with a brush-family tool (+tool, apply_to_active_layer) — bakes pixels, auto-duplicates the layer. ' +
        'fill: fill a path region with a color (+color, opacity, mode, feather, anti_alias, apply_to_active_layer) — bakes pixels, auto-duplicates. ' +
        'set_clipping: mark a SAVED path as the clipping path (+flatness) — name required.',
    },
    name: {
      type: 'string',
      description:
        'Path name. REQUIRED for save, set_clipping, and create_from_placement (the new saved path is named). Optional for delete / load_as_selection / stroke / fill — when omitted those target the current work path. Ignored by create_from_selection / list.',
    },
    placement: {
      ...PLACEMENT_SCHEMA,
      description:
        'create_from_placement only: NAME the curve the path follows, as an anchor-relational placement that resolves to a PATH (relation `along` a traced edge / a Pro landmark curve, or a `segment` between two anchors). The spatial-grounding resolver + objective gate produce AND verify the curve; the path is created ONLY if the gate PASSES. Name the curve — do NOT hand-type anchor points.',
    },
    closed: {
      type: 'boolean',
      default: false,
      description:
        'create_from_placement only: close the path into a loop (connect the last anchor back to the first). Default false (an open path).',
    },
    tolerance: {
      type: 'number',
      description:
        'create_from_selection only: makeWorkPath tolerance in pixels (0.5 = hug every detail → 10 = crude). Default 2.',
      minimum: 0.5,
      maximum: 10,
      default: 2,
    },
    feather: {
      type: 'number',
      description:
        'load_as_selection / fill: soften the result edge by this many pixels. Default 0.',
      minimum: 0,
      default: 0,
    },
    anti_alias: {
      type: 'boolean',
      description: 'load_as_selection / fill: anti-alias the edge. Default true.',
      default: true,
    },
    operation: {
      type: 'string',
      enum: [...SELECTION_TYPE_ENUM],
      description:
        "load_as_selection only: how the loaded selection combines with any existing one. Default 'replace'.",
      default: 'replace',
    },
    tool: {
      type: 'string',
      enum: SUPPORTED_BRUSH_TOOLS,
      description:
        "stroke only: which brush-family tool paints the path. Default 'brush'. Same 16-tool set as ps_apply_brush_stroke.",
      default: 'brush',
    },
    color: {
      type: 'object',
      description: 'fill only: RGB fill color (each 0-255). Default black.',
      properties: {
        red: { type: 'integer', minimum: 0, maximum: 255, default: 0 },
        green: { type: 'integer', minimum: 0, maximum: 255, default: 0 },
        blue: { type: 'integer', minimum: 0, maximum: 255, default: 0 },
      },
    },
    opacity: {
      type: 'number',
      description: 'fill only: fill opacity percent (0-100). Default 100.',
      minimum: 0,
      maximum: 100,
      default: 100,
    },
    mode: {
      type: 'string',
      enum: [...FILL_MODE_ENUM],
      description: "fill only: blend mode for the fill. Default 'normal'.",
      default: 'normal',
    },
    flatness: {
      type: 'number',
      description:
        'set_clipping only: device-pixel flatness for the clipping path (0.2-100; higher = coarser curve approximation). Omit for the PS default.',
      minimum: 0.2,
      maximum: 100,
    },
    apply_to_active_layer: applyToActiveLayerProp('the stroke / fill op'),
  },
  required: ['op'],
};

export function createPathTools(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  // Backs anchor-relational `placement` on op=create_from_placement; only used when
  // a placement is supplied (the other ops never touch it). Mesh-capable default so
  // a landmark-curve path works in dev; degrades to CE boxes when the mesh is absent.
  client: DetectionClient = new OnnxLandmarkDetectionClient()
): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'ps_path',
        description:
          'Work with editable vector PATHS — the connective tissue between selections, brush strokes, and clipping. One op-discriminated tool: `create_from_selection` (selection → work path), `create_from_placement` (NAME a curve → editable saved path, the grounded pen), `save` (name the work path), `list`, `delete`, `load_as_selection` (path → selection), `stroke` (paint a brush-family tool along a path), `fill` (fill a path region), `set_clipping` (mark a saved path as the clipping path). **Reach for this when**: tracing a named curve (an edge, a landmark contour) into an editable path, turning a precise selection into a reusable/strokeable outline, converting a saved path back to a selection, or outlining/filling a shape exactly. create_from_selection and load_as_selection are an exact round-trip. stroke/fill bake pixels and auto-duplicate the target layer. Every op returns path_info (counts + per-path subpath/anchor totals) so you can verify the path landed; load_as_selection also returns selection_info.',
        inputSchema: pathInputSchema,
        outputSchema: {
          type: 'object',
          properties: {
            created: { type: 'boolean' },
            saved: { type: 'boolean' },
            deleted: { type: 'boolean' },
            loaded: { type: 'boolean' },
            stroked: { type: 'boolean' },
            filled: { type: 'boolean' },
            clipping_path_set: { type: 'boolean' },
            name: { type: 'string' },
            path_name: { type: 'string' },
            tolerance: { type: 'number' },
            anchors: { type: 'number' },
            closed: { type: 'boolean' },
            placement: { type: 'object' },
            selection_consumed: { type: 'boolean' },
            operation: { type: 'string' },
            tool: { type: 'string' },
            tool_type: { type: 'string' },
            mode: { type: 'string' },
            count: { type: 'number' },
            paths: { type: 'array' },
            target_was_copy: { type: 'boolean' },
            target_layer_name: { type: 'string' },
            original_layer_name: { type: 'string' },
            path_info: { type: 'object' },
            selection_info: { type: 'object' },
            context: { type: 'object' },
          },
        },
        annotations: {
          title: 'Paths',
          // stroke/fill bake pixels; create/save/delete mutate the path stack.
          destructiveHint: true,
          idempotentHint: false,
        },
      },
      handler: async (args) => runPathOp(connection, snippetClient, client, args),
    },
  ];
}

async function runPathOp(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  client: DetectionClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(pathInputSchema, rawArgs);
    const op = args.op as (typeof PATH_OPS)[number];
    const name = args.name as string | undefined;

    let snippet: string;
    let params: Record<string, unknown>;
    // Set by create_from_placement so the result echoes the resolved+gated curve.
    let placementInfo:
      | { curve: { x: number; y: number }[]; anchors: Record<string, unknown>; summary: string }
      | undefined;

    switch (op) {
      case 'create_from_selection':
        snippet = 'createPathFromSelection';
        params = { tolerance: args.tolerance as number };
        break;
      case 'create_from_placement': {
        if (!name)
          return errorResult(
            'create_from_placement requires a "name" for the new saved path (pathItems.add needs one).'
          );
        const rp = await resolveExpectedPlacement(
          connection,
          client,
          args.placement,
          'path',
          'path'
        );
        snippet = 'createPathFromPoints';
        params = { name, points: rp.curve, closed: (args.closed as boolean) ?? false };
        placementInfo = { curve: rp.curve, anchors: rp.anchors, summary: rp.summary };
        break;
      }
      case 'save':
        if (!name) return missingName('save');
        snippet = 'savePath';
        params = { name };
        break;
      case 'list':
        snippet = 'listPaths';
        params = {};
        break;
      case 'delete':
        snippet = 'deletePath';
        params = name ? { name } : {};
        break;
      case 'load_as_selection':
        snippet = 'loadPathAsSelection';
        params = {
          ...(name ? { name } : {}),
          feather: args.feather as number,
          antiAlias: args.anti_alias as boolean,
          operation: args.operation as string,
        };
        break;
      case 'stroke':
        snippet = 'strokePath';
        params = {
          ...(name ? { name } : {}),
          tool: args.tool as string,
          applyToActiveLayer: args.apply_to_active_layer as boolean,
        };
        break;
      case 'fill': {
        const color = (args.color as { red?: number; green?: number; blue?: number }) ?? {};
        snippet = 'fillPath';
        params = {
          ...(name ? { name } : {}),
          red: color.red ?? 0,
          green: color.green ?? 0,
          blue: color.blue ?? 0,
          opacity: args.opacity as number,
          mode: args.mode as string,
          feather: args.feather as number,
          antiAlias: args.anti_alias as boolean,
          applyToActiveLayer: args.apply_to_active_layer as boolean,
        };
        break;
      }
      case 'set_clipping':
        if (!name) return missingName('set_clipping');
        snippet = 'setClippingPath';
        params = {
          name,
          ...(args.flatness !== undefined ? { flatness: args.flatness as number } : {}),
        };
        break;
      default:
        return {
          content: [{ type: 'text' as const, text: `Unknown path op: ${String(op)}` }],
          isError: true,
        };
    }

    const script = await snippetClient.build(snippet, params);
    const result = (await runScript(connection, script)) as Record<string, unknown>;

    if (placementInfo) {
      result.placement = {
        target: 'path',
        gate: { pass: true },
        anchors: placementInfo.anchors,
        points: placementInfo.curve.length,
        summary: placementInfo.summary,
      };
    }

    const text = placementInfo
      ? `${summarize(op, result)} Path follows the resolved ${placementInfo.summary} (placement gate PASS).`
      : summarize(op, result);
    return {
      content: [{ type: 'text' as const, text }],
      structuredContent: result,
    };
  } catch (error) {
    return toolErrorResult('Error in ps_path', error);
  }
}

function missingName(op: string): ToolResult {
  return {
    content: [
      {
        type: 'text' as const,
        text: `ps_path op=${op} requires a "name" (the saved path to act on). Use op=save to name the current work path first.`,
      },
    ],
    isError: true,
  };
}

function errorResult(msg: string): ToolResult {
  return { content: [{ type: 'text' as const, text: `ps_path: ${msg}` }], isError: true };
}

function summarize(op: string, r: Record<string, unknown>): string {
  const info = r.path_info as { count?: number } | undefined;
  const pathCount = info?.count ?? (r.count as number | undefined);
  const suffix =
    pathCount !== undefined ? ` (${pathCount} path${pathCount === 1 ? '' : 's'} now)` : '';
  switch (op) {
    case 'create_from_selection':
      return `Created a work path from the selection (tolerance ${r.tolerance}); the selection was consumed.${suffix}`;
    case 'create_from_placement':
      return `Created editable path "${r.name}" from the named curve (${r.anchors} anchors${r.closed ? ', closed' : ''}).${suffix}`;
    case 'save':
      return `Saved path "${r.name}".${suffix}`;
    case 'list':
      return `${r.count ?? 0} path(s) in the document.`;
    case 'delete':
      return `Deleted path "${r.name}".${suffix}`;
    case 'load_as_selection':
      return `Loaded path "${r.path_name}" as a selection (${r.operation}).`;
    case 'stroke':
      return `Stroked path "${r.path_name}" with ${r.tool} on ${
        r.target_was_copy ? `copy "${r.target_layer_name}"` : `layer "${r.target_layer_name}"`
      }.`;
    case 'fill':
      return `Filled path "${r.path_name}" (${r.mode}) on ${
        r.target_was_copy ? `copy "${r.target_layer_name}"` : `layer "${r.target_layer_name}"`
      }.`;
    case 'set_clipping':
      return `Set "${r.name}" as the clipping path.${suffix}`;
    default:
      return 'Path op complete.';
  }
}
