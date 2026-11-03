import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import type { SnippetClient } from '../api/snippet-client.js';
import { runScript } from '../utils/run-script.js';
import { type JsonSchemaObject } from '../utils/validate.js';
import { toolErrorResult, runSnippetTool } from '../utils/tool-helpers.js';

const createLayerSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description: 'Name for the new layer (optional)',
    },
  },
};

const deleteLayerSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description:
        'Optional layer name. If supplied, recurses into groups and deletes the first layer matching this name. If omitted, deletes the currently active layer (backward-compatible).',
    },
  },
};

// Photoshop's max canvas dimension. Text layers can sit off-canvas in
// either direction so we allow ± the same bound.
const PS_TEXT_COORD_MAX = 300_000;

// Text-layer creation lives here rather than in text-tools.ts because it is a
// layer-lifecycle snippet; ps_text(op=create) imports this schema and the
// createTextLayer handler below.
export const createTextLayerSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    text: {
      type: 'string',
      description: 'Text content',
    },
    x: {
      type: 'integer',
      description: 'X position in pixels (default 100). Bounded at ±300,000 px.',
      default: 100,
      minimum: -PS_TEXT_COORD_MAX,
      maximum: PS_TEXT_COORD_MAX,
    },
    y: {
      type: 'integer',
      description: 'Y position in pixels (default 100). Bounded at ±300,000 px.',
      default: 100,
      minimum: -PS_TEXT_COORD_MAX,
      maximum: PS_TEXT_COORD_MAX,
    },
    font_size: {
      type: 'number',
      description: 'Font size in points (default: 24)',
      default: 24,
      minimum: 1,
      maximum: 1296,
    },
  },
  required: ['text'],
};

const fillLayerSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    red: {
      type: 'integer',
      description: 'Red component (0-255)',
      minimum: 0,
      maximum: 255,
    },
    green: {
      type: 'integer',
      description: 'Green component (0-255)',
      minimum: 0,
      maximum: 255,
    },
    blue: {
      type: 'integer',
      description: 'Blue component (0-255)',
      minimum: 0,
      maximum: 255,
    },
  },
  required: ['red', 'green', 'blue'],
};

const addFillLayerSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    fill_type: {
      type: 'string',
      enum: ['solid_color', 'gradient'],
      description:
        'Fill-layer type. solid_color takes red/green/blue (required for that type); gradient takes the gradient_* params + stops (pattern fills still planned).',
      default: 'solid_color',
    },
    red: {
      type: 'integer',
      description: 'fill_type=solid_color: red (0-255). Required for solid_color.',
      minimum: 0,
      maximum: 255,
    },
    green: {
      type: 'integer',
      description: 'fill_type=solid_color: green (0-255). Required for solid_color.',
      minimum: 0,
      maximum: 255,
    },
    blue: {
      type: 'integer',
      description: 'fill_type=solid_color: blue (0-255). Required for solid_color.',
      minimum: 0,
      maximum: 255,
    },
    gradient_type: {
      type: 'string',
      enum: ['linear', 'radial', 'angle', 'reflected', 'diamond'],
      description:
        'fill_type=gradient: gradient geometry. linear for skies/fades, radial for vignettes/glows.',
      default: 'linear',
    },
    angle: {
      type: 'number',
      minimum: -180,
      maximum: 180,
      description:
        'fill_type=gradient: gradient angle in degrees (Photoshop convention: 90 runs the first stop from the bottom up; 0 runs it left to right).',
      default: 90,
    },
    scale: {
      type: 'number',
      minimum: 10,
      maximum: 150,
      description: 'fill_type=gradient: gradient scale percent (compress/stretch the ramp).',
      default: 100,
    },
    reverse: {
      type: 'boolean',
      description: 'fill_type=gradient: reverse the stop order.',
      default: false,
    },
    dither: {
      type: 'boolean',
      description: 'fill_type=gradient: dither to reduce banding.',
      default: true,
    },
    offset_x: {
      type: 'number',
      minimum: -100,
      maximum: 100,
      description: 'fill_type=gradient: horizontal center offset percent.',
      default: 0,
    },
    offset_y: {
      type: 'number',
      minimum: -100,
      maximum: 100,
      description: 'fill_type=gradient: vertical center offset percent.',
      default: 0,
    },
    stops: {
      type: 'array',
      description:
        'fill_type=gradient: color stops, each {red,green,blue (0-255), location (0-100 along the ramp), midpoint (5-95, default 50)}. At least 2 when supplied; sorted by location. Default: black at 0 → white at 100.',
      items: {
        type: 'object',
        properties: {
          red: { type: 'integer', minimum: 0, maximum: 255 },
          green: { type: 'integer', minimum: 0, maximum: 255 },
          blue: { type: 'integer', minimum: 0, maximum: 255 },
          location: { type: 'number', minimum: 0, maximum: 100 },
          midpoint: { type: 'number', minimum: 5, maximum: 95, default: 50 },
        },
        required: ['red', 'green', 'blue', 'location'],
      },
    },
    opacity_stops: {
      type: 'array',
      description:
        'fill_type=gradient: opacity stops, each {opacity (0-100), location (0-100), midpoint (5-95, default 50)}. Use e.g. 100→0 for a fade-to-transparent wash. Default: fully opaque.',
      items: {
        type: 'object',
        properties: {
          opacity: { type: 'number', minimum: 0, maximum: 100 },
          location: { type: 'number', minimum: 0, maximum: 100 },
          midpoint: { type: 'number', minimum: 5, maximum: 95, default: 50 },
        },
        required: ['opacity', 'location'],
      },
    },
    into_active_group: {
      type: 'boolean',
      description:
        "Photoshop's Mk-contentLayer descriptor carries no placement target, so with a GROUP active it would natively nest the new fill layer INSIDE that group. Default false hoists the new layer back out so it lands above the active layer/group as a sibling. Pass true to keep it nested inside the active group instead.",
      default: false,
    },
  },
};

const selectLayerSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description:
        'Name of the layer to make active. Recurses into groups; matches the first layer in stack order (top-to-bottom). Throws if no layer by that name exists.',
    },
  },
  required: ['name'],
};

