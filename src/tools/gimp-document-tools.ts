import { existsSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import type { GimpBackend } from '../backends/gimp/backend.js';
import { validateArgs, type JsonSchemaObject } from '../utils/validate.js';
import {
  toolGimpErrorResult,
  requireAbsoluteGimpPath,
  refuseExistingGimpFile,
} from '../utils/tool-helpers.js';
import { GimpError } from '../backends/gimp/errors.js';
import { GIMP_IMAGE_PROP, runGimpTool } from './gimp-shared.js';

/**
 * gimp_open_document / gimp_close_document / gimp_save_xcf / gimp_export.
 *
 * Every path here is validated in the TOOL layer (the bridge trusts what
 * it's given, `bridge/ops.py`'s file header): `file_path` must be absolute,
 * writes refuse to overwrite unless `overwrite: true`, `gimp_export` refuses
 * `.xcf` (that's `gimp_save_xcf`'s job) and `gimp_save_xcf` requires it.
 *
 * `gimp_save_xcf` and `gimp_export` both dispatch the SAME bridge op
 * (`export` — `ops.py`'s `op_export` branches on the path's own extension);
 * the two tools differ only in which extension each validates for and which
 * format-specific options each accepts.
 */

interface OpenResult {
  image: number;
  width: number;
  height: number;
  base_type: string;
  precision: string;
  layers: string[];
}

const openSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    file_path: {
      type: 'string',
      description:
        'Absolute path to a JPEG/PNG/TIFF/WebP/XCF file. Raw camera files (DNG, CR2, CR3, NEF, ' +
        'ARW, ...) are refused with a hint to develop them externally (darktable, RawTherapee, or ' +
        'ART) first, then open the resulting JPEG/TIFF here — GIMP core has no raw loader.',
    },
    precision: {
      type: 'string',
      enum: ['keep', '16', '32'],
      default: 'keep',
      description:
        "Promote bit depth on open. 'keep' leaves the file's own precision; '16' or '32' converts " +
        'to that bit depth BEFORE any grading — do this ahead of an aggressive exposure/levels/' +
        'curves move on an 8-bit source to avoid visible banding in smooth gradients.',
    },
  },
  required: ['file_path'],
};

async function gimpOpenDocument(
  gimp: GimpBackend,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(openSchema, rawArgs);
    const filePath = requireAbsoluteGimpPath('file_path', args.file_path);
    const result = await gimp.call<OpenResult>('open', {
      path: filePath,
      precision: args.precision,
    });
    return {
      content: [
        {
          type: 'text' as const,
          text:
            `Opened ${basename(filePath)} as image ${result.image} ` +
            `(${result.width}x${result.height}, ${result.base_type}, ${result.precision}). ` +
            `${result.layers.length} layer(s): ${result.layers.join(', ') || '(none)'}.`,
        },
      ],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  } catch (error) {
    return toolGimpErrorResult('Error opening GIMP document', error);
  }
}

const closeSchema: JsonSchemaObject = {
  type: 'object',
  properties: { image: GIMP_IMAGE_PROP },
  required: ['image'],
};

const saveXcfSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    image: GIMP_IMAGE_PROP,
    file_path: {
      type: 'string',
      description:
        'Absolute path ending in .xcf. Saves the LIVE GIMP document — every filter stays in ' +
        "place and re-editable afterward (matches ps_save_psd's framing for .psd). For a " +
        'flattened deliverable, use gimp_export instead.',
    },
    overwrite: {
      type: 'boolean',
      default: false,
      description: 'Refuses to overwrite an existing file unless true.',
    },
  },
  required: ['image', 'file_path'],
};

async function gimpSaveXcf(
  gimp: GimpBackend,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(saveXcfSchema, rawArgs);
    const filePath = requireAbsoluteGimpPath('file_path', args.file_path);
    if (extname(filePath).toLowerCase() !== '.xcf') {
      throw new GimpError(
        'invalid_argument',
        `"file_path" must end in .xcf, got "${filePath}" — use gimp_export for a flattened deliverable.`
      );
    }
    refuseExistingGimpFile(filePath, args.overwrite as boolean | undefined, existsSync);
    const result = await gimp.call<{ path: string; bytes: number }>('export', {
      image: args.image,
      path: filePath,
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: `Saved ${result.bytes.toLocaleString()} bytes to ${result.path} — filters stay live and re-editable.`,
        },
      ],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  } catch (error) {
    return toolGimpErrorResult('Error saving GIMP document', error);
  }
}

