import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import type { SnippetClient } from '../api/snippet-client.js';
import { runScript } from '../utils/run-script.js';
import { validateArgs, type JsonSchemaObject } from '../utils/validate.js';
import {
  OPEN_DOCUMENT_TIMEOUT_MS,
  OPEN_DOCUMENT_REPROBE_TIMEOUT_MS,
} from '../utils/operation-timeouts.js';
import { toolErrorResult, runSnippetTool } from '../utils/tool-helpers.js';
import { purgeSceneChannels } from '../perception/region-precompute.js';
import { Logger } from '../utils/logger.js';

const logger = new Logger('document-tools');

const createDocumentSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    width: {
      type: 'number',
      description: 'Document width in pixels',
      minimum: 1,
      maximum: 30000,
    },
    height: {
      type: 'number',
      description: 'Document height in pixels',
      minimum: 1,
      maximum: 30000,
    },
    resolution: {
      type: 'number',
      description: 'Document resolution in DPI (default: 72)',
      default: 72,
      minimum: 1,
      maximum: 2400,
    },
    color_mode: {
      type: 'string',
      description: 'Color mode (RGB, CMYK, Grayscale)',
      enum: ['RGB', 'CMYK', 'Grayscale'],
      default: 'RGB',
    },
  },
  required: ['width', 'height'],
};

/**
 * The name/id selector shared by ps_close_document and ps_document. Kept in one
 * place so the two can't drift on what "target a document" means.
 *
 * Deliberately does NOT name the tool that lists open documents: this object is
 * spliced into ps_close_document, which is community-tier, and the leak guard
 * (correctly) rejects a CE-visible description that points at a dev-tier tool a
 * CE user does not have. Restore the cross-reference when that tool promotes.
 */
const documentTargetProps = {
  name: {
    type: 'string',
    description:
      "Target an open document by its exact Photoshop name, INCLUDING the extension as shown in the tab (e.g. 'portrait.jpg', not 'portrait'). If two open documents share a name the call fails rather than guessing — target by id instead.",
  },
  id: {
    type: 'number',
    description:
      'Target an open document by its Photoshop document id. Unambiguous — prefer this when names collide.',
  },
} as const;

const closeDocumentSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    save: {
      type: 'boolean',
      description: 'Whether to save changes before closing',
      default: false,
    },
    ...documentTargetProps,
  },
};

const DOCUMENT_OPS = ['list', 'activate'] as const;

const documentSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    op: {
      type: 'string',
      enum: [...DOCUMENT_OPS],
      description:
        'list: every open document (index, id, name, path, saved, active, dimensions) — safe to call when NOTHING is open, which is the point. activate: make one of them the active document, by name or id.',
    },
    ...documentTargetProps,
  },
  required: ['op'],
};

const openDocumentSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    file_path: {
      type: 'string',
      description: 'Absolute path to the file to open',
    },
    suppress_dialogs: {
      type: 'boolean',
      description:
        'Suppress all PS dialogs during open (raw/HEIC use last-used ACR settings). Default true for pipeline use.',
      default: true,
    },
  },
  required: ['file_path'],
};

const savePsdSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    output_path: {
      type: 'string',
      description: 'Absolute output path including filename, e.g. E:\\Photos\\Edit\\shell_01.psd',
    },
    maximize_compatibility: {
      type: 'boolean',
      description: 'Include flattened composite for compatibility with other apps. Default true.',
      default: true,
    },
    keep_scene_channels: {
      type: 'boolean',
      description:
        "Keep the managed scene:* alpha channels ps_read_scene precomputes. Default false — they are DERIVED masks (rebuilt by the next scene read) and each is a full-resolution channel, so baking them into the .psd bloats it badly (~51MB per channel on a 51MP document). Set true only if you want the saved file to carry the masks. The result reports scene_channels_purged either way, so it's never silent. NOTE: the `scene:` channel-name prefix is RESERVED — the purge matches on the prefix alone, so a hand-made channel named e.g. `scene:mine` is deleted along with the derived ones. Name your own channels anything else.",
      default: false,
    },
  },
  required: ['output_path'],
};

const exportJpegSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    output_path: {
      type: 'string',
      description: 'Absolute output path including filename.',
    },
    quality: {
      type: 'integer',
      description:
        "JPEG quality 0-100 (the Photoshop 'Save As' / JPEG-dialog scale humans and the UI use). 100 = maximum. Mapped internally to Photoshop's 0-12 JPEGSaveOptions scripting scale (e.g. 90→11, 100→12).",
      default: 90,
      minimum: 0,
      maximum: 100,
    },
    long_edge_px: {
      type: 'integer',
      description:
        'Resize so the longest edge equals this value. Omit for full resolution. Downscale only.',
      minimum: 64,
      maximum: 30000,
    },
    embed_color_profile: {
      type: 'boolean',
      description: 'Embed color profile in the exported file. Default true.',
      default: true,
    },
    convert_to_srgb: {
      type: 'boolean',
      description: 'Convert to sRGB before export. Default true.',
      default: true,
    },
  },
  required: ['output_path'],
};

const exportPngSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    output_path: {
      type: 'string',
      description: 'Absolute output path including filename.',
    },
    transparent_background: {
      type: 'boolean',
      description: 'If true, preserves transparency. If false, flattens onto white. Default false.',
      default: false,
    },
    long_edge_px: {
      type: 'integer',
      description:
        'Resize so the longest edge equals this value. Omit for full resolution. Downscale only.',
      minimum: 64,
      maximum: 30000,
    },
    compression: {
      type: 'integer',
      description: 'PNG compression level 0-9. Lower = larger file, faster. Default 6.',
      default: 6,
      minimum: 0,
      maximum: 9,
    },
  },
  required: ['output_path'],
};

const EXPORT_FORMATS = ['jpeg', 'png'] as const;

// Consolidated input schema for ps_export (Phase 1, 2026-06-20).
// Merges the JPEG + PNG schemas (shared output_path / long_edge_px collide
// identically); the handler re-validates against the exact per-format schema.
const exportInputSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    format: {
      type: 'string',
      enum: [...EXPORT_FORMATS],
      description:
        'Output image format. jpeg: quality 0-100, optional convert_to_srgb + embed_color_profile. ' +
        'png: transparent_background (alpha) or flattened-on-white, compression 0-9. ' +
        'Both take output_path (required) and optional long_edge_px (downscale only).',
    },
    ...exportJpegSchema.properties,
    ...exportPngSchema.properties,
  },
  required: ['format', 'output_path'],
};

