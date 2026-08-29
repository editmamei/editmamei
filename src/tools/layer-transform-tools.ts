/**
 * Community tools — layer-transform surface.
 *
 * Four positioning + transform tools: fit_layer_to_document, scale_layer,
 * move_layer, rotate_layer. All four are classified 'community' in
 * src/core/tool-tiers.ts (previously 'pro',
 * in layer-transform-tools-pro.ts). Straightening / repositioning a layer is
 * a foundational photo-correction primitive, so it ships in CE; the file
 * therefore lives outside the *-pro.ts stub set and registers via the shared
 * CE factory list in server.ts. The matching go-core emitters moved out of
 * the //go:build pro tag in the same change.
 */
import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import type { SnippetClient } from '../api/snippet-client.js';
import { runScript } from '../utils/run-script.js';
import { validateArgs, type JsonSchemaObject, type JsonSchemaProperty } from '../utils/validate.js';
import { type DetectionClient } from '../detection/detection-client.js';
import { OnnxLandmarkDetectionClient } from '../detection/landmark-detection-client.js';
import { resolveExpectedPlacement, PLACEMENT_SCHEMA } from '../perception/grounding-locate.js';
import { toolErrorResult, runSnippetTool } from '../utils/tool-helpers.js';

const fitLayerToDocumentSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    mode: {
      type: 'string',
      enum: ['fit', 'fill'],
      description:
        '`fit` (default) scales the layer to fit inside the canvas while preserving aspect — letterboxes on the short edge. `fill` covers the entire canvas — crops on the long edge. Both preserve aspect ratio and center the layer.',
      default: 'fit',
    },
  },
};

const scaleLayerSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    scale_percent: {
      type: 'number',
      description:
        'Uniform scale percentage (e.g. 50 = 50%, 200 = 200%). Use for proportional scaling.',
      minimum: 1,
    },
    scale_x_percent: {
      type: 'number',
      description:
        'Non-uniform: horizontal scale percentage. Pair with scale_y_percent to stretch/squash (the #1 pixel-stretch effect). If only one axis is given the other defaults to 100%.',
      minimum: 1,
    },
    scale_y_percent: {
      type: 'number',
      description: 'Non-uniform: vertical scale percentage. Pair with scale_x_percent.',
      minimum: 1,
    },
    center_anchor: {
      type: 'boolean',
      description: 'Scale from center (true) or top-left (false). Default: true.',
      default: true,
    },
  },
};

const flipLayerSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    axis: {
      type: 'string',
      enum: ['horizontal', 'vertical'],
      description: "'horizontal' mirrors left-right; 'vertical' mirrors top-bottom.",
    },
  },
  required: ['axis'],
};

// Three positioning modes, exactly one chosen.
// Mutual exclusivity is validated handler-side because JSON Schema's
// oneOf doesn't compose with our minimal validator. The schema lists
// every field so the LLM sees all options; the handler asserts exactly
// one (delta / absolute / center_on) pair is set.
const moveLayerSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    delta_x: {
      type: 'number',
      description:
        "RELATIVE mode: horizontal pixel offset from the layer's current position. Pair with delta_y. Mutually exclusive with absolute_*/center_on_*.",
    },
    delta_y: {
      type: 'number',
      description:
        "RELATIVE mode: vertical pixel offset from the layer's current position. Pair with delta_x.",
    },
    absolute_x: {
      type: 'number',
      description:
        "ABSOLUTE mode: target X for the layer's bounds top-left corner, in document pixels. Pair with absolute_y. Use when you know exactly where the top-left should land. Mutually exclusive with delta_* / center_on_*.",
    },
    absolute_y: {
      type: 'number',
      description:
        "ABSOLUTE mode: target Y for the layer's bounds top-left corner, in document pixels. Pair with absolute_x.",
    },
    center_on_x: {
      type: 'number',
      description:
        "CENTER mode: target X for the layer's bounds CENTER point, in document pixels. Pair with center_on_y. Use when placing a layer inside a known region (e.g. a frame opening). Mutually exclusive with delta_* / absolute_*.",
    },
    center_on_y: {
      type: 'number',
      description:
        "CENTER mode: target Y for the layer's bounds CENTER point, in document pixels. Pair with center_on_x.",
    },
    placement: {
      ...PLACEMENT_SCHEMA,
      description:
        'ANCHOR-RELATIONAL move (preferred over guessing a pixel): a POINT relation (centroid/midpoint/offset) → ' +
        'the layer\'s CENTER is moved to the resolved, gate-verified point (e.g. "center this layer on the detected ' +
        'subject" / "…in the gap between the two people"). Moves ONLY if the gate PASSES. When set, delta_*/' +
        'absolute_*/center_on_* are ignored. See the placement-resolver tool, when this build has one, for the ' +
        'anchors + relation vocabulary.',
    },
  },
};

const rotateLayerSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    degrees: {
      type: 'number',
      description:
        'Rotation angle in degrees (positive = clockwise, negative = counter-clockwise).',
    },
  },
  required: ['degrees'],
};

// M2 (2026-06-21): raw-AM Trnf matrix ops — skew + free-numeric. New
// territory: the scale/rotate/move ops above are DOM-based; skew and the warp
// family have no DOM equivalent. Both reuse scale_x_percent/scale_y_percent
// (width/height %) and degrees (rotation); skew adds slant angles, free adds
// translation. dev-tier until live-verified.
const matrixExtraProps: Record<string, JsonSchemaProperty> = {
  skew_h_degrees: {
    type: 'number',
    description:
      'op=skew: horizontal skew (slant) angle in degrees — positive slants the top edge right. At least one of skew_h_degrees / skew_v_degrees is required for op=skew.',
  },
  skew_v_degrees: {
    type: 'number',
    description:
      'op=skew: vertical skew (slant) angle in degrees — positive slants the left edge down.',
  },
  offset_x: {
    type: 'number',
    description: 'op=skew/free: horizontal translation in pixels (default 0).',
    default: 0,
  },
  offset_y: {
    type: 'number',
    description: 'op=skew/free: vertical translation in pixels (default 0).',
    default: 0,
  },
};

// Per-op validation schemas (shape mirrors scaleLayerSchema etc.). They reuse
// the existing scale_x_percent / scale_y_percent / degrees definitions so the
// merged tool schema declares each field once.
const sharedScaleX = scaleLayerSchema.properties!.scale_x_percent;
const sharedScaleY = scaleLayerSchema.properties!.scale_y_percent;
const sharedDegrees = rotateLayerSchema.properties!.degrees;

const skewLayerSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    skew_h_degrees: matrixExtraProps.skew_h_degrees,
    skew_v_degrees: matrixExtraProps.skew_v_degrees,
    scale_x_percent: sharedScaleX,
    scale_y_percent: sharedScaleY,
    degrees: sharedDegrees,
    offset_x: matrixExtraProps.offset_x,
    offset_y: matrixExtraProps.offset_y,
  },
};

const freeLayerSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    scale_x_percent: sharedScaleX,
    scale_y_percent: sharedScaleY,
    degrees: sharedDegrees,
    offset_x: matrixExtraProps.offset_x,
    offset_y: matrixExtraProps.offset_y,
  },
};

const TRANSFORM_OPS = ['fit', 'scale', 'move', 'rotate', 'flip', 'skew', 'free'] as const;

// Consolidated input schema for ps_transform_layer (Phase 1, 2026-06-20).
// Merges the five per-op schemas; no field-name collisions across them. The
// per-op handler re-validates against its exact schema (defaults, required
// fields, the move-mode mutual-exclusivity check).
const TRANSFORM_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    op: {
      type: 'string',
      enum: [...TRANSFORM_OPS],
      description:
        'Which transform to apply to the active layer. ' +
        'fit: scale to fit/fill the canvas + center (mode fit|fill). ' +
        'scale: uniform scale_percent OR non-uniform scale_x_percent/scale_y_percent (center_anchor). ' +
        'move: translate — pass exactly ONE pair: delta_x+delta_y (relative), absolute_x+absolute_y (top-left), or center_on_x+center_on_y (center). ' +
        'rotate: degrees (relative, +cw). ' +
        'flip: axis horizontal|vertical. ' +
        'skew: slant via skew_h_degrees/skew_v_degrees (+ optional scale_x_percent/scale_y_percent, degrees, offset_x/offset_y). ' +
        'free: numeric free-transform — scale_x_percent/scale_y_percent + degrees + offset_x/offset_y. ' +
        'scale/move/rotate/flip/skew/free auto-promote the background layer (background_promoted in the result).',
    },
    ...fitLayerToDocumentSchema.properties,
    ...scaleLayerSchema.properties,
    ...moveLayerSchema.properties,
    ...rotateLayerSchema.properties,
    ...flipLayerSchema.properties,
    ...matrixExtraProps,
  },
  required: ['op'],
};