const EXPORT_FORMAT_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff'] as const;

const exportSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    image: GIMP_IMAGE_PROP,
    file_path: {
      type: 'string',
      description:
        'Absolute path. The extension picks the format: jpg/jpeg, png, webp, tif/tiff. Refuses ' +
        ".xcf outright — that is gimp_save_xcf's job. Metadata (EXIF/XMP/IPTC/GPS, thumbnail) is " +
        'ALWAYS stripped on export, unconditionally — never carried over from the source.',
    },
    overwrite: {
      type: 'boolean',
      default: false,
      description: 'Refuses to overwrite an existing file unless true.',
    },
    quality: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      default: 90,
      description:
        'JPEG/WebP quality, 1-100 (higher = better/larger). Ignored for png/tiff. WebP itself ' +
        "accepts 0 too, but JPEG's own bound is 1-100, so this schema uses the tighter bound.",
    },
    png_compression: {
      type: 'integer',
      minimum: 0,
      maximum: 9,
      default: 3,
      description:
        "PNG only: compression level, 0 (fastest, largest) to 9 (slowest, smallest). GIMP's own " +
        'default of 9 measured far slower for negligible size gain on a typical photo, hence the ' +
        'lower default here. Ignored for other formats.',
    },
    tiff_compression: {
      type: 'string',
      enum: ['none', 'lzw', 'packbits', 'jpeg', 'ccittfax3', 'ccittfax4', 'adobe_deflate'],
      default: 'none',
      description:
        'TIFF only: compression scheme. ccittfax3/ccittfax4 are bilevel-only schemes — do not use ' +
        'them on an RGB photo (they produce a degenerate, unreadable file). Ignored for other formats.',
    },
    lossless: {
      type: 'boolean',
      default: false,
      description: 'WebP only: lossless encoding. Ignored for other formats.',
    },
    bit_depth: {
      type: 'integer',
      enum: [8, 16],
      default: 8,
      description: 'PNG/TIFF only: output bit depth. JPEG/WebP are always 8-bit.',
    },
  },
  required: ['image', 'file_path'],
};

async function gimpExport(
  gimp: GimpBackend,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(exportSchema, rawArgs);
    const filePath = requireAbsoluteGimpPath('file_path', args.file_path);
    const ext = extname(filePath).toLowerCase();
    if (ext === '.xcf') {
      throw new GimpError(
        'invalid_argument',
        '"file_path" must not be a .xcf file — gimp_export writes a flattened deliverable; use ' +
          'gimp_save_xcf to save the live, re-editable document.'
      );
    }
    refuseExistingGimpFile(filePath, args.overwrite as boolean | undefined, existsSync);

    // Only the option(s) relevant to the resolved format are forwarded — the
    // bridge reads a single `compression` key whose MEANING (a 0-9 int for
    // png, a string enum for tiff) depends on the format it's exporting,
    // so the two tool-level fields (png_compression / tiff_compression)
    // are never sent together.
    const bridgeArgs: Record<string, unknown> = { image: args.image, path: filePath };
    if (ext === '.jpg' || ext === '.jpeg') {
      bridgeArgs.quality = args.quality;
    } else if (ext === '.png') {
      bridgeArgs.compression = args.png_compression;
      bridgeArgs.bit_depth = args.bit_depth;
    } else if (ext === '.webp') {
      bridgeArgs.quality = args.quality;
      bridgeArgs.lossless = args.lossless;
    } else if (ext === '.tif' || ext === '.tiff') {
      bridgeArgs.compression = args.tiff_compression;
      bridgeArgs.bit_depth = args.bit_depth;
    } else {
      // An extension outside the allow-list — the bridge refuses it with
      // its own message naming the allow-list (bridge/lib.py's
      // EXPORT_FORMATS); no need to duplicate that list's enforcement here.
    }

    const result = await gimp.call<{ path: string; bytes: number }>('export', bridgeArgs);
    const format = EXPORT_FORMAT_EXTENSIONS.includes(
      ext as (typeof EXPORT_FORMAT_EXTENSIONS)[number]
    )
      ? ext.replace('.', '')
      : null;
    return {
      content: [
        {
          type: 'text' as const,
          text:
            `Exported ${result.bytes.toLocaleString()} bytes to ${result.path}. ` +
            'Metadata (EXIF/XMP/IPTC/GPS, thumbnail) was stripped.',
        },
      ],
      structuredContent: { path: result.path, bytes: result.bytes, format },
    };
  } catch (error) {
    return toolGimpErrorResult('Error exporting GIMP document', error);
  }
}

