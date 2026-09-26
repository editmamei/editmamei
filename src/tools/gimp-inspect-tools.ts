import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import type { GimpBackend } from '../backends/gimp/backend.js';
import { validateArgs, type JsonSchemaObject } from '../utils/validate.js';
import { toolGimpErrorResult, unknownDiscriminator } from '../utils/tool-helpers.js';

/**
 * gimp_inspect — read-only state reader, the gimp_* twin of ps_inspect.
 *
 * SCOPE NOTE: `ps_inspect` consolidates several PS-side read-only readers
 * because Photoshop's scripting surface can answer each one directly. The
 * GIMP bridge (`bridge/ops.py`'s `OPS` table) has no op that describes an
 * ALREADY-OPEN image's current layers/channels/precision on demand — only
 * `open` returns that shape, at open time. Rather than fabricate data the
 * bridge doesn't provide, `what` is scoped today to the one target the
 * bridge genuinely answers: `'documents'` (every open image's id, via the
 * `ping` op). `'document'` / `'layers'` / `'channels'` are reserved for a
 * follow-up once the bridge grows a describe-by-id op — until then they
 * fall through to the same unknown-discriminator error every other target
 * would, naming `what` and the one value that currently works.
 */

const inspectSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    what: {
      type: 'string',
      enum: ['documents'],
      description:
        "What to inspect. 'documents' lists every image currently open in this headless session " +
        '(id only — the bridge has no per-image describe-by-id op yet, so no name/size/layer data ' +
        "is available here; gimp_open_document's own return value is the place to get that, at " +
        'open time).',
    },
  },
  required: ['what'],
};

interface PingBridgeResult {
  images: number[];
}

async function gimpInspect(
  gimp: GimpBackend,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(inspectSchema, rawArgs);
    const what = args.what as string;
    // Unreachable while the schema's own single-value enum stands
    // (validateArgs already refused anything else) — kept as defense-in-depth
    // and ready for the day a second `what` target is added.
    if (what !== 'documents') {
      return unknownDiscriminator('what', what, ['documents']);
    }
    const result = await gimp.call<PingBridgeResult>('ping', {});
    const documents = (result.images ?? []).map((image) => ({ image }));
    return {
      content: [
        {
          type: 'text' as const,
          text: `${documents.length} image(s) open: ${documents.map((d) => d.image).join(', ') || '(none)'}.`,
        },
      ],
      structuredContent: { what, documents },
    };
  } catch (error) {
    return toolGimpErrorResult('Error inspecting GIMP state', error);
  }
}

export function createGimpInspectTools(gimp: GimpBackend): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'gimp_inspect',
        description:
          "Read-only state reader. Today's only target: what='documents' lists every image " +
          'currently open in this headless GIMP session by id (no name/size — track those from ' +
          "gimp_open_document's own return value). Fewer targets than ps_inspect: the GIMP bridge " +
          'has no describe-by-id op for an already-open image yet.',
        inputSchema: inspectSchema,
        outputSchema: {
          type: 'object',
          properties: {
            what: { type: 'string' },
            documents: {
              type: 'array',
              items: { type: 'object', properties: { image: { type: 'number' } } },
            },
          },
        },
        annotations: {
          title: 'Inspect GIMP State',
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      handler: async (args) => gimpInspect(gimp, args),
    },
  ];
}