export function createLayerTools(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient
): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'ps_create_layer',
        description:
          'Create a new empty raster layer above the currently active layer. Non-destructive. Use ps_text (op=create) for text, ps_add_adjustment_layer for adjustments.',
        inputSchema: createLayerSchema,
        outputSchema: {
          type: 'object',
          properties: {
            created: { type: 'boolean' },
            layerName: { type: 'string' },
            parent_path: {
              type: ['array', 'null'],
              items: { type: 'string' },
              description:
                'The containing-group name chain (outermost first), empty array at the document root.',
            },
            context: { type: 'object' },
          },
        },
        annotations: {
          title: 'Create Empty Layer',
          idempotentHint: false,
        },
      },
      handler: async (args) => createLayer(connection, snippetClient, args),
    },
    {
      tool: {
        name: 'ps_delete_layer',
        description:
          'DESTRUCTIVE: Delete a layer. With no arg, deletes the currently active layer (backward-compatible). With `name`, recurses into groups and deletes the first LAYER matching that name — useful for cleanup workflows where the dead layer is not currently active. A name that matches a group is refused rather than deleted; use ps_group(op=delete) to delete a group and all its contents. Recoverable only via Edit > Undo.',
        inputSchema: deleteLayerSchema,
        outputSchema: {
          type: 'object',
          properties: {
            deleted: { type: 'boolean' },
            layerName: { type: 'string' },
            context: { type: 'object' },
          },
        },
        annotations: {
          title: 'Delete Layer (destructive)',
          destructiveHint: true,
          idempotentHint: false,
        },
      },
      handler: async (args) => deleteLayer(connection, snippetClient, args),
    },
    {
      tool: {
        name: 'ps_fill_layer',
        description:
          'Fill the active layer (or the current selection within it) with a solid RGB color. Idempotent for the same color. Throws on fully-locked or text layers — rasterize text first if needed.',
        inputSchema: fillLayerSchema,
        outputSchema: {
          type: 'object',
          properties: {
            filled: { type: 'boolean' },
            layerName: { type: 'string' },
            color: { type: 'object' },
          },
        },
        annotations: {
          title: 'Fill Layer with Color',
          idempotentHint: true,
        },
      },
      handler: async (args) => fillLayer(connection, snippetClient, args),
    },
    {
      tool: {
        name: 'ps_add_fill_layer',
        description:
          "Add a non-destructive SOLID COLOR or GRADIENT fill layer (an editable content layer — distinct from ps_fill_layer, which bakes color into the active pixel layer). fill_type=gradient is the go-to for sky fades, color washes, and vignettes (radial + reverse + multiply blend); combine with opacity_stops 100→0 for fade-to-transparent, or ps_bake_layer to rasterize. For fading a layer out via its MASK use ps_layer_mask op=gradient instead. Hoisted out of the active layer's group by default (pass into_active_group:true to keep Photoshop's native nesting). The new fill layer becomes active.",
        inputSchema: addFillLayerSchema,
        outputSchema: {
          type: 'object',
          properties: {
            created: { type: 'boolean' },
            fill_type: { type: 'string' },
            color: { type: 'object' },
            gradient_type: { type: 'string' },
            angle: { type: 'number' },
            scale: { type: 'number' },
            reverse: { type: 'boolean' },
            stop_count: { type: 'number' },
            layer_name: { type: 'string' },
            hoisted: {
              type: 'boolean',
              description:
                'True when the new layer had to be moved back out of the previously-active group to honor into_active_group:false (the default). False when it landed correctly on its own, or when the move-back itself failed — check the layer tree if this matters and hoisted is false.',
            },
            parent_path: {
              type: ['array', 'null'],
              items: { type: 'string' },
              description:
                'The containing-group name chain (outermost first), empty array at the document root.',
            },
            context: { type: 'object' },
          },
        },
        annotations: {
          title: 'Add Fill Layer (solid color)',
          idempotentHint: false,
        },
      },
      handler: async (args) => addFillLayer(connection, snippetClient, args),
    },
    // The old dedicated get_layer_tree reader merged into ps_inspect(what='layer_tree')
    // on 2026-06-26 (Phase 1b). getLayerTree is exported below for inspect-tools.ts.
    {
      tool: {
        name: 'ps_select_layer',
        description:
          'Make a layer active by name. Recurses into groups; if a name appears more than once, picks the first match in stack order (top-to-bottom). Throws if no layer by that name exists. Foundational for multi-layer workflows — use after ps_duplicate_layer or ps_add_adjustment_layer when you need to focus a specific layer before applying further operations.',
        inputSchema: selectLayerSchema,
        outputSchema: {
          type: 'object',
          properties: {
            selected: { type: 'boolean' },
            name: { type: 'string' },
            kind: { type: 'string' },
            context: { type: 'object' },
          },
        },
        annotations: {
          title: 'Select Layer by Name',
          idempotentHint: true,
        },
      },
      handler: async (args) => selectLayer(connection, snippetClient, args),
    },
  ];
}

async function createLayer(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: createLayerSchema,
    snippet: 'newLayer',
    errorPrefix: 'Error creating layer',
    params: (args) => {
      const name = args.name as string | undefined;
      const params: Record<string, unknown> = {};
      if (name !== undefined) params.name = name;
      return params;
    },
    successText: (_result, args) => {
      const name = args.name as string | undefined;
      return `Layer created${name ? `: ${name}` : ''}`;
    },
  });
}

async function deleteLayer(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: deleteLayerSchema,
    snippet: 'deleteLayer',
    errorPrefix: 'Error deleting layer',
    params: (args) => {
      const name = args.name as string | undefined;
      const params: Record<string, unknown> = {};
      if (name !== undefined) params.name = name;
      return params;
    },
    successText: (_result, args) => {
      const name = args.name as string | undefined;
      return name ? `Layer "${name}" deleted` : 'Active layer deleted';
    },
  });
}