export function createDocumentTools(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient
): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'ps_create_document',
        description:
          'Create a new empty Photoshop document with given dimensions, resolution, and color mode. Returns the new document id and name plus active context. Use this when starting from scratch; prefer ps_open_document to load an existing file.',
        inputSchema: createDocumentSchema,
        outputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            name: { type: 'string' },
            context: { type: 'object' },
          },
        },
        annotations: {
          title: 'Create New Document',
          idempotentHint: false,
        },
      },
      handler: async (args) => createDocument(connection, snippetClient, args),
    },
    {
      tool: {
        name: 'ps_document',
        description:
          "See and steer WHICH documents are open, without touching their content. op=list answers 'what is open, which one is active, and does it have unsaved changes' — and it is the one document tool that works when nothing is open at all, so it is the recovery read after a 'No document is open' failure. op=activate switches the active document by name or id, which is how you fix having edited the wrong one. Read-only with respect to pixels; use ps_open_document to load a file and ps_close_document to close one.",
        inputSchema: documentSchema,
        outputSchema: {
          type: 'object',
          properties: {
            op: { type: 'string' },
            count: { type: 'number' },
            documents: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  index: { type: 'number' },
                  id: { type: 'number' },
                  name: { type: 'string' },
                  path: {
                    type: ['string', 'null'],
                    description: 'Absolute path, or null for a document never saved to disk.',
                  },
                  saved: {
                    type: ['boolean', 'null'],
                    description:
                      'False when the document has unsaved changes. Null when Photoshop would not report it.',
                  },
                  active: { type: 'boolean' },
                  width_px: { type: ['number', 'null'] },
                  height_px: { type: ['number', 'null'] },
                },
              },
            },
            activated: { type: 'boolean' },
            id: { type: 'number' },
            name: { type: 'string' },
            context: { type: 'object' },
          },
          required: ['op'],
        },
        annotations: {
          title: 'List / Activate Documents',
          readOnlyHint: true,
          idempotentHint: true,
        },
      },
      handler: async (args) => documentOp(connection, snippetClient, args),
    },
    {
      tool: {
        name: 'ps_close_document',
        description:
          'Close a Photoshop document — the active one by default, or a specific one by name or id. Destructive if save=false and the document has unsaved changes. If two open documents share the requested name the call fails rather than guessing. Returns the closed document name plus a fresh context block (which document, if any, is active afterwards).',
        inputSchema: closeDocumentSchema,
        outputSchema: {
          type: 'object',
          properties: {
            closed: { type: 'boolean' },
            saved: { type: 'boolean' },
            closedName: { type: 'string' },
            context: { type: 'object' },
          },
        },
        annotations: {
          title: 'Close Document',
          destructiveHint: true,
          idempotentHint: true,
        },
      },
      handler: async (args) => closeDocument(connection, snippetClient, args),
    },
    {
      tool: {
        name: 'ps_open_document',
        description:
          'Open a file from disk into Photoshop with all dialogs suppressed (uses last-used Camera Raw settings for raw/HEIC). Returns document name, dimensions, color mode, and whether the source was a raw format. `is_raw_source` is workflow-critical, not a passive status field: when true, the first edit should be a Camera Raw develop pass on the base smart object (via a camera-raw develop tool, if one is registered in tools/list) — NOT stacked tonal adjustment layers. Use this in the pipeline to load Inbox files for editing. If the file is ALREADY open, its existing document is activated rather than opened a second time — `already_open: true` says so, and any edits made to it are still there (Photoshop would otherwise open a duplicate with a fresh Background, which silently strands prior work).',
        inputSchema: openDocumentSchema,
        outputSchema: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            document_name: { type: 'string' },
            width_px: { type: 'number' },
            height_px: { type: 'number' },
            resolution: { type: 'number' },
            color_mode: { type: 'string' },
            bits_per_channel: { type: 'number' },
            is_raw_source: {
              type: 'boolean',
              description:
                'True when the source file was a raw capture (DNG/NEF/CR3/ARW/…). Workflow-critical: the open used last-used/default Camera Raw settings, so no deliberate develop has happened yet. When true, run the Camera Raw develop pass FIRST (via a camera-raw develop tool, if registered) for global tone/color — before any tonal adjustment layers — unless the user explicitly directs otherwise.',
            },
            already_open: { type: 'boolean' },
            file_path: { type: 'string' },
            context: { type: 'object' },
          },
          required: ['success'],
        },
        annotations: {
          title: 'Open Document (pipeline)',
          openWorldHint: true,
          idempotentHint: false,
        },
      },
      handler: async (args) => openDocumentPipeline(connection, snippetClient, args),
    },
    {
      tool: {
        name: 'ps_save_psd',
        description:
          'Save the active document as a layered PSD to the given path. Saves as a copy, so the working document is unmodified and unrenamed. Use this in the pipeline to land an editable PSD into the Edit folder.',
        inputSchema: savePsdSchema,
        outputSchema: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            saved_to: { type: 'string' },
            document_name: { type: 'string' },
            layers: { type: 'number' },
            context: { type: 'object' },
          },
          required: ['success'],
        },
        annotations: {
          title: 'Save PSD Copy (pipeline)',
          destructiveHint: true,
          openWorldHint: true,
          idempotentHint: true,
        },
      },
      handler: async (args) => savePsdPipeline(connection, snippetClient, args),
    },
    {
      tool: {
        name: 'ps_export',
        description:
          'Export the active document to a flattened image file — JPEG or PNG, chosen via `format`. Operates on a duplicate, so the working document is unchanged. Optionally downscales so the long edge equals long_edge_px. JPEG: quality 0-100 (Save-As scale), optional sRGB convert + profile embed. PNG: transparent background (alpha preserved) or flattened onto white, compression 0-9.',
        inputSchema: exportInputSchema,
        outputSchema: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            exported_to: { type: 'string' },
            width_px: { type: 'number' },
            height_px: { type: 'number' },
            quality: { type: 'number' },
            quality_ps_scale: { type: 'number' },
            transparent: { type: 'boolean' },
            context: { type: 'object' },
          },
          required: ['success'],
        },
        annotations: {
          title: 'Export Image (pipeline)',
          destructiveHint: true,
          openWorldHint: true,
          idempotentHint: true,
        },
      },
      handler: async (args) => exportImage(connection, snippetClient, args),
    },
  ];
}