export function createLayerTransformTools(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  // Backs anchor-relational `placement` on op=move; only used when a placement is
  // supplied (raw delta/absolute/center moves never touch it).
  client: DetectionClient = new OnnxLandmarkDetectionClient()
): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'ps_transform_layer',
        description:
          'Transform the active layer — choose the operation with `op`. `fit` scales to fit (letterbox) or fill (crop) the canvas and centers (idempotent). `scale` does uniform (scale_percent) or non-uniform stretch/squash (scale_x_percent/scale_y_percent) — multiplicative, not idempotent. `move` translates via exactly one of delta (relative), absolute (top-left target), center_on (center target — best for "place inside the frame opening"), or an anchor-relational `placement` (preferred: a point relation → the layer center moves to the resolved, gate-verified point); mixing the raw modes errors. `rotate` rotates by relative degrees around center. `flip` mirrors horizontal/vertical. `skew` slants the layer (skew_h_degrees/skew_v_degrees). `free` is a numeric free-transform (scale + degrees + offset). scale/move/rotate/flip/skew/free auto-promote the background layer (background_promoted=true).',
        inputSchema: TRANSFORM_INPUT_SCHEMA,
        outputSchema: {
          type: 'object',
          properties: {
            fitted: { type: 'boolean' },
            scaled: { type: 'boolean' },
            moved: { type: 'boolean' },
            rotated: { type: 'boolean' },
            flipped: { type: 'boolean' },
            transformed: { type: 'boolean' },
            mode: { type: 'string' },
            skew_h_degrees: { type: 'number' },
            skew_v_degrees: { type: 'number' },
            rotate_degrees: { type: 'number' },
            axis: { type: 'string' },
            degrees: { type: 'number' },
            percent: { type: 'number' },
            scale_x_percent: { type: 'number' },
            scale_y_percent: { type: 'number' },
            originalSize: { type: 'object' },
            newSize: { type: 'object' },
            scaleFactor: { type: 'number' },
            scalePercent: { type: 'number' },
            applied_delta_x: { type: 'number' },
            applied_delta_y: { type: 'number' },
            new_bounds: { type: 'object' },
            background_promoted: { type: 'boolean' },
            placement: {
              type: 'object',
              description:
                'Present when op=move used anchor-relational placement: the resolved point + gate verdict.',
              properties: {
                target: { type: 'string' },
                gate: { type: 'object' },
                anchors: { type: 'object' },
                geometry: { type: 'object' },
              },
            },
            context: { type: 'object' },
          },
        },
        annotations: {
          title: 'Transform Layer',
          idempotentHint: false,
        },
      },
      handler: async (args) => transformLayer(connection, snippetClient, client, args),
    },
  ];
}