// Exported for ps_text(op=create) — see the schema export above.
export async function createTextLayer(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: createTextLayerSchema,
    snippet: 'createTextLayer',
    errorPrefix: 'Error creating text layer',
    params: (args) => ({
      text: args.text as string,
      x: args.x as number,
      y: args.y as number,
      fontSize: args.font_size as number,
    }),
    successText: (_result, args) =>
      `Text layer created: "${args.text as string}" at (${args.x as number}, ${args.y as number})`,
  });
}

async function fillLayer(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: fillLayerSchema,
    snippet: 'fillLayer',
    errorPrefix: 'Error filling layer',
    params: (args) => ({
      red: args.red as number,
      green: args.green as number,
      blue: args.blue as number,
    }),
    successText: (_result, args) =>
      `Layer filled with RGB(${args.red as number}, ${args.green as number}, ${args.blue as number})`,
  });
}

async function addFillLayer(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  if (rawArgs.fill_type === 'gradient') {
    return runSnippetTool({
      connection,
      snippetClient,
      rawArgs,
      schema: addFillLayerSchema,
      snippet: 'addGradientFillLayer',
      errorPrefix: 'Error adding gradient fill layer',
      params: (args) => {
        const params: Record<string, unknown> = {
          gradient_type: (args.gradient_type as string) ?? 'linear',
          angle: (args.angle as number) ?? 90,
          scale: (args.scale as number) ?? 100,
          reverse: (args.reverse as boolean) ?? false,
          dither: (args.dither as boolean) ?? true,
          offset_x: (args.offset_x as number) ?? 0,
          offset_y: (args.offset_y as number) ?? 0,
          into_active_group: (args.into_active_group as boolean) ?? false,
        };
        if (args.stops !== undefined) params.stops = args.stops;
        if (args.opacity_stops !== undefined) params.opacity_stops = args.opacity_stops;
        return params;
      },
      successText: (result, args) => {
        const stopCount = (result as Record<string, unknown>).stop_count as number | undefined;
        return `Gradient fill layer added: ${(args.gradient_type as string) ?? 'linear'}, angle ${(args.angle as number) ?? 90}${stopCount !== undefined ? `, ${stopCount} stops` : ''}`;
      },
    });
  }

  // fill_type=solid_color (the default). The schema no longer hard-requires
  // red/green/blue (gradient calls omit them), so enforce them here.
  if (rawArgs.red === undefined || rawArgs.green === undefined || rawArgs.blue === undefined) {
    return toolErrorResult(
      'Error adding fill layer',
      new Error('fill_type=solid_color requires red, green, and blue (0-255).')
    );
  }
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: addFillLayerSchema,
    snippet: 'addFillLayer',
    errorPrefix: 'Error adding fill layer',
    params: (args) => ({
      red: args.red as number,
      green: args.green as number,
      blue: args.blue as number,
      into_active_group: (args.into_active_group as boolean) ?? false,
    }),
    successText: (_result, args) =>
      `Solid color fill layer added: RGB(${args.red as number}, ${args.green as number}, ${args.blue as number})`,
  });
}

export async function getLayerTree(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient
): Promise<ToolResult> {
  try {
    const script = await snippetClient.build('getLayerTree');
    const result = await runScript(connection, script);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Layer tree:\n${JSON.stringify(result, null, 2)}`,
        },
      ],
      structuredContent: result as Record<string, unknown>,
    };
  } catch (error) {
    return toolErrorResult('Error getting layer tree', error);
  }
}

async function selectLayer(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: selectLayerSchema,
    snippet: 'selectLayer',
    errorPrefix: 'Error selecting layer',
    params: (args) => ({ name: args.name as string }),
    successText: (result, args) =>
      `Active layer set to "${args.name as string}".\n${JSON.stringify(result, null, 2)}`,
  });
}