export function createGimpDocumentTools(gimp: GimpBackend): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'gimp_open_document',
        description:
          'Open a JPEG/PNG/TIFF/WebP/XCF file in the headless GIMP session and return its image ' +
          'id — the id every other gimp_* tool keys on (there is no "active document" concept: ' +
          'explicit ids beat hidden state). Opening a .xcf restores its live, re-editable filters ' +
          '(the editmamei-filters ledger). Raw camera files are refused; develop them externally ' +
          'first. `precision` promotes bit depth before grading — use it ahead of an aggressive ' +
          'tone move on an 8-bit source.',
        inputSchema: openSchema,
        outputSchema: {
          type: 'object',
          properties: {
            image: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' },
            base_type: { type: 'string' },
            precision: { type: 'string' },
            layers: { type: 'array', items: { type: 'string' } },
          },
        },
        annotations: {
          title: 'Open GIMP Document',
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      handler: async (args) => gimpOpenDocument(gimp, args),
    },
    {
      tool: {
        name: 'gimp_close_document',
        description:
          'Close an image WITHOUT saving. Save first with gimp_save_xcf (keeps filters live) or ' +
          'gimp_export (flattened deliverable) if the work should be kept.',
        inputSchema: closeSchema,
        outputSchema: { type: 'object', properties: { closed: { type: 'number' } } },
        annotations: {
          title: 'Close GIMP Document',
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      handler: async (args) =>
        runGimpTool({
          gimp,
          rawArgs: args,
          schema: closeSchema,
          op: 'close',
          errorPrefix: 'Error closing GIMP document',
          successText: (result) => `Closed image ${(result as { closed: number }).closed}.`,
        }),
    },
    {
      tool: {
        name: 'gimp_save_xcf',
        description:
          'Save the live GIMP document to a .xcf file — filters stay in place and re-editable ' +
          'afterward (the ".xcf ≈ .psd" framing: it is the working file, not the deliverable). ' +
          "Unlike gimp_export, this does NOT strip metadata — the source file's EXIF/XMP/IPTC " +
          '(including GPS) carries into the .xcf exactly as it was on open, since this saves the ' +
          'working document itself rather than exporting a flattened copy. Refuses to overwrite an ' +
          'existing file unless overwrite: true. For a flattened, shippable copy with metadata ' +
          'stripped, use gimp_export instead.',
        inputSchema: saveXcfSchema,
        outputSchema: {
          type: 'object',
          properties: { path: { type: 'string' }, bytes: { type: 'number' } },
        },
        annotations: {
          title: 'Save GIMP Document (.xcf)',
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      handler: async (args) => gimpSaveXcf(gimp, args),
    },
    {
      tool: {
        name: 'gimp_export',
        description:
          'Write a FLATTENED deliverable to disk — every live filter is baked in, and ALL metadata ' +
          '(EXIF/XMP/IPTC/GPS, thumbnail) is stripped unconditionally, never carried over from the ' +
          'source. Format is picked from the file_path extension (jpg/jpeg, png, webp, tif/tiff); ' +
          '.xcf is refused outright — use gimp_save_xcf for the live, re-editable document instead. ' +
          'Refuses to overwrite an existing file unless overwrite: true.',
        inputSchema: exportSchema,
        outputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            bytes: { type: 'number' },
            format: { type: ['string', 'null'] },
          },
        },
        annotations: {
          title: 'Export GIMP Document',
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      handler: async (args) => gimpExport(gimp, args),
    },
  ];
}

/** Exported for the export-options schema-bounds drift test — see tests/tools/gimp-document-tools.test.ts. */
export const EXPORT_SCHEMA_FOR_TESTS = exportSchema;
export { EXPORT_FORMAT_EXTENSIONS };