// Dispatch the consolidated export tool to the per-format handler. `format` is
// stripped so the delegate validates only its own params.
async function exportImage(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  const format = rawArgs.format;
  const { format: _omit, ...rest } = rawArgs;
  switch (format) {
    case 'jpeg':
      return exportJpegPipeline(connection, snippetClient, rest);
    case 'png':
      return exportPngPipeline(connection, snippetClient, rest);
    default:
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: unknown export format "${String(format)}". Allowed: ${EXPORT_FORMATS.join(', ')}.`,
          },
        ],
        isError: true,
      };
  }
}

async function createDocument(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: createDocumentSchema,
    snippet: 'newDocument',
    errorPrefix: 'Error creating document',
    params: (args) => {
      const colorMode = args.color_mode as string;
      const colorModeMap: Record<string, string> = {
        RGB: 'NewDocumentMode.RGB',
        CMYK: 'NewDocumentMode.CMYK',
        Grayscale: 'NewDocumentMode.GRAYSCALE',
      };

      // The schema's enum gate normally rejects unknown values upstream of
      // this point, so a missing map entry indicates the enum and the map
      // have drifted apart. Throw loudly instead of the previous `|| RGB`
      // silent fallback, which would have a future enum extension produce
      // RGB documents for, say, `Lab` instead of erroring at PR time.
      const mappedMode = colorModeMap[colorMode];
      if (!mappedMode) {
        throw new Error(
          `colorModeMap missing entry for "${colorMode}" — schema enum and ` +
            `internal mapping have drifted. Update src/tools/document-tools.ts.`
        );
      }

      return {
        width: args.width as number,
        height: args.height as number,
        resolution: args.resolution as number,
        colorMode: mappedMode,
      };
    },
    successText: (_result, args) =>
      `Document created: ${args.width as number}x${args.height as number}px at ${args.resolution as number}dpi (${args.color_mode as string})`,
  });
}

/** Forward only the selector keys the caller actually supplied. An explicit
 *  `undefined` would still be a present key on the Go side, which flips
 *  closeDocument from "close the active document" to "resolve a target". */
function documentTargetArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof args.name === 'string' && args.name !== '') out.name = args.name;
  if (typeof args.id === 'number') out.id = args.id;
  return out;
}

interface DocumentListing {
  index: number;
  id: number;
  name: string;
  path: string | null;
  saved: boolean | null;
  active: boolean;
  width_px: number | null;
  height_px: number | null;
}

async function documentOp(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(documentSchema, rawArgs);
    const op = args.op as (typeof DOCUMENT_OPS)[number];
    const target = documentTargetArgs(args);

    if (op === 'activate') {
      if (Object.keys(target).length === 0) {
        return toolErrorResult(
          'Error activating document',
          new Error('op=activate needs a name or an id. Call op=list to see what is open.')
        );
      }
      const script = await snippetClient.build('activateDocument', target);
      const result = (await runScript(connection, script)) as {
        id: number;
        name: string;
        context?: Record<string, unknown>;
      };
      return {
        content: [{ type: 'text' as const, text: `Activated "${result.name}" (id ${result.id}).` }],
        structuredContent: {
          op,
          activated: true,
          id: result.id,
          name: result.name,
          context: result.context,
        },
      };
    }

    const script = await snippetClient.build('listDocuments', {});
    const result = (await runScript(connection, script)) as {
      count: number;
      documents: DocumentListing[];
      context?: Record<string, unknown>;
    };
    const docs = result.documents ?? [];
    // The empty case is a real answer, not an error: "nothing is open" is what
    // the caller came here to find out after a "No document is open" failure.
    const summary = docs.length
      ? `${docs.length} open document(s): ${docs
          .map(
            (d) =>
              `${d.name} (id ${d.id}${d.active ? ', ACTIVE' : ''}${d.saved === false ? ', unsaved changes' : ''})`
          )
          .join('; ')}.`
      : 'No documents are open in Photoshop. Open one with ps_open_document, or create one with ps_create_document.';

    return {
      content: [{ type: 'text' as const, text: summary }],
      structuredContent: {
        op,
        count: docs.length,
        documents: docs,
        context: result.context,
      },
    };
  } catch (error) {
    return toolErrorResult('Error reading documents', error);
  }
}

async function closeDocument(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(closeDocumentSchema, rawArgs);
    const save = args.save as boolean;

    const script = await snippetClient.build('closeDocument', {
      save,
      ...documentTargetArgs(args),
    });
    const result = (await runScript(connection, script)) as {
      closed: boolean;
      closedName?: string;
      context?: Record<string, unknown>;
    };

    return {
      content: [
        {
          type: 'text' as const,
          text: save ? 'Document closed and saved' : 'Document closed without saving',
        },
      ],
      structuredContent: {
        closed: true,
        saved: save,
        closedName: result.closedName,
        context: result.context,
      },
    };
  } catch (error) {
    return toolErrorResult('Error closing document', error);
  }
}

/** Matches run-child.ts's timeout rejection (both the richer per-exec message
 * and the queue watchdog's plain "Script execution timeout" fallback) — the
 * only path 3b's re-probe is allowed to fire on. Deliberately does NOT match
 * on "modal" — see the ERROR_CLASS_TABLE ordering note in session-log.ts for
 * the matching classifier decision.
 *
 * Also matches macOS's AppleEvent timeout
 * ("AppleEvent timed out (-1712)" / bare "-1712"). AppleScript's own Apple
 * Event timeout (default 120s, now explicitly set to match the caller's
 * budget — see macos-runner.ts's buildAppleScriptWrapper) is a distinct
 * failure class from run-child.ts's own kill-timeout, but it means the same
 * thing for this re-probe's purposes: Photoshop kept running past the
 * caller's wrapper giving up, so the post-timeout success re-probe should
 * fire on it too. */
function isScriptTimeoutError(message: string): boolean {
  // The -1712 alternative is bounded on both sides. Bare `-1712` matched
  // anywhere in the message, including inside an echoed file path — a
  // "could not open" error naming E:/photos/IMG-1712.dng would classify as
  // a timeout, fire the re-probe, and (if that file happened to be open
  // already) report "confirmed it actually completed" for an open that
  // never ran. Exactly the false-success class this release exists to kill.
  return /Script execution timeout|AppleEvent timed out|(?:^|[\s(])-1712(?:[\s)]|$)/i.test(message);
}

/**
 * Phase 3b — post-timeout success re-probe. Fires ONLY when
 * openDocumentPipeline's own runScript() rejected with a timeout: the
 * cscript/osascript child was killed, but Photoshop is a SEPARATE process
 * that keeps executing the JSX it already received — a large RAW file's
 * first Camera Raw engine init routinely exceeds the wrapper's budget while
 * the open itself still completes (state is left clean either way — the
 * wrapper's `finally` restores units/dialogs, and the script queue is
 * strictly serialized, so a post-timeout re-probe is safe). Runs a short,
 * separately-bounded probe that walks app.documents (never trusting
 * app.activeDocument — the just-opened doc is often not the active one) and
 * matches on fullName.fsName (never d.name, which would false-succeed
 * against an unrelated same-named already-open file).
 *
 * Returns the probe's success payload (shaped like a normal open response)
 * when the file is found open, or null when the probe itself times out /
 * errors, or completes but doesn't find the file — a genuine failure, so the
 * caller falls back to the original timeout error rather than a false
 * positive.
 */
async function reprobeOpenDocument(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  filePath: string
): Promise<Record<string, unknown> | null> {
  try {
    const probeScript = await snippetClient.build('probeOpenDocument', { filePath });
    const result = (await runScript(connection, probeScript, OPEN_DOCUMENT_REPROBE_TIMEOUT_MS)) as {
      success?: boolean;
    } & Record<string, unknown>;
    return result.success ? result : null;
  } catch {
    return null;
  }
}

async function openDocumentPipeline(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  // Hoisted out of the try so the catch block can reach it for the re-probe.
  // Stays undefined if validateArgs throws, which correctly keeps the
  // re-probe from firing on a validation error.
  let filePath: string | undefined;
  try {
    const args = validateArgs(openDocumentSchema, rawArgs);
    filePath = args.file_path as string;
    const suppressDialogs = args.suppress_dialogs as boolean;

    const script = await snippetClient.build('openDocumentPipeline', { filePath, suppressDialogs });
    const result = await runScript(connection, script, OPEN_DOCUMENT_TIMEOUT_MS);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Document opened:\n${JSON.stringify(result, null, 2)}`,
        },
      ],
      structuredContent: result as Record<string, unknown>,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (filePath !== undefined && isScriptTimeoutError(message)) {
      const reprobed = await reprobeOpenDocument(connection, snippetClient, filePath);
      if (reprobed) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `Document opened (the open exceeded the ${OPEN_DOCUMENT_TIMEOUT_MS}ms budget and was ` +
                `reported as a timeout, but a post-timeout check confirmed it actually completed):\n` +
                JSON.stringify(reprobed, null, 2),
            },
          ],
          structuredContent: reprobed,
        };
      }
    }

    return toolErrorResult('Error opening document', error);
  }
}