// Dispatch the consolidated tool to the per-op handler. `op` is stripped so the
// delegate validates only its own params against its per-op schema.
async function transformLayer(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  client: DetectionClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  const op = rawArgs.op;
  const { op: _omit, ...rest } = rawArgs;
  switch (op) {
    case 'fit':
      return fitLayerToDocument(connection, snippetClient, rest);
    case 'scale':
      return scaleLayer(connection, snippetClient, rest);
    case 'move':
      return moveLayer(connection, snippetClient, client, rest);
    case 'rotate':
      return rotateLayer(connection, snippetClient, rest);
    case 'flip':
      return flipLayer(connection, snippetClient, rest);
    case 'skew':
      return matrixTransform(connection, snippetClient, 'skew', rest);
    case 'free':
      return matrixTransform(connection, snippetClient, 'free', rest);
    default:
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: unknown transform op "${String(op)}". Allowed: ${TRANSFORM_OPS.join(', ')}.`,
          },
        ],
        isError: true,
      };
  }
}

async function fitLayerToDocument(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: fitLayerToDocumentSchema,
    snippet: 'fitLayerToDocument',
    errorPrefix: 'Error fitting layer to document',
    params: (args) => {
      const mode = (args.mode as 'fit' | 'fill') ?? 'fit';
      return { fillDocument: mode === 'fill' };
    },
    successText: (result, args) => {
      const mode = (args.mode as 'fit' | 'fill') ?? 'fit';
      const fillDocument = mode === 'fill';
      return `Layer ${fillDocument ? 'filled' : 'fitted'} to document\nResult: ${JSON.stringify(result)}`;
    },
  });
}

async function scaleLayer(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(scaleLayerSchema, rawArgs);
    const centerAnchor = (args.center_anchor as boolean) ?? true;
    const sp = args.scale_percent as number | undefined;
    const sx = args.scale_x_percent as number | undefined;
    const sy = args.scale_y_percent as number | undefined;

    let script: string;
    let label: string;
    if (sx !== undefined || sy !== undefined) {
      const scaleX = sx ?? sp ?? 100;
      const scaleY = sy ?? sp ?? 100;
      script = await snippetClient.build('scaleLayer', {
        scaleXPercent: scaleX,
        scaleYPercent: scaleY,
        centerAnchor,
      });
      label = `Layer scaled to ${scaleX}% x ${scaleY}% (non-uniform)`;
    } else {
      if (sp === undefined) {
        throw new Error(
          'scale_layer requires scale_percent (uniform) or scale_x_percent/scale_y_percent (non-uniform).'
        );
      }
      script = await snippetClient.build('scaleLayer', { scalePercent: sp, centerAnchor });
      label = `Layer scaled to ${sp}%`;
    }
    const result = await runScript(connection, script);

    return {
      content: [
        {
          type: 'text' as const,
          text: `${label}\nResult: ${JSON.stringify(result)}`,
        },
      ],
      structuredContent: result as Record<string, unknown>,
    };
  } catch (error) {
    return toolErrorResult('Error scaling layer', error);
  }
}

async function flipLayer(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: flipLayerSchema,
    snippet: 'flipLayer',
    errorPrefix: 'Error flipping layer',
    params: (args) => ({ axis: args.axis as string }),
    successText: (result, args) =>
      `Layer flipped ${args.axis as string}\nResult: ${JSON.stringify(result)}`,
  });
}

async function moveLayer(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  client: DetectionClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(moveLayerSchema, rawArgs);

    let mode: 'delta' | 'absolute' | 'center';
    let deltaX = 0,
      deltaY = 0,
      absoluteX = 0,
      absoluteY = 0,
      centerOnX = 0,
      centerOnY = 0;
    let placementInfo:
      | {
          target: string;
          anchors: Record<string, { kind: string; center: { x: number; y: number } }>;
          point: { x: number; y: number };
        }
      | undefined;

    if (args.placement) {
      // Anchor-relational move: the layer CENTER goes to the resolved+gated point.
      const rp = await resolveExpectedPlacement(
        connection,
        client,
        args.placement,
        'point',
        'move'
      );
      mode = 'center';
      centerOnX = rp.point.x;
      centerOnY = rp.point.y;
      placementInfo = { target: rp.target, anchors: rp.anchors, point: rp.point };
    } else {
      // Pick exactly one raw positioning mode. The schema can't
      // enforce mutual exclusivity with our minimal validator, so do it
      // here with an explicit message that points at the right fields.
      const hasDelta = args.delta_x !== undefined || args.delta_y !== undefined;
      const hasAbsolute = args.absolute_x !== undefined || args.absolute_y !== undefined;
      const hasCenter = args.center_on_x !== undefined || args.center_on_y !== undefined;
      const modeCount = (hasDelta ? 1 : 0) + (hasAbsolute ? 1 : 0) + (hasCenter ? 1 : 0);

      if (modeCount === 0) {
        throw new Error(
          'No positioning mode specified. Pass a placement (anchors + a point relation), or exactly one pair: delta_x+delta_y (relative), absolute_x+absolute_y (target top-left), or center_on_x+center_on_y (target center).'
        );
      }
      if (modeCount > 1) {
        throw new Error(
          'Mixed positioning modes. Pass exactly ONE pair: delta_x+delta_y OR absolute_x+absolute_y OR center_on_x+center_on_y.'
        );
      }
      if (hasDelta && (args.delta_x === undefined || args.delta_y === undefined)) {
        throw new Error('Delta mode requires both delta_x and delta_y.');
      }
      if (hasAbsolute && (args.absolute_x === undefined || args.absolute_y === undefined)) {
        throw new Error('Absolute mode requires both absolute_x and absolute_y.');
      }
      if (hasCenter && (args.center_on_x === undefined || args.center_on_y === undefined)) {
        throw new Error('Center mode requires both center_on_x and center_on_y.');
      }

      mode = hasAbsolute ? 'absolute' : hasCenter ? 'center' : 'delta';
      deltaX = (args.delta_x as number | undefined) ?? 0;
      deltaY = (args.delta_y as number | undefined) ?? 0;
      absoluteX = (args.absolute_x as number | undefined) ?? 0;
      absoluteY = (args.absolute_y as number | undefined) ?? 0;
      centerOnX = (args.center_on_x as number | undefined) ?? 0;
      centerOnY = (args.center_on_y as number | undefined) ?? 0;
    }

    const script = await snippetClient.build('moveLayer', {
      deltaX,
      deltaY,
      mode,
      absoluteX,
      absoluteY,
      centerOnX,
      centerOnY,
    });
    const result = (await runScript(connection, script)) as {
      applied_delta_x?: number;
      applied_delta_y?: number;
      background_promoted?: boolean;
    };

    const summary = placementInfo
      ? `Layer center moved to (${centerOnX}, ${centerOnY})px via placement (gate PASS) — applied delta (${result.applied_delta_x ?? '?'}, ${result.applied_delta_y ?? '?'})`
      : mode === 'delta'
        ? `Layer moved by (${deltaX}, ${deltaY})px (relative)`
        : mode === 'absolute'
          ? `Layer top-left moved to (${absoluteX}, ${absoluteY})px — applied delta (${result.applied_delta_x ?? '?'}, ${result.applied_delta_y ?? '?'})`
          : `Layer center moved to (${centerOnX}, ${centerOnY})px — applied delta (${result.applied_delta_x ?? '?'}, ${result.applied_delta_y ?? '?'})`;

    const bgNote = result.background_promoted ? ' (background layer auto-promoted)' : '';

    return {
      content: [
        {
          type: 'text' as const,
          text: `${summary}${bgNote}\nResult: ${JSON.stringify(result)}`,
        },
      ],
      structuredContent: placementInfo
        ? {
            ...result,
            placement: {
              target: placementInfo.target,
              gate: { pass: true },
              anchors: placementInfo.anchors,
              geometry: placementInfo.point,
            },
          }
        : (result as Record<string, unknown>),
    };
  } catch (error) {
    return toolErrorResult('Error moving layer', error);
  }
}

async function rotateLayer(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: rotateLayerSchema,
    snippet: 'rotateLayer',
    errorPrefix: 'Error rotating layer',
    params: (args) => ({ degrees: args.degrees as number }),
    successText: (result, args) =>
      `Layer rotated ${args.degrees as number} degrees\nResult: ${JSON.stringify(result)}`,
  });
}

// M2 (2026-06-21): op=skew / op=free — raw-AM Trnf matrix. Both reuse
// scale_x_percent/scale_y_percent + degrees; skew adds slant angles, free adds
// translation. The go-core emitter conditionally includes the Skew sub-object
// for mode=skew. dev-tier.
async function matrixTransform(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  mode: 'skew' | 'free',
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(mode === 'skew' ? skewLayerSchema : freeLayerSchema, rawArgs);
    const skewH = args.skew_h_degrees as number | undefined;
    const skewV = args.skew_v_degrees as number | undefined;
    if (mode === 'skew' && skewH === undefined && skewV === undefined) {
      throw new Error('op=skew requires at least one of skew_h_degrees / skew_v_degrees.');
    }

    const params = {
      mode,
      scaleXPercent: (args.scale_x_percent as number | undefined) ?? 100,
      scaleYPercent: (args.scale_y_percent as number | undefined) ?? 100,
      rotateDegrees: (args.degrees as number | undefined) ?? 0,
      skewH: skewH ?? 0,
      skewV: skewV ?? 0,
      offsetX: (args.offset_x as number | undefined) ?? 0,
      offsetY: (args.offset_y as number | undefined) ?? 0,
    };

    const script = await snippetClient.build('transformLayerMatrix', params);
    const result = (await runScript(connection, script)) as { background_promoted?: boolean };
    const bgNote = result.background_promoted ? ' (background layer auto-promoted)' : '';

    return {
      content: [
        {
          type: 'text' as const,
          text: `Layer ${mode === 'skew' ? 'skewed' : 'free-transformed'}${bgNote}\nResult: ${JSON.stringify(result)}`,
        },
      ],
      structuredContent: result as Record<string, unknown>,
    };
  } catch (error) {
    return toolErrorResult(`Error in ${mode} transform`, error);
  }
}