async function savePsdPipeline(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  // Validate BEFORE the purge, and read the OPT-OUT off the validated result.
  //
  // Ordering: the purge is a real, user-visible mutation of the OPEN document
  // (it deletes channels), so running it ahead of validation destroyed derived
  // state on behalf of a save that was then rejected for a malformed
  // output_path. Note this only orders schema-level rejection — a well-formed
  // path that fails later (unmounted drive, read-only target, a PS-side throw)
  // still fails after the purge.
  //
  // Validated args: `keep_scene_channels` must be read from validateArgs' OUTPUT,
  // not from rawArgs. The validator deliberately coerces stringified booleans
  // (LLM clients send `"true"`), so a raw-bag `!== true` check let
  // keep_scene_channels:"true" validate cleanly and then purge anyway — silently
  // destroying the very channels the caller asked to keep, and reporting
  // scene_channels_purged as though it were intended.
  //
  // runSnippetTool re-validates below; validateArgs is pure, so paying for it
  // twice costs nothing and keeps the "reject before you mutate" order explicit.
  let args: Record<string, unknown>;
  try {
    args = validateArgs(savePsdSchema, rawArgs);
  } catch (error) {
    return toolErrorResult('Error saving PSD', error);
  }

  // Drop the derived scene:* masks BEFORE writing unless asked to keep them.
  // They are full-resolution alpha channels (~51MB each on a 51MP document) that
  // the next ps_read_scene rebuilds, so baking them into the .psd is pure bloat.
  // Best-effort: a purge failure must never block the save the user asked for.
  let purged = 0;
  if (args.keep_scene_channels !== true) {
    try {
      purged = await purgeSceneChannels(connection);
    } catch (err) {
      logger.debug(
        `save_psd: scene-channel purge failed, saving anyway — ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const res = await runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: savePsdSchema,
    snippet: 'savePsdAsCopy',
    errorPrefix: 'Error saving PSD',
    params: (args) => ({
      outputPath: args.output_path as string,
      maximizeCompat: args.maximize_compatibility as boolean,
    }),
    successText: (result) => `PSD saved:\n${JSON.stringify(result, null, 2)}`,
  });

  // Report the purge rather than doing it silently — the channels are gone from
  // the OPEN document too, so the next select_by_reference re-derives.
  // runSnippetTool passes the snippet's raw return through as structuredContent,
  // which is a STRING whenever the script returned a non-JSON value; assigning a
  // property to a string primitive throws in strict mode, so only annotate a
  // real object.
  if (!res.isError && typeof res.structuredContent === 'object' && res.structuredContent !== null) {
    res.structuredContent.scene_channels_purged = purged;
  }
  return res;
}

async function exportJpegPipeline(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(exportJpegSchema, rawArgs);
    const outputPath = args.output_path as string;
    // Public scale is 0-100 (the JPEG dialog humans + the LLM know); Photoshop's
    // JPEGSaveOptions scripting scale is 0-12. Normalize here so the Go core
    // snippet keeps its 0-12 contract unchanged. 90→11, 100→12, 50→6, 0→0.
    const qualityPct = args.quality as number;
    const quality = Math.round((qualityPct / 100) * 12);
    const longEdgePx = args.long_edge_px as number | undefined;
    const embedProfile = args.embed_color_profile as boolean;
    const convertSrgb = args.convert_to_srgb as boolean;

    const params: Record<string, unknown> = { outputPath, quality, embedProfile, convertSrgb };
    if (longEdgePx !== undefined) params.longEdgePx = longEdgePx;
    const script = await snippetClient.build('exportJpegPipeline', params);
    const result = (await runScript(connection, script)) as Record<string, unknown>;

    // Echo the 0-100 value the caller passed (consistent with the input scale);
    // expose the 0-12 value actually sent to Photoshop as quality_ps_scale so
    // both scales are legible and the caller never sees a silent 90→11 swap.
    const structured = { ...result, quality: qualityPct, quality_ps_scale: quality };

    return {
      content: [
        {
          type: 'text' as const,
          text: `JPEG exported:\n${JSON.stringify(structured, null, 2)}`,
        },
      ],
      structuredContent: structured,
    };
  } catch (error) {
    return toolErrorResult('Error exporting JPEG', error);
  }
}

async function exportPngPipeline(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  return runSnippetTool({
    connection,
    snippetClient,
    rawArgs,
    schema: exportPngSchema,
    snippet: 'exportPngPipeline',
    errorPrefix: 'Error exporting PNG',
    params: (args) => {
      const longEdgePx = args.long_edge_px as number | undefined;
      const params: Record<string, unknown> = {
        outputPath: args.output_path as string,
        transparentBg: args.transparent_background as boolean,
        compression: args.compression as number,
      };
      if (longEdgePx !== undefined) params.longEdgePx = longEdgePx;
      return params;
    },
    successText: (result) => `PNG exported:\n${JSON.stringify(result, null, 2)}`,
  });
}
